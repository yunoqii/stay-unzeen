/**
 * Devnet check of the execution lanes (R-relayer-1..3) through the PRODUCTION
 * wiring (buildRelayer + PostgresJobQueue + runLanes + background fee cache)
 * against a throw-away Postgres schema:
 *
 *   - a 'delayed' buy whose not_before is the next epoch boundary (now + 20 s),
 *   - a 'now' buy of the same mint and amount inserted right after it;
 *   - the now lane must execute the 'now' job before the epoch, the batch
 *     lane the 'delayed' one after it;
 *   - both landed transactions are fetched and their compute budget
 *     instructions and instruction layout compared.
 *
 *   pnpm relayer:lanes:devnet [--mint <pump.fun devnet mint>] [--keep]
 *
 * Mint: --mint, else the first pinned mint of mint-vaults.json (a curve that
 * is still live on devnet). Needs DATABASE_URL (owner: creates the schema).
 * Dev tool: prints signatures (public data); there are no users.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ComputeBudgetInstruction, ComputeBudgetProgram, LAMPORTS_PER_SOL, type TransactionInstruction } from "@solana/web3.js";
import pg from "pg";
import { AdapterError } from "../src/errors";
import { loadRepoEnv, redactSecrets } from "../src/env";
import { describeConfig, explorerTxUrl, loadConfig, makeConnection } from "../src/config";
import { formatUnits } from "../src/math";
import { fetchTx } from "../src/tx";
import { FileMintVaults, buildRelayer, makePools, openKeys, relayerNetwork } from "../src/relayer";

const SOL = BigInt(LAMPORTS_PER_SOL);
const BUY = SOL / 500n; // 0.002 SOL each
const EPOCH_MS = 20_000;

loadRepoEnv();
const cfg = loadConfig();
if (cfg.cluster !== "devnet") {
  console.error(`refusing to run on ${cfg.cluster}: devnet only`);
  process.exit(1);
}
const network = relayerNetwork(cfg);
const conn = makeConnection(cfg);
const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

interface Layout {
  budget: string[];
  programs: string[];
  /** program:accountCount:dataLength per instruction (amounts identical here, so data too). */
  shape: string[];
}

async function layout(sig: string): Promise<Layout> {
  const tx = await fetchTx(conn, sig, 20);
  if (!tx) throw new Error(`cannot fetch ${sig}`);
  const msg = tx.transaction.message;
  const keys = msg.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? null });
  const budget: string[] = [];
  const programs: string[] = [];
  const shape: string[] = [];
  for (const c of msg.compiledInstructions) {
    const programId = keys.get(c.programIdIndex)!;
    programs.push(programId.toBase58());
    shape.push(`${programId.toBase58().slice(0, 6)}:${c.accountKeyIndexes.length}:${c.data.length}`);
    if (programId.equals(ComputeBudgetProgram.programId)) {
      const ix = { programId, keys: [], data: Buffer.from(c.data) } as unknown as TransactionInstruction;
      const t = ComputeBudgetInstruction.decodeInstructionType(ix);
      if (t === "SetComputeUnitLimit") budget.push(`SetComputeUnitLimit(${ComputeBudgetInstruction.decodeSetComputeUnitLimit(ix).units})`);
      else if (t === "SetComputeUnitPrice") budget.push(`SetComputeUnitPrice(${ComputeBudgetInstruction.decodeSetComputeUnitPrice(ix).microLamports} µlamports)`);
      else budget.push(t);
    }
  }
  return { budget, programs, shape };
}

async function main(): Promise<void> {
  console.log(describeConfig(cfg));
  const owner = process.env.DATABASE_URL?.trim();
  if (!owner) throw new Error("DATABASE_URL is required (temp schema)");
  const keys = await openKeys(cfg, process.env, (m) => console.log(`  WARN ${m}`));
  const pinsFile = path.join(cfg.keysDir, "mint-vaults.json");
  const mint =
    arg("--mint") ?? Object.keys(fs.existsSync(pinsFile) ? (JSON.parse(fs.readFileSync(pinsFile, "utf8")) as Record<string, string>) : {})[0];
  if (!mint) throw new Error("no mint: pass --mint <pump.fun devnet mint>");

  const schema = `relayer_lanes_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: owner, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  for (const t of ["relayer_jobs", "tokens", "trades"]) {
    await admin.query(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
  }
  for (const t of ["relayer_jobs", "trades"]) {
    await admin.query(`CREATE SEQUENCE ${schema}.${t}_seq`);
    await admin.query(`ALTER TABLE ${schema}.${t} ALTER COLUMN id SET DEFAULT nextval('${schema}.${t}_seq')`);
  }
  const { db, lockDb } = makePools(owner, keys.vaults.length, schema);
  const ac = new AbortController();
  const keep = process.argv.includes("--keep");
  let lanes: Promise<void> | null = null;

  try {
    const rt = buildRelayer({
      cfg,
      connection: conn,
      network,
      keys,
      db,
      lockDb,
      warn: (m) => console.log(`  WARN ${m}`),
      metadata: null,
      mintVaults: new FileMintVaults(pinsFile),
      onEvent: (e) => console.log(`  [relayer] ${e.event} ${e.kind}${e.code ? ` ${e.code}` : ""}`),
    });
    await rt.fees.refresh();
    rt.fees.start();
    console.log(`  fee source ${cfg.priorityFeeSource}: pool-wide price ${rt.fees.microLamports()} µlamports/CU (refreshes ok=${rt.fees.refreshes} fail=${rt.fees.failures})`);

    const q = await rt.adapter.quote(mint, "buy", BUY);
    const minOut = ((q.amountOut * 90n) / 100n).toString();
    console.log(`\nmint ${mint}; two buys of ${formatUnits(BUY, 9)} SOL, min_out ${minOut}`);

    const insert = async (cols: Record<string, unknown>): Promise<string> => {
      const k = Object.keys(cols);
      const r = await db.query<{ id: string }>(
        `INSERT INTO relayer_jobs (${k.join(", ")}, network) VALUES (${k.map((_, i) => `$${i + 1}`).join(", ")}, 'devnet') RETURNING id`,
        Object.values(cols),
      );
      return r.rows[0]!.id;
    };
    const job = async (id: string) =>
      (await db.query(`SELECT status, signature, vault, error_code, error_message FROM relayer_jobs WHERE id = $1`, [id])).rows[0] as Record<string, string | null>;

    const t0 = Date.now();
    const epoch = new Date(t0 + EPOCH_MS);
    const base = { op: "buy", venue: "pumpfun", mint, lamports_in: BUY.toString(), min_out: minOut };
    const delayedId = await insert({ ...base, exec_mode: "delayed", not_before: epoch }); // inserted FIRST
    const nowId = await insert({ ...base, exec_mode: "now" });
    console.log(`  inserted delayed (epoch at +${EPOCH_MS / 1000} s), then now`);

    lanes = rt.relayer.runLanes(ac.signal, { nowMs: 300, batchMs: 1_000 }, (e) =>
      console.log(`  loop error: ${redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 200)}`),
    );

    const done: Record<string, number> = {};
    for (;;) {
      for (const [name, id] of [["now", nowId], ["delayed", delayedId]] as const) {
        const r = await job(id);
        if (r.status === "failed") throw new Error(`${name} job failed: ${r.error_code} (${r.error_message})`);
        if (r.status === "confirmed" && done[name] === undefined) {
          done[name] = Date.now() - t0;
          console.log(`  ${name} confirmed at +${(done[name]! / 1000).toFixed(1)} s`);
        }
      }
      if (done.now !== undefined && done.delayed !== undefined) break;
      if (Date.now() - t0 > 180_000) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!(done.now! < EPOCH_MS)) throw new Error("now job waited for the epoch");
    if (!(done.delayed! >= EPOCH_MS)) throw new Error("delayed job ran before its epoch");

    const nowRow = await job(nowId);
    const delRow = await job(delayedId);
    const [a, b] = await Promise.all([layout(nowRow.signature!), layout(delRow.signature!)]);
    console.log(`\nnow      ${explorerTxUrl(nowRow.signature!, cfg.cluster)}`);
    console.log(`  budget   ${a.budget.join(", ")}`);
    console.log(`  layout   ${a.shape.join(" | ")}`);
    console.log(`delayed  ${explorerTxUrl(delRow.signature!, cfg.cluster)}`);
    console.log(`  budget   ${b.budget.join(", ")}`);
    console.log(`  layout   ${b.shape.join(" | ")}`);
    const same = JSON.stringify(a) === JSON.stringify(b);
    console.log(`\ncompute budget identical: ${JSON.stringify(a.budget) === JSON.stringify(b.budget)}; instruction layout identical: ${same}; same vault: ${nowRow.vault === delRow.vault}`);
    if (!same) process.exitCode = 3;
  } finally {
    ac.abort();
    await lanes?.catch(() => undefined);
    await db.end();
    await lockDb.end();
    if (!keep) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    else console.log(`  kept schema ${schema}`);
    await admin.end();
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    if (e instanceof AdapterError) console.error(`AdapterError ${e.code} (API ${e.apiCode}): ${redactSecrets(e.message)}`);
    else console.error(redactSecrets(e instanceof Error ? (e.stack ?? e.message) : String(e)));
    process.exit(1);
  });
