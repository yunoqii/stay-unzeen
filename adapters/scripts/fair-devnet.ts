/**
 * RELAYER v3 on Solana devnet through the PRODUCTION wiring (buildRelayer,
 * PostgresJobQueue), against a throw-away Postgres schema with core's exact
 * 0008 DDL for the relayer-visible parts (relayer_jobs v3 columns,
 * launch_curves). Core's real queue / settler / fl_* tables are never touched.
 *
 *   pnpm fair:devnet [--lamports 50000000] [--keep]
 *
 * 1. launch_curves from the pump Global (as the relayer does at start / every 10 min)
 * 2. fair_create: mint keypair generated here as core does (mint_secret), one
 *    atomic v0 create + buy; checks out_mint = pubkey of mint_secret, pin, feed
 * 3. attest (meta.purpose = "fair"): SPL Memo with a 64-hex root from the
 *    FAIR-LAUNCH attestation key (F14, not the public Verify key); out_memo read
 *    back from the confirmed tx (skipped when the key is not funded: it is never
 *    topped up from a vault)
 *
 * Needs DATABASE_URL (owner role: creates the temp schema). Devnet only.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NATIVE_MINT } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { OnlinePumpSdk, getBuyTokenAmountFromSolAmount } from "@pump-fun/pump-sdk";
import pg from "pg";
import { describeConfig, explorerAddressUrl, explorerTxUrl, loadConfig, makeConnection } from "../src/config";
import { loadRepoEnv, redactSecrets } from "../src/env";
import { toBN, toBig } from "../src/math";
import { LocalMetadataStore } from "../src/metadata";
import { verifyDetached } from "../src/ed25519";
import { FileMintVaults, buildRelayer, defaultMediaDir, makePools, openKeys, relayerNetwork } from "../src/relayer";

loadRepoEnv();
const cfg = loadConfig();
if (cfg.cluster !== "devnet") {
  console.error(`refusing to run on ${cfg.cluster}: devnet only`);
  process.exit(1);
}
const network = relayerNetwork(cfg);
const conn = makeConnection(cfg);
const txUrl = (s: string) => explorerTxUrl(s, cfg.cluster);
const warn = (m: string) => console.log(`  WARN ${m}`);
const argOf = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const LAMPORTS = BigInt(argOf("--lamports") ?? 50_000_000); // 0.05 SOL: a launch-sized buy for devnet

function ddl0008(): { jobs: string; curves: string } {
  const ddl = fs.readFileSync(path.resolve(__dirname, "../../core/migrations/0008_fair_launch.sql"), "utf8");
  const cut = (from: string, to: string) => {
    const a = ddl.indexOf(from);
    const b = ddl.indexOf(to, a);
    if (a < 0 || b < 0) throw new Error(`0008 layout changed near "${from}"`);
    return ddl.slice(a, ddl.lastIndexOf("\n", b));
  };
  return {
    jobs: cut("ALTER TABLE relayer_jobs DROP CONSTRAINT", "launch curve of the network").replace(/ALTER TABLE relayer_jobs DROP CONSTRAINT relayer_jobs_op_check;/, ""),
    curves: cut("CREATE TABLE launch_curves", "launches (core only)"),
  };
}

async function main(): Promise<void> {
  console.log(`${describeConfig(cfg)} fair-launch relayer e2e`);
  const owner = process.env.DATABASE_URL?.trim();
  if (!owner) throw new Error("DATABASE_URL is required (temp schema)");
  const keys = await openKeys(cfg, process.env, warn);

  const schema = `relayer_fair_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: owner, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  for (const t of ["relayer_jobs", "tokens", "trades"]) {
    await admin.query(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
  }
  for (const t of ["relayer_jobs", "trades"]) {
    await admin.query(`CREATE SEQUENCE ${schema}.${t}_seq`);
    await admin.query(`ALTER TABLE ${schema}.${t} ALTER COLUMN id SET DEFAULT nextval('${schema}.${t}_seq')`);
  }
  const { jobs, curves } = ddl0008();
  const c = await admin.connect();
  try {
    await c.query(`SET search_path = ${schema}`);
    // public.relayer_jobs already at 0008+ (core applied it): LIKE copied the v3+ columns and op check.
    const has = await c.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'relayer_jobs' AND column_name = 'mint_secret'`);
    if (has.rowCount === 0) {
      await c.query(`ALTER TABLE relayer_jobs DROP CONSTRAINT IF EXISTS relayer_jobs_op_check`);
      await c.query(jobs);
    }
    await c.query(curves);
  } finally {
    c.release();
  }
  const { db, lockDb } = makePools(owner, keys.vaults.length, schema);
  const keep = process.argv.includes("--keep");
  try {
    const rt = buildRelayer({
      cfg,
      connection: conn,
      network,
      keys,
      db,
      lockDb,
      warn,
      metadata: new LocalMetadataStore(process.env.UNZEEN_METADATA_DIR?.trim() || defaultMediaDir(cfg), process.env.UNZEEN_METADATA_BASE_URL?.trim() || "http://127.0.0.1:8787/media"),
      mintVaults: new FileMintVaults(path.join(cfg.keysDir, "mint-vaults.json")),
      onEvent: (e) => console.log(`  [relayer] ${e.event} ${e.kind}${e.code ? ` ${e.code}` : ""}`),
    });
    await rt.fees.refresh();
    const insert = async (cols: Record<string, unknown>): Promise<string> => {
      const k = Object.keys(cols);
      const r = await db.query<{ id: string }>(
        `INSERT INTO relayer_jobs (${k.join(", ")}, network, exec_mode) VALUES (${k.map((_, i) => `$${i + 1}`).join(", ")}, 'devnet', 'now') RETURNING id`,
        Object.values(cols),
      );
      return r.rows[0]!.id;
    };
    const row = async (id: string) =>
      (await db.query(`SELECT status, signature, vault, slot, out_mint, out_token_amount, out_lamports, out_memo, error_code, error_message FROM relayer_jobs WHERE id = $1`, [id]))
        .rows[0] as Record<string, string | null>;
    const runUntil = async (id: string) => {
      for (let i = 0; i < 120; i++) {
        const r = await row(id);
        if (r.status === "failed") throw new Error(`job failed: ${r.error_code} (${r.error_message})`);
        if (r.status === "confirmed") return r;
        if (!(await rt.relayer.tick("now"))) await new Promise((res) => setTimeout(res, 1_000));
      }
      throw new Error("job did not finish");
    };

    // ---- [1] launch_curves
    console.log("\n[1] launch_curves from pump Global");
    await rt.launchCurves.writeOnce();
    console.log(`  ${JSON.stringify((await db.query(`SELECT network, venue, virtual_sol_lamports, virtual_token_reserves, real_token_reserves, token_total_supply FROM launch_curves`)).rows)}`);

    // ---- [2] fair_create
    console.log(`\n[2] fair_create: one atomic create + buy of ${Number(LAMPORTS) / LAMPORTS_PER_SOL} SOL with core's mint keypair`);
    const online = new OnlinePumpSdk(conn);
    const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]);
    const quote = toBig(getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: toBN(LAMPORTS), quoteMint: NATIVE_MINT }));
    const minOut = (quote * 9_850n) / 10_000n; // quote minus fee bound and 50 bps, as core does
    const mint = Keypair.generate(); // core generates it and stores it in mint_secret
    const fairId = await insert({
      op: "fair_create",
      venue: "pumpfun",
      meta: { name: "Unzeen Fair Devnet", symbol: "UNZF" },
      lamports_in: LAMPORTS.toString(),
      min_out: minOut.toString(),
      mint_secret: Buffer.from(mint.secretKey),
    });
    const f = await runUntil(fairId);
    console.log(`  tx: ${txUrl(f.signature!)}`);
    console.log(`  out_mint ${f.out_mint} = mint_secret pubkey: ${f.out_mint === mint.publicKey.toBase58()}  ${explorerAddressUrl(f.out_mint!, cfg.cluster)}`);
    console.log(`  tokens ${f.out_token_amount} (min_out ${minOut}), lamports ${f.out_lamports}; pinned to the signing vault: ${(await rt.mintVaults.get(f.out_mint!)) === f.vault}`);
    const feed = (await db.query(`SELECT kind, signature FROM trades WHERE mint = $1 ORDER BY id`, [f.out_mint])).rows;
    console.log(`  feed: ${feed.map((r) => r.kind).join(" + ")} (one signature: ${new Set(feed.map((r) => r.signature)).size === 1})`);
    const tx = await conn.getTransaction(f.signature!, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    console.log(`  v0 tx: ${tx?.version === 0}, lookup tables: ${tx?.transaction.message.addressTableLookups.length ?? 0}, CU ${tx?.meta?.computeUnitsConsumed}`);

    // ---- [3] attest
    const memo = createHash("sha256").update(`devnet-root-${mint.publicKey.toBase58()}`).digest("hex");
    console.log(`\n[3] attest: memo ${memo}`);
    const fairKey = rt.fairAttester.publicKey;
    const bal = await conn.getBalance(fairKey, "confirmed");
    console.log(`  fair-launch attestation key ${fairKey.toBase58()} balance ${bal} lamports`);
    if (bal < 100_000) {
      console.log("  SKIPPED: fair-launch attestation key not funded (the owner funds it; never topped up from a vault)");
    } else {
      const a = await runUntil(await insert({ op: "attest", meta: { memo, purpose: "fair" } }));
      console.log(`  tx: ${txUrl(a.signature!)}  slot ${a.slot}`);
      console.log(`  out_memo from the confirmed tx = root: ${a.out_memo === memo}; signer = fair attestation key: ${a.vault === fairKey.toBase58()}`);
      const extra = (await db.query(`SELECT out_sig, out_block_time FROM relayer_jobs WHERE signature = $1`, [a.signature])).rows[0];
      console.log(`  out_sig valid over hex_decode(memo): ${verifyDetached(fairKey.toBase58(), Buffer.from(memo, "hex"), extra.out_sig)}; out_block_time ${extra.out_block_time}`);
      console.log(`  feed rows for attest: ${(await db.query(`SELECT count(*)::int AS n FROM trades WHERE signature = $1`, [a.signature])).rows[0].n}`);
    }
  } finally {
    await db.end();
    await lockDb.end();
    if (!keep) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`fatal: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
    process.exit(1);
  });
