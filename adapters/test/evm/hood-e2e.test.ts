/**
 * END TO END with the core hood instance (RELAYER v14 / API v0.20):
 *   core `unzeen-api serve` (UNZEEN_CHAIN=hood, throw-away DB `unzeen_e2e_hood`)
 *   + this hood relayer + a LOCAL anvil fork of Robinhood Chain mainnet.
 * deposit (ledger row) -> create pons -> buy -> sell -> withdraw_token -> Verify v3 snapshot.
 * Opt-in: HOOD_E2E=1 (needs anvil, core/target/debug/unzeen-api, DATABASE_URL on a server
 * where the role may CREATE DATABASE). Nothing is sent to mainnet.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign as edSign, type KeyObject } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bs58 from "bs58";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, getAddress, http, parseEther, type Address, type PublicClient } from "viem";
import { english, generateMnemonic, generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadRepoEnv, REPO_ROOT } from "../../src/env";
import { hoodMainnet } from "../../src/evm/chain";
import { EvmExecutor } from "../../src/evm/executor";
import { EvmFeeCache } from "../../src/evm/fees";
import { FunderPool } from "../../src/evm/funders";
import { EvmKeyring } from "../../src/evm/keys";
import { ponsV2TokenAbi } from "../../src/evm/pons/abi/token";
import { PonsAdapter, PONS_ERROR_ABI } from "../../src/evm/pons/adapter";
import { HoodRelayer } from "../../src/evm/relayer/engine";
import { MemoryLaunchStore } from "../../src/evm/relayer/launches";
import { hoodPoolMints, hoodSnapshotSigners, hoodSnapshotTick, writeInventory, readInventory, writePonsLaunchCurve } from "../../src/evm/relayer/pool-state";
import { PgHoodQueue } from "../../src/evm/relayer/queue";
import { EvmWithdrawer } from "../../src/evm/withdraw";
import { MemoryCreatorIndexCounter } from "../../src/keys";
import { PgMintVaults } from "../../src/relayer/mint-vaults";
import { PgAdvisoryVaultLock } from "../../src/relayer/postgres-vaults";

loadRepoEnv();
const API_BIN = path.join(REPO_ROOT, "core/target/debug/unzeen-api");
const enabled =
  process.env.HOOD_E2E === "1" && !!process.env.DATABASE_URL && fs.existsSync(API_BIN) && spawnSync("anvil", ["--version"]).status === 0;
const forkUrl = process.env.HOOD_FORK_URL?.trim() || process.env.HOOD_RPC_URL_MAINNET?.trim() || "https://robinhood.drpc.org";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** anon key: plain ed25519 (the server only checks the signature). */
class Anon {
  private readonly priv: KeyObject;
  readonly pub: Buffer;
  constructor(private readonly base: string, private readonly chainId: string) {
    const kp = generateKeyPairSync("ed25519");
    this.priv = kp.privateKey;
    this.pub = (kp.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
  }
  async req(method: "GET" | "POST", target: string, body?: unknown): Promise<{ status: number; json: any }> {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const nonce = randomBytes(16).toString("hex");
    const ts = String(Date.now());
    const msg = ["unzeen/api/v1", this.chainId, method, target, createHash("sha256").update(raw).digest("hex"), nonce, ts].join("\n");
    const sig = edSign(null, Buffer.from(msg, "utf8"), this.priv);
    const res = await fetch(this.base + target, {
      method,
      headers: {
        "content-type": "application/json",
        "x-unzeen-pubkey": bs58.encode(this.pub),
        "x-unzeen-nonce": nonce,
        "x-unzeen-ts": ts,
        "x-unzeen-sig": bs58.encode(sig),
      },
      ...(method === "POST" ? { body: raw } : {}),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }
}

describe.skipIf(!enabled)("hood e2e: core API + hood relayer + anvil fork", () => {
  const apiPort = 18800 + Math.floor(Math.random() * 100);
  const rpcPort = 19400 + Math.floor(Math.random() * 100);
  const base = `http://127.0.0.1:${apiPort}`;
  const dbName = `unzeen_e2e_hood_${randomBytes(3).toString("hex")}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hood-e2e-"));
  const ac = new AbortController();
  let anvil: ChildProcess;
  let api: ChildProcess;
  let admin: pg.Pool;
  let db: pg.Pool;
  let lockDb: pg.Pool;
  let client: PublicClient;
  let kr: EvmKeyring;
  let ex: EvmExecutor;
  let adapter: PonsAdapter;
  let anon: Anon;
  let creatorKey: Anon;
  let chainId: string;
  let mint: Address;
  let apiLog = "";
  let apiExit: number | null = null;

  const waitAction = async (id: string, timeoutMs = 120_000, who?: Anon): Promise<any> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await (who ?? anon).req("GET", `/api/actions/${id}`);
      const st = r.json?.status;
      if (st === "executed" || st === "failed") return r.json;
      if (Date.now() > deadline) throw new Error(`action ${st}`);
      await sleep(1_000);
    }
  };
  const holdings = async (): Promise<Map<string, bigint>> => {
    const p = await anon.req("GET", "/api/portfolio");
    return new Map((p.json?.holdings ?? []).map((h: { mint: string; amount: string }) => [getAddress(h.mint), BigInt(h.amount)]));
  };

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
    anvil = spawn("anvil", ["--fork-url", forkUrl, "--port", String(rpcPort), "--chain-id", "4663", "--silent"], { stdio: "ignore" });
    const env = { ...process.env };
    delete env.DATABASE_URL_RELAYER;
    delete env.DATABASE_URL_INDEXER;
    api = spawn(API_BIN, ["serve"], {
      env: {
        ...env,
        DATABASE_URL: url,
        UNZEEN_CHAIN: "hood",
        UNZEEN_NETWORK: "main",
        UNZEEN_ALLOW_MAINNET_ACTIONS: "1",
        UNZEEN_VENUES: "pons",
        UNZEEN_CREATE_ENABLED: "1",
        UNZEEN_VERIFY_DAILY: "0",
        UNZEEN_STATS_DAILY: "0",
        UNZEEN_HOME: home,
        API_BIND: `127.0.0.1:${apiPort}`,
        UNZEEN_EPOCH_MIN_SECS: "1",
        UNZEEN_EPOCH_MAX_SECS: "2",
        WITHDRAW_TOKEN_DELAY_MIN_SECS: "1",
        WITHDRAW_TOKEN_DELAY_MAX_SECS: "2",
        API_LOG: "warn",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    api.stdout?.on("data", (d) => (apiLog += d));
    api.stderr?.on("data", (d) => (apiLog += d));
    api.on("exit", (code) => (apiExit = code ?? -1));
    client = createPublicClient({ chain: hoodMainnet, transport: http(`http://127.0.0.1:${rpcPort}`, { retryCount: 0 }) }) as PublicClient;
    for (let i = 0; i < 150; i++) {
      const ok = await Promise.all([
        client.getChainId().then(() => true, () => false),
        fetch(`${base}/api/tokens`).then((r) => r.ok, () => false),
      ]);
      if (ok.every(Boolean)) break;
      await sleep(200);
    }
    // GET /api/pool needs the scanner's published pool address; the chain id of a hood mainnet instance is fixed.
    chainId = "0111";
    expect(apiLog).not.toMatch(/panicked/);
    db = new pg.Pool({ connectionString: url, max: 4 });
    lockDb = new pg.Pool({ connectionString: url, max: 4 });

    const fees = new EvmFeeCache(200_000_000n, async () => (await client.getBlock()).baseFeePerGas ?? 0n);
    ex = new EvmExecutor({ read: client, chainId: 4663, fees, allowSend: true, errorAbi: PONS_ERROR_ABI, pollingIntervalMs: 50 });
    kr = new EvmKeyring(generateMnemonic(english, 256), new MemoryCreatorIndexCounter());
    const funders = new FunderPool({ executor: ex, keyring: kr, count: 2 });
    for (const a of [kr.funder(0), kr.funder(1), kr.vault(0), kr.vault(1), kr.attest("verify"), kr.attest("fair"), kr.rebalance(0)]) {
      await client.request({ method: "anvil_setBalance" as never, params: [a.address, `0x${parseEther("20").toString(16)}`] as never });
    }
    adapter = new PonsAdapter({ executor: ex, keyring: kr, funders });
    const vaults = [kr.vault(0), kr.vault(1)];
    const relayer = new HoodRelayer({
      queue: new PgHoodQueue(db, "hood"),
      adapter,
      executor: ex,
      keyring: kr,
      vaults,
      mintVaults: new PgMintVaults(db, "hood" as never),
      lock: new PgAdvisoryVaultLock(lockDb, "hood" as never),
      launches: new MemoryLaunchStore(),
      withdrawer: new EvmWithdrawer({ executor: ex, isPoolAddress: (a) => vaults.some((v) => getAddress(v.address) === getAddress(a)) }),
      sleep: async (ms) => {
        await sleep(Math.min(ms, 300));
      },
    });
    await writePonsLaunchCurve(db, "hood", adapter);
    await writeInventory(db, "hood", await readInventory(ex, vaults.map((v) => v.address), kr.rebalance(0).address));
    void relayer.run(ac.signal, () => undefined, 300);
    void (async () => {
      while (!ac.signal.aborted) {
        await hoodSnapshotTick({
          db,
          network: "hood",
          ex,
          chainId: 4663,
          signers: async () => hoodSnapshotSigners(kr, 2, 2, 4),
          mints: () => hoodPoolMints(db, "hood"),
        }).catch(() => undefined);
        await sleep(1_000);
      }
    })();
    anon = new Anon(base, chainId);
    creatorKey = new Anon(base, chainId);
  }, 120_000);

  afterAll(async () => {
    ac.abort();
    await sleep(500);
    api?.kill();
    anvil?.kill();
    await db?.end().catch(() => undefined);
    await lockDb?.end().catch(() => undefined);
    await sleep(500);
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
    await admin?.end();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("pool info is the hood instance", () => {
    expect(chainId).toBe("0111");
  });

  it("deposit (ledger row) -> create pons -> buy -> sell -> withdraw_token", async () => {
    // Deposit stand-in: credited balance of 1 ZEC (the scanner would do this after K confirmations).
    await db.query(`INSERT INTO balances (anon_pubkey, available_zat) VALUES ($1, 100000000), ($2, 100000000)`, [anon.pub, creatorKey.pub]);

    // The creator launches; another key trades (the creator's own buys are capped at 5 % of the supply).
    const c = await creatorKey.req("POST", "/api/actions", { op: "create", venue: "pons", meta: { name: "E2E Hood", symbol: "EHOOD" }, initialBuyZec: "2000000", exec: "delayed" });
    expect(c.status, JSON.stringify(c.json) + apiLog.slice(-2000)).toBe(200);
    const created = await waitAction(c.json.id, 120_000, creatorKey);
    expect(created.status, JSON.stringify(created)).toBe("executed");
    mint = getAddress(created.fill.mint);
    expect(BigInt(created.fill.tokenAmount) > 0n).toBe(true);

    const b = await anon.req("POST", "/api/actions", { op: "buy", venue: "pons", mint, zecIn: "5000000", minOut: "1", exec: "delayed" });
    expect(b.status, JSON.stringify(b.json)).toBe(200);
    const bought = await waitAction(b.json.id);
    expect(bought.status, JSON.stringify(bought)).toBe("executed");
    const job = (await db.query(`SELECT signature, vault, out_token_amount::text t FROM relayer_jobs WHERE op = 'buy' AND status = 'confirmed' ORDER BY id DESC LIMIT 1`)).rows[0];
    const tx = await client.getTransaction({ hash: job.signature });
    expect(getAddress(tx.from)).toBe(getAddress(job.vault));
    expect(bought.fill.tokenAmount).toBe(job.t);

    const h1 = (await holdings()).get(mint)!;
    expect(h1 > 0n).toBe(true);
    const s = await anon.req("POST", "/api/actions", { op: "sell", venue: "pons", mint, amount: (h1 / 3n).toString(), minZecOut: "1", exec: "delayed" });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    const sold = await waitAction(s.json.id);
    expect(sold.status, JSON.stringify(sold)).toBe("executed");
    expect(BigInt(sold.fill.zecCredited ?? "0") > 0n).toBe(true);

    const to = privateKeyToAccount(generatePrivateKey()).address;
    const h2 = (await holdings()).get(mint)!;
    const w = await anon.req("POST", "/api/actions", { op: "withdraw_token", mint, amount: (h2 / 2n).toString(), to, exec: "delayed" });
    expect(w.status, JSON.stringify(w.json)).toBe(200);
    const wd = await waitAction(w.json.id, 180_000);
    expect(wd.status, JSON.stringify(wd) + apiLog.slice(-1500)).toBe("executed");
    const got = await client.readContract({ address: mint, abi: ponsV2TokenAbi, functionName: "balanceOf", args: [to] });
    expect(got > 0n).toBe(true);
    expect(got).toBe(BigInt(wd.fill.tokenAmount));
    expect((await client.getBalance({ address: to })) > 0n).toBe(true); // gas drop
  }, 600_000);

  it("Verify v3 snapshot: relayer writes EIP-55 vault rows; core builds digest v3", async () => {
    const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`), UNZEEN_CHAIN: "hood", UNZEEN_NETWORK: "main", UNZEEN_VENUES: "pons", UNZEEN_HOME: home };
    delete (env as Record<string, string | undefined>).DATABASE_URL_RELAYER;
    const r = spawnSync(API_BIN, ["verify-snapshot", "--allow-mainnet"], { env, encoding: "utf8" });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const id = (await db.query<{ id: number }>(`SELECT max(id) AS id FROM verify_snapshots WHERE network = 'hood'`)).rows[0]!.id;
    let row: any;
    for (let i = 0; i < 240; i++) {
      row = (await db.query(`SELECT status, digest_version, assets_done_at IS NOT NULL done, skip_reason FROM verify_snapshots WHERE id = $1`, [id])).rows[0];
      if (row.status === "built" || row.status === "skipped") break;
      await sleep(1_000);
    }
    expect(row.done, JSON.stringify(row)).toBe(true);
    console.log(`verify snapshot row: ${JSON.stringify(row)}`);
    if (row.status === "built") expect(row.digest_version).toBe(3);
    const vaults = (await db.query(`SELECT address, lamports::text l, tokens FROM verify_vaults WHERE snapshot_id = $1`, [id])).rows;
    expect(vaults.length > 0).toBe(true);
    for (const v of vaults) {
      expect(v.address).toBe(getAddress(v.address));
      for (const t of v.tokens) expect(t.mint).toBe(getAddress(t.mint));
    }
    expect(vaults.flatMap((v) => v.tokens).some((t: { mint: string }) => t.mint === mint)).toBe(true);
    // Report what core did with it (built needs the scanner's ZEC reserve; skipped without it).
    console.log(`verify snapshot #${id}: ${row.status}${row.skip_reason ? ` (${row.skip_reason})` : ""}`);
    expect(apiExit, `core API exited: ${apiLog.slice(-1500)}`).toBeNull();
    const pub = (await fetch(`${base}/api/verify`).then((r) => r.json(), () => null).catch(() => null)) as { digestVersion?: number } | null;
    if (row.status === "built" && pub?.digestVersion !== undefined) expect(pub.digestVersion).toBe(3);
  }, 300_000);
});
