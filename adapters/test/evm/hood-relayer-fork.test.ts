/**
 * Hood relayer end to end: relayer_jobs row -> signed/recorded tx on a LOCAL
 * anvil fork of Robinhood Chain mainnet -> confirmed row + feed rows in
 * Postgres (throw-away schema). Opt-in: HOOD_FORK=1 + DATABASE_URL.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, getAddress, http, parseEther, recoverMessageAddress, type Address, type PublicClient } from "viem";
import { english, generateMnemonic, generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadRepoEnv } from "../../src/env";
import { hoodMainnet } from "../../src/evm/chain";
import { EvmExecutor } from "../../src/evm/executor";
import { EvmFeeCache } from "../../src/evm/fees";
import { FunderPool } from "../../src/evm/funders";
import { EvmKeyring } from "../../src/evm/keys";
import { ponsV2TokenAbi } from "../../src/evm/pons/abi/token";
import { PonsAdapter, PONS_ERROR_ABI } from "../../src/evm/pons/adapter";
import { HoodRelayer } from "../../src/evm/relayer/engine";
import { MemoryLaunchStore } from "../../src/evm/relayer/launches";
import { PgHoodQueue } from "../../src/evm/relayer/queue";
import { FUND_STEP_WEI, hoodPoolMints, hoodSnapshotSigners, hoodSnapshotTick, readInventory, writeInventory, writePonsLaunchCurve } from "../../src/evm/relayer/pool-state";
import { checkVerifySnapshot } from "../../src/evm/attest";
import { EvmWithdrawer } from "../../src/evm/withdraw";
import { MemoryCreatorIndexCounter } from "../../src/keys";
import { PgMintVaults } from "../../src/relayer/mint-vaults";
import { PgAdvisoryVaultLock } from "../../src/relayer/postgres-vaults";

loadRepoEnv();
const DB = process.env.DATABASE_URL;
const enabled = process.env.HOOD_FORK === "1" && !!DB && spawnSync("anvil", ["--version"]).status === 0;
const forkUrl = process.env.HOOD_FORK_URL?.trim() || process.env.HOOD_RPC_URL_MAINNET?.trim() || "https://robinhood.drpc.org";

describe.skipIf(!enabled)("hood relayer: job -> tx (anvil fork 4663) -> Postgres", () => {
  const schema = `hood_rel_${randomBytes(4).toString("hex")}`;
  const port = 19000 + Math.floor(Math.random() * 300);
  let anvil: ChildProcess;
  let admin: pg.Pool;
  let db: pg.Pool;
  let lockDb: pg.Pool;
  let client: PublicClient;
  let kr: EvmKeyring;
  let ex: EvmExecutor;
  let adapter: PonsAdapter;
  let relayer: HoodRelayer;
  let queue: PgHoodQueue;
  let launches: MemoryLaunchStore;
  let token: Address;

  const insertJob = async (cols: Record<string, unknown>): Promise<string> => {
    const keys = Object.keys(cols);
    const r = await db.query<{ id: string }>(
      `INSERT INTO relayer_jobs (network, status, not_before, exec_mode, ${keys.join(", ")})
       VALUES ('hood', 'queued', now() - interval '1 second', 'now', ${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id::text`,
      keys.map((k) => cols[k]),
    );
    return r.rows[0]!.id;
  };
  const row = async (id: string) => (await db.query(`SELECT *, out_token_amount::text AS ota, out_lamports::text AS ol FROM relayer_jobs WHERE id = $1`, [id])).rows[0];
  const drain = async () => {
    for (let i = 0; i < 20 && (await relayer.tick("now")); i++);
  };

  beforeAll(async () => {
    anvil = spawn("anvil", ["--fork-url", forkUrl, "--port", String(port), "--chain-id", "4663", "--silent"], { stdio: "ignore" });
    client = createPublicClient({ chain: hoodMainnet, transport: http(`http://127.0.0.1:${port}`, { retryCount: 0 }) }) as PublicClient;
    for (let i = 0; i < 100; i++) {
      try {
        await client.getChainId();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    admin = new pg.Pool({ connectionString: DB, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const t of ["relayer_jobs", "trades", "tokens", "mint_vaults", "verify_snapshots", "creator_fee_sweeps", "launch_curves", "pool_sol_inventory", "verify_vaults"]) {
      await admin.query(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    }
    db = new pg.Pool({ connectionString: DB, max: 4, options: `-c search_path=${schema}` });
    lockDb = new pg.Pool({ connectionString: DB, max: 4, options: `-c search_path=${schema}` });

    const fees = new EvmFeeCache(200_000_000n, async () => (await client.getBlock()).baseFeePerGas ?? 0n);
    ex = new EvmExecutor({ read: client, chainId: 4663, fees, allowSend: true, errorAbi: PONS_ERROR_ABI, pollingIntervalMs: 50 });
    kr = new EvmKeyring(generateMnemonic(english, 256), new MemoryCreatorIndexCounter());
    const funders = new FunderPool({ executor: ex, keyring: kr, count: 2 });
    for (const a of [kr.funder(0), kr.funder(1), kr.vault(0), kr.vault(1), kr.attest("verify"), kr.rebalance(0)]) {
      await client.request({ method: "anvil_setBalance" as never, params: [a.address, `0x${parseEther("10").toString(16)}`] as never });
    }
    adapter = new PonsAdapter({ executor: ex, keyring: kr, funders });
    queue = new PgHoodQueue(db, "hood");
    launches = new MemoryLaunchStore();
    const vaults = [kr.vault(0), kr.vault(1)];
    relayer = new HoodRelayer({
      queue,
      adapter,
      executor: ex,
      keyring: kr,
      vaults,
      mintVaults: new PgMintVaults(db, "hood" as never),
      lock: new PgAdvisoryVaultLock(lockDb, "hood" as never),
      launches,
      withdrawer: new EvmWithdrawer({ executor: ex, isPoolAddress: (a) => vaults.some((v) => getAddress(v.address) === getAddress(a)) }),
    });
  }, 60_000);

  afterAll(async () => {
    anvil?.kill();
    await db?.end();
    await lockDb?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("create: launch tx recorded, confirmed with out_mint, token + mint pin + feed rows", async () => {
    const id = await insertJob({ op: "create", venue: "pons", lamports_in: parseEther("0.05").toString(), min_out: "1", meta: { name: "Relay Hood", symbol: "RHOOD" } });
    await drain();
    const r = await row(id);
    expect(r.status).toBe("confirmed");
    expect(r.signature).toMatch(/^0x[0-9a-f]{64}$/);
    token = getAddress(r.out_mint);
    expect(BigInt(r.ota) > 0n).toBe(true);
    expect(r.ol).toBe(parseEther("0.05").toString());
    expect(BigInt(r.out_creator_fee) > 0n).toBe(true);
    const pin = (await db.query(`SELECT vault FROM mint_vaults WHERE network = 'hood' AND mint = $1`, [token])).rows[0];
    expect(getAddress(pin.vault)).toBe(getAddress(r.vault));
    const feed = (await db.query(`SELECT kind, token_amount::text FROM trades WHERE mint = $1 ORDER BY kind`, [token])).rows;
    expect(feed.map((x) => x.kind)).toEqual(["buy", "create"]);
    expect((await db.query(`SELECT venue, symbol FROM tokens WHERE mint = $1`, [token])).rows[0]).toEqual({ venue: "pons", symbol: "RHOOD" });
    expect((await launches.all()).size).toBe(0); // settled -> entry dropped
  }, 120_000);

  it("buy and sell: pinned vault, recorded hash = confirmed signature, amounts from events, feed rows", async () => {
    const pinned = getAddress((await db.query(`SELECT vault FROM mint_vaults WHERE mint = $1`, [token])).rows[0].vault);
    const b = await insertJob({ op: "buy", venue: "pons", mint: token, lamports_in: parseEther("0.02").toString(), min_out: "1" });
    await drain();
    const rb = await row(b);
    expect(rb.status).toBe("confirmed");
    expect(getAddress(rb.vault)).toBe(pinned);
    expect(rb.ol).toBe(parseEther("0.02").toString());
    const tx = await client.getTransaction({ hash: rb.signature });
    expect(getAddress(tx.from)).toBe(pinned);
    expect(BigInt(rb.slot)).toBe(tx.blockNumber);
    const s = await insertJob({ op: "sell", venue: "pons", mint: token, token_amount: (BigInt(rb.ota) / 2n).toString(), min_out: "1" });
    await drain();
    const rs = await row(s);
    expect(rs.status).toBe("confirmed");
    expect(rs.ota).toBe((BigInt(rb.ota) / 2n).toString());
    expect(BigInt(rs.ol) > 0n).toBe(true);
    const kinds = (await db.query(`SELECT kind FROM trades WHERE mint = $1 ORDER BY slot, kind`, [token])).rows.map((x) => x.kind);
    expect(kinds.filter((k) => k === "sell")).toHaveLength(1);
  }, 120_000);

  it("withdraw (transfer): gas drop from the same vault, rounded part, no feed row", async () => {
    const to = privateKeyToAccount(generatePrivateKey()).address;
    const id = await insertJob({ op: "transfer", venue: "pons", mint: token, token_amount: "123000000000000000000", dest: to, gas_lamports: "60000000000000" });
    await drain();
    const r = await row(id);
    expect(r.status).toBe("confirmed");
    expect(r.ota).toBe("123000000000000000000");
    expect(r.ol).toBe("0");
    expect(await client.readContract({ address: token, abi: ponsV2TokenAbi, functionName: "balanceOf", args: [to] })).toBe(123_000_000_000_000_000_000n);
    expect(await client.getBalance({ address: to })).toBe(60_000_000_000_000n);
    expect((await db.query(`SELECT count(*)::int AS n FROM trades WHERE signature = $1`, [r.signature])).rows[0].n).toBe(0);
    // unrounded part -> failed bad_request, nothing sent
    const bad = await insertJob({ op: "transfer", venue: "pons", mint: token, token_amount: "123456", dest: to });
    await drain();
    expect((await row(bad)).status).toBe("failed");
    expect((await row(bad)).error_code).toBe("bad_request");
    expect((await row(bad)).signature).toBeNull();
  }, 120_000);

  it("attest (verify): self-tx with the root as calldata, out_sig by the attestation key", async () => {
    const memo = randomBytes(32).toString("hex");
    const id = await insertJob({ op: "attest", meta: { memo, purpose: "verify" } });
    for (let i = 0; i < 5 && (await relayer.tick("attest")); i++);
    const r = await row(id);
    expect(r.status).toBe("confirmed");
    expect(r.out_memo).toBe(memo);
    expect(getAddress(r.vault)).toBe(getAddress(kr.attest("verify").address));
    expect(await recoverMessageAddress({ message: { raw: `0x${memo}` }, signature: r.out_sig })).toBe(getAddress(kr.attest("verify").address));
    expect(Number(r.out_block_time) > 0).toBe(true);
  }, 60_000);

  it("restart: a recorded-but-unreported buy is resolved from chain, never sent twice", async () => {
    const id = await insertJob({ op: "buy", venue: "pons", mint: token, lamports_in: parseEther("0.01").toString(), min_out: "1" });
    const job = (await queue.claim({ workerId: "crashy", leaseMs: 60_000, lane: "now" }))!;
    expect(job.id).toBe(id);
    const pinned = getAddress((await db.query(`SELECT vault FROM mint_vaults WHERE mint = $1`, [token])).rows[0].vault);
    const v = [kr.vault(0), kr.vault(1)].find((x) => getAddress(x.address) === pinned)!;
    const before = await client.readContract({ address: token, abi: ponsV2TokenAbi, functionName: "balanceOf", args: [v.address] });
    // "crash" right after the tx landed: hash recorded, result never reported.
    const r = await adapter.buy(token, parseEther("0.01"), 1n, { vault: v, onSigned: async (tx) => queue.reportSent(job, { hash: tx.hash, nonce: tx.nonce, vault: pinned, sentAt: Date.now() }) });
    await db.query(`UPDATE relayer_jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [id]);
    await drain();
    const row1 = await row(id);
    expect(row1.status).toBe("confirmed");
    expect(row1.signature).toBe(r.hash);
    expect(row1.ota).toBe(r.tokenAmount.toString());
    const after = await client.readContract({ address: token, abi: ponsV2TokenAbi, functionName: "balanceOf", args: [v.address] });
    expect(after - before).toBe(r.tokenAmount); // exactly one buy
  }, 120_000);

  it("advisory lock: a vault held by another process -> job waits (retry), then runs", async () => {
    const pinned = getAddress((await db.query(`SELECT vault FROM mint_vaults WHERE mint = $1`, [token])).rows[0].vault);
    const other = new PgAdvisoryVaultLock(lockDb, "hood" as never);
    const held = (await other.tryAcquire(pinned))!;
    const id = await insertJob({ op: "buy", venue: "pons", mint: token, lamports_in: parseEther("0.001").toString(), min_out: "1" });
    await relayer.tick("now");
    expect((await row(id)).status).toBe("claimed");
    expect((await row(id)).signature).toBeNull();
    await held.release();
    await db.query(`UPDATE relayer_jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [id]);
    await drain();
    expect((await row(id)).status).toBe("confirmed");
  }, 60_000);

  it("restart reconcile: a launch whose job failed returns the creator's ETH to the rebalance address", async () => {
    const idx = await kr.allocateCreator();
    const creator = kr.account("creator", idx);
    await ex.transfer(kr.funder(0), creator.address, parseEther("0.01"));
    await ex.transfer(creator, creator.address, 0n); // nonce used, no launch
    const id = await insertJob({ op: "create", venue: "pons", lamports_in: "0", meta: { name: "X", symbol: "X" } });
    await db.query(`UPDATE relayer_jobs SET status = 'failed', error_code = 'internal' WHERE id = $1`, [id]);
    await launches.put(id, { creatorIndex: idx, fromBlock: (await client.getBlockNumber()) - 5n });
    const rb = await client.getBalance({ address: kr.rebalance(0).address });
    const res = await relayer.reconcileLaunches();
    expect(res.refunded).toBe(1);
    expect((await client.getBalance({ address: kr.rebalance(0).address })) > rb).toBe(true);
    expect((await launches.all()).size).toBe(0);
  }, 60_000);

  it("launch_curves (hood, pons) and pool_sol_inventory in wei", async () => {
    const c = await writePonsLaunchCurve(db, "hood", adapter);
    const r = (await db.query(`SELECT virtual_sol_lamports::text v, virtual_token_reserves::text t, real_token_reserves::text rr, token_total_supply::text s FROM launch_curves WHERE network = 'hood' AND venue = 'pons'`)).rows[0];
    expect(r).toEqual({ v: c.virtualSolLamports.toString(), t: c.virtualTokenReserves.toString(), rr: c.realTokenReserves.toString(), s: c.tokenTotalSupply.toString() });
    expect(r.s).toBe("1000000000000000000000000000"); // 1e27: above i64, NUMERIC
    const inv = await readInventory(ex, [kr.vault(0).address, kr.vault(1).address], kr.rebalance(0).address);
    await writeInventory(db, "hood", inv);
    const i = (await db.query(`SELECT vault_lamports::text v, vault_count n, rebalance_lamports::text r FROM pool_sol_inventory WHERE network = 'hood'`)).rows[0];
    const b0 = await client.getBalance({ address: kr.vault(0).address });
    const b1 = await client.getBalance({ address: kr.vault(1).address });
    expect(i).toEqual({ v: (b0 + b1).toString(), n: 2, r: (await client.getBalance({ address: kr.rebalance(0).address })).toString() });
  }, 60_000);

  it("fund_vaults: ONE tx from the rebalance address, round shares, never vault -> vault", async () => {
    const vs = [kr.vault(0).address, kr.vault(1).address];
    const before = await Promise.all(vs.map((a) => client.getBalance({ address: a })));
    const id = await insertJob({ op: "fund_vaults", lamports_in: parseEther("1").toString(), meta: { purpose: "rebalance" } });
    await drain();
    const r = await row(id);
    expect(r.status).toBe("confirmed");
    expect(getAddress(r.vault)).toBe(getAddress(kr.rebalance(0).address));
    const sent = BigInt(r.ol);
    expect(sent > 0n && sent <= parseEther("1")).toBe(true);
    const after = await Promise.all(vs.map((a) => client.getBalance({ address: a })));
    const deltas = after.map((a, i) => a - before[i]!);
    expect(deltas.reduce((a, b) => a + b, 0n)).toBe(sent);
    for (const d of deltas) expect(d % FUND_STEP_WEI).toBe(0n);
    const tx = await client.getTransaction({ hash: r.signature });
    expect(getAddress(tx.from)).toBe(getAddress(kr.rebalance(0).address));
    expect(tx.value).toBe(sent);
  }, 60_000);

  it("Verify v3 snapshot on hood: EIP-55 addresses and mints, wei, EIP-712 sigs, one block", async () => {
    const minSlot = await client.getBlockNumber();
    const snap = await db.query<{ id: number }>(
      `INSERT INTO verify_snapshots (network, chain_id, kind, status, freeze_until, digest_version, min_slot)
       VALUES ('hood', '0111', 'manual', 'collecting', now() + interval '2 minutes', 3, $1) RETURNING id`,
      [minSlot.toString()],
    );
    const id = snap.rows[0]!.id;
    const res = await hoodSnapshotTick({
      db,
      network: "hood",
      ex,
      chainId: 4663,
      signers: async () => hoodSnapshotSigners(kr, 2, 2, 3),
      mints: () => hoodPoolMints(db, "hood"),
    });
    expect(res).toBe("written");
    const s = (await db.query(`SELECT solana_slot::text b, assets_done_at IS NOT NULL done FROM verify_snapshots WHERE id = $1`, [id])).rows[0];
    expect(s.done).toBe(true);
    expect(BigInt(s.b) >= minSlot).toBe(true);
    const rows = (await db.query(`SELECT address, lamports::text l, tokens, sig FROM verify_vaults WHERE snapshot_id = $1 ORDER BY address`, [id])).rows;
    const v0 = rows.find((x) => x.address === getAddress(kr.vault(0).address))!;
    expect(v0.l).toBe((await client.getBalance({ address: kr.vault(0).address, blockNumber: BigInt(s.b) })).toString());
    for (const x of rows) {
      expect(x.address).toBe(getAddress(x.address)); // EIP-55
      for (const t of x.tokens) expect(t.mint).toBe(getAddress(t.mint));
      expect(await checkVerifySnapshot(4663, { snapshotId: String(id), address: x.address, blockNumber: BigInt(s.b) }, x.sig)).toBe(true);
    }
    const pinnedToken = v0.tokens.find((t: { mint: string }) => t.mint === token) ?? rows.flatMap((x) => x.tokens).find((t: { mint: string }) => t.mint === token);
    expect(pinnedToken).toBeTruthy();
    expect(rows.some((x) => x.address === getAddress(kr.rebalance(0).address))).toBe(true);
    await db.query(`UPDATE verify_snapshots SET status = 'built' WHERE id = $1`, [id]);
  }, 60_000);
});
