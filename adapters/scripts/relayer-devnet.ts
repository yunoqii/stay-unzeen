/**
 * Relayer end-to-end on Solana devnet with real transactions, through the
 * PRODUCTION wiring (buildRelayer: PostgresJobQueue, advisory vault locks,
 * mint pins, encrypted keys, metadata store) against a throw-away Postgres
 * schema (copies of relayer_jobs / tokens / trades), so core's real queue and
 * settler are never touched:
 *
 *   create (+ first buy, image with EXIF/GPS -> re-encoded, published)
 *   -> buy (same pinned vault) -> withdraw in 3 parts (one tx each, gas drop,
 *   same pinned vault) -> sell everything left (one tx)
 *
 *   pnpm media:serve &          # serves the published metadata locally
 *   pnpm relayer:devnet [--keep]
 *
 * Needs DATABASE_URL (owner role: it creates the temp schema; devnet only).
 * Dev tool: prints signatures and addresses (public data); there are no users.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import pg from "pg";
import sharp from "sharp";
import { AdapterError } from "../src/errors";
import { loadRepoEnv, redactSecrets } from "../src/env";
import { describeConfig, explorerAddressUrl, explorerTxUrl, loadConfig, makeConnection } from "../src/config";
import { formatUnits } from "../src/math";
import { LocalMetadataStore } from "../src/metadata";
import { FileMintVaults, buildRelayer, defaultMediaDir, makePools, openKeys, relayerNetwork, type RelayerEvent } from "../src/relayer";

const SOL = BigInt(LAMPORTS_PER_SOL);
const VAULTS = 3;
const MIN_VAULT_SOL = (SOL * 6n) / 100n; // create needs ~0.035 SOL headroom + first buy
const FIRST_BUY = SOL / 100n; //            0.01 SOL
const BUY = SOL / 200n; //                  0.005 SOL
const PARTS = 3;

loadRepoEnv();
const cfg = loadConfig();
if (cfg.cluster !== "devnet") {
  console.error(`refusing to run on ${cfg.cluster}: devnet only`);
  process.exit(1);
}
const network = relayerNetwork(cfg);
const conn = makeConnection(cfg);
const txUrl = (sig: string) => explorerTxUrl(sig, cfg.cluster);
const sol = (l: bigint) => `${formatUnits(l, 9)} SOL`;
const warn = (m: string) => console.log(`  WARN ${m}`);

async function topUp(vaults: Keypair[]): Promise<void> {
  const bal = await Promise.all(vaults.map(async (v) => BigInt(await conn.getBalance(v.publicKey, "confirmed"))));
  for (let i = 0; i < vaults.length; i++) {
    if (bal[i]! >= MIN_VAULT_SOL) continue;
    const need = MIN_VAULT_SOL - bal[i]! + SOL / 100n;
    const j = bal.findIndex((b, k) => k !== i && b > need + MIN_VAULT_SOL);
    if (j < 0) {
      console.error(`vault-${i} ${vaults[i]!.publicKey.toBase58()} needs ~${sol(need)}; fund it at https://faucet.solana.com`);
      process.exit(2);
    }
    const t = new Transaction().add(SystemProgram.transfer({ fromPubkey: vaults[j]!.publicKey, toPubkey: vaults[i]!.publicKey, lamports: need }));
    const sig = await sendAndConfirmTransaction(conn, t, [vaults[j]!], { commitment: "confirmed" });
    bal[j]! -= need;
    bal[i]! += need;
    console.log(`  top-up vault-${i} with ${sol(need)} from vault-${j}  ${txUrl(sig)}`);
  }
}

/** A phone-like JPEG: EXIF with GPS + camera + a marker, XMP. */
const MARK = "UNZEEN-DEVNET-EXIF-MARK";
async function dirtyJpeg(): Promise<Buffer> {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#0b0b0f"/>` +
      `<circle cx="450" cy="300" r="220" fill="#f4b728"/><text x="450" y="330" font-size="96" text-anchor="middle" fill="#0b0b0f" font-family="Helvetica">unzeen</text></svg>`,
  );
  return sharp(svg)
    .jpeg()
    .withMetadata({ orientation: 1 })
    .withExif({
      IFD0: { Make: "PhoneMaker", Model: "Phone 15", Artist: MARK },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "55/1 45/1 0/1", GPSLongitudeRef: "E", GPSLongitude: "37/1 37/1 0/1" },
    })
    .withXmp(`<x:xmpmeta xmlns:x="adobe:ns:meta/">${MARK}</x:xmpmeta>`)
    .toBuffer();
}

async function main(): Promise<void> {
  console.log(describeConfig(cfg));
  const owner = process.env.DATABASE_URL?.trim();
  if (!owner) throw new Error("DATABASE_URL is required (temp schema)");
  const keys = await openKeys(cfg, process.env, warn, VAULTS);
  const names = new Map(keys.vaults.map((v, i) => [v.publicKey.toBase58(), `vault-${i}`]));
  const vn = (k: string) => names.get(k) ?? k;
  console.log(`  keys: ${keys.store.encrypted ? "age-encrypted" : "PLAINTEXT"}, ${keys.vaults.length} vaults`);
  await topUp(keys.vaults);

  // ---- throw-away schema with the 0002 tables
  const schema = `relayer_devnet_${randomBytes(4).toString("hex")}`;
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
  const keep = process.argv.includes("--keep");

  try {
    const mediaDir = process.env.UNZEEN_METADATA_DIR?.trim() || defaultMediaDir(cfg);
    const baseUrl = process.env.UNZEEN_METADATA_BASE_URL?.trim() || "http://127.0.0.1:8787/media";
    const events: RelayerEvent[] = [];
    const rt = buildRelayer({
      cfg,
      connection: conn,
      network,
      keys,
      db,
      lockDb,
      warn,
      metadata: new LocalMetadataStore(mediaDir, baseUrl),
      // The temp schema has no mint_vaults: pins in a file next to the keys.
      mintVaults: new FileMintVaults(path.join(cfg.keysDir, "mint-vaults.json")),
      onEvent: (e) => {
        events.push(e);
        console.log(`  [relayer] ${e.event} ${e.kind}${e.code ? ` ${e.code}` : ""}`);
      },
    });

    const insert = async (cols: Record<string, unknown>): Promise<string> => {
      const k = Object.keys(cols);
      const r = await db.query<{ id: string }>(
        `INSERT INTO relayer_jobs (${k.join(", ")}, network) VALUES (${k.map((_, i) => `$${i + 1}`).join(", ")}, 'devnet') RETURNING id`,
        Object.values(cols),
      );
      return r.rows[0]!.id;
    };
    const job = async (id: string) =>
      (
        await db.query(
          `SELECT status, signature, vault, out_mint, out_token_amount, out_lamports, error_code, error_message FROM relayer_jobs WHERE id = $1`,
          [id],
        )
      ).rows[0] as Record<string, string | null>;
    const runUntil = async (ids: string[]) => {
      for (;;) {
        const rows = await Promise.all(ids.map(job));
        const bad = rows.find((r) => r.status === "failed");
        if (bad) throw new Error(`job failed: ${bad.error_code} (${bad.error_message})`);
        if (rows.every((r) => r.status === "confirmed")) return rows;
        if (!(await rt.relayer.tick())) await new Promise((r) => setTimeout(r, 1_000));
      }
    };

    // ---- [1] create with a dirty image
    console.log(`\n[1] create + first buy ${sol(FIRST_BUY)} (image: JPEG with EXIF GPS/camera/XMP)`);
    const src = await dirtyJpeg();
    const srcMeta = await sharp(src).metadata();
    console.log(`  source image: ${src.length} B, exif=${!!srcMeta.exif} xmp=${!!srcMeta.xmp} marker=${src.includes(MARK)}`);
    const createId = await insert({
      op: "create",
      venue: "pumpfun",
      meta: { name: "Unzeen Devnet", symbol: "UNZD", image: `data:image/jpeg;base64,${src.toString("base64")}` },
      lamports_in: FIRST_BUY.toString(),
      min_out: "1",
    });
    const [created] = await runUntil([createId]);
    const mint = created!.out_mint!;
    const pinned = created!.vault!;
    console.log(`  create: ${txUrl(created!.signature!)}`);
    console.log(`  mint ${mint}  ${explorerAddressUrl(mint, cfg.cluster)}`);
    console.log(`  vault ${vn(pinned)} (pinned: ${(await rt.mintVaults.get(mint)) === pinned}), first buy tokens=${created!.out_token_amount} lamports=${created!.out_lamports}`);
    const tok = (await db.query(`SELECT symbol, image FROM tokens WHERE mint = $1`, [mint])).rows[0] as { symbol: string; image: string };
    const feed = (await db.query(`SELECT kind FROM trades WHERE mint = $1 ORDER BY id`, [mint])).rows.map((r) => r.kind as string);
    console.log(`  tokens row: ${tok.symbol} image=${tok.image}; feed: ${feed.join(" + ")}`);
    const published = fs.readFileSync(path.join(mediaDir, path.basename(tok.image)));
    const pubMeta = await sharp(published).metadata();
    console.log(`  published image: ${published.length} B ${pubMeta.width}x${pubMeta.height}, exif=${!!pubMeta.exif} xmp=${!!pubMeta.xmp} marker=${published.includes(MARK)} gps=${published.includes("GPS")}`);
    if (pubMeta.exif || pubMeta.xmp || published.includes(MARK)) throw new Error("published image still carries metadata");
    const ce = await rt.adapter.createResult(created!.signature!, pinned);
    console.log(`  on-chain uri: ${ce?.uri}; creator ${ce?.creator} (fresh, not a vault: ${!names.has(ce?.creator ?? "")})`);

    // ---- [2] buy on the pinned vault
    console.log(`\n[2] buy ${sol(BUY)} (must use the pinned vault)`);
    const q = await rt.adapter.quote(mint, "buy", BUY);
    const [bought] = await runUntil([await insert({ op: "buy", venue: "pumpfun", mint, lamports_in: BUY.toString(), min_out: ((q.amountOut * 97n) / 100n).toString() })]);
    console.log(`  buy: ${txUrl(bought!.signature!)}  ${vn(bought!.vault!)} tokens=${bought!.out_token_amount}`);
    if (bought!.vault !== pinned) throw new Error("buy did not use the pinned vault");

    // ---- [3] withdraw in parts: separate tx each, gas drop, all from the pinned vault
    const recipient = Keypair.generate().publicKey.toBase58(); // devnet: key discarded on purpose
    const total = BigInt(bought!.out_token_amount!) / 2n;
    const rounded = (total / 1_000_000n) * 1_000_000n; // whole tokens (core rounds; D5)
    const parts = [rounded / 5n, (rounded * 2n) / 5n];
    parts.push(rounded - parts[0]! - parts[1]!);
    console.log(`\n[3] withdraw ${formatUnits(rounded, 6)} tokens in ${PARTS} parts to ${recipient} (delays 5–20 s)`);
    const wIds: string[] = [];
    for (const amount of parts) {
      wIds.push(
        await insert({
          op: "transfer",
          mint,
          token_amount: amount.toString(),
          dest: recipient,
          gas_lamports: null, // random drop 0.002–0.004 SOL
          not_before: new Date(Date.now() + 5_000 + Math.floor(Math.random() * 15_000)),
        }),
      );
    }
    const withdrawn = await runUntil(wIds);
    for (const [i, w] of withdrawn.entries()) {
      console.log(`  part ${i + 1}: ${txUrl(w.signature!)}  ${vn(w.vault!)} tokens=${formatUnits(BigInt(w.out_token_amount!), 6)}`);
    }
    if (withdrawn.some((w) => w.vault !== pinned)) throw new Error("a withdraw part did not use the pinned vault");
    if (new Set(withdrawn.map((w) => w.signature)).size !== PARTS) throw new Error("parts must be separate transactions");
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(recipient), false, new PublicKey(ce!.tokenProgram));
    const [rSol, rTok] = await Promise.all([conn.getBalance(new PublicKey(recipient), "confirmed"), conn.getTokenAccountBalance(ata, "confirmed")]);
    console.log(`  recipient holds ${sol(BigInt(rSol))} (gas) and ${rTok.value.uiAmountString} tokens`);

    // ---- [4] sell everything the pool still holds of this mint: one tx
    const left = BigInt((await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(pinned), true, new PublicKey(ce!.tokenProgram)), "confirmed")).value.amount);
    console.log(`\n[4] sell all ${formatUnits(left, 6)} tokens left on the pinned vault (one tx)`);
    const qs = await rt.adapter.quote(mint, "sell", left);
    const [sold] = await runUntil([await insert({ op: "sell", venue: "pumpfun", mint, token_amount: left.toString(), min_out: ((qs.amountOut * 97n) / 100n).toString() })]);
    console.log(`  sell: ${txUrl(sold!.signature!)}  ${vn(sold!.vault!)} lamports=${sold!.out_lamports}`);

    console.log("\nsummary");
    console.log(`  create   ${txUrl(created!.signature!)}`);
    console.log(`  buy      ${txUrl(bought!.signature!)}`);
    withdrawn.forEach((w, i) => console.log(`  withdraw ${i + 1}/${PARTS} ${txUrl(w.signature!)}`));
    console.log(`  sell all ${txUrl(sold!.signature!)}`);
    console.log(`  all on ${vn(pinned)} ${pinned}; events ${events.map((e) => `${e.event}:${e.kind}`).join(", ")}`);
  } finally {
    await db.end();
    await lockDb.end();
    if (!keep) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    else console.log(`  kept schema ${schema}`);
    await admin.end();
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0)) // web3.js websockets keep the loop alive
  .catch((e) => {
    if (e instanceof AdapterError) console.error(`AdapterError ${e.code} (API ${e.apiCode}): ${redactSecrets(e.message)}`);
    else console.error(redactSecrets(e instanceof Error ? (e.stack ?? e.message) : String(e)));
    process.exit(1);
  });
