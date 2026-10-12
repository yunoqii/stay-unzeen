import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, type Signer, type VersionedTransactionResponse } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { describe, expect, it } from "vitest";
import {
  CreatorDirectory,
  DEFAULT_THRESHOLD,
  dbcFeeInstructions,
  feeTxCost,
  pumpFeeInstructions,
  pumpFeeState,
  pumpReturnAmount,
  pumpTransferAmount,
  sweepThreshold,
  type FeeTarget,
  type FeeTxPlan,
  type FeeVenue,
} from "../src/creator-fees";
import { fixedPrice } from "../src/fees";
import { deriveCreatorKeypair } from "../src/keys";
import {
  DEFAULT_SWEEP_SCHEDULE,
  FeeSweeper,
  MemoryFeeSweepStore,
  assertSingleAuthority,
  nextSweepDelay,
  type SweepChain,
} from "../src/relayer/fee-sweeper";
import { seededRng } from "../src/relayer/random";
import { VaultPool } from "../src/relayer/vaults";
import type { SignatureState, SignedTx } from "../src/tx";
import { FakeInventory, vaults as makeVaults } from "./relayer/fakes";

const SEED = new Uint8Array(64).fill(7);

/** A venue over fixed targets; builds "claim" ixs that need exactly the target's authority. */
class FakeVenue implements FeeVenue {
  readonly venue = "pumpfun" as const;
  constructor(
    readonly targets: FeeTarget[],
    private readonly dir: CreatorDirectory,
  ) {}
  async discover(): Promise<FeeTarget[]> {
    return this.targets.map((t) => ({ ...t }));
  }
  async build(t: FeeTarget, vault: PublicKey): Promise<FeeTxPlan | null> {
    const authority = this.dir.get(t.authority)!;
    const ix = SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: vault, lamports: t.lamports });
    return { target: t, instructions: [ix], authority, computeUnits: 120_000, expectedLamports: t.lamports };
  }
  collected(_tx: VersionedTransactionResponse, _t: FeeTarget): bigint | null {
    return null;
  }
}

interface SentTx {
  payer: string;
  signers: string[];
  ixs: TransactionInstruction[];
  signature: string;
}

class FakeSweepChain implements SweepChain {
  readonly sent: SentTx[] = [];
  submitFails = false;
  states = new Map<string, SignatureState>();
  private n = 0;
  constructor(private readonly store?: MemoryFeeSweepStore) {}
  async sign(ixs: TransactionInstruction[], payer: Signer, authority: Signer): Promise<SignedTx> {
    const signature = `sig${++this.n}`;
    this.sent.push({ payer: payer.publicKey.toBase58(), signers: [payer, authority].map((s) => s.publicKey.toBase58()), ixs, signature });
    return { signature, raw: new Uint8Array(), blockhash: "x", lastValidBlockHeight: 100 };
  }
  async submit(tx: SignedTx): Promise<{ slot: number }> {
    // the row must exist BEFORE broadcast
    if (this.store && !this.store.rows.some((r) => r.signature === tx.signature)) throw new Error("not recorded before broadcast");
    if (this.submitFails) throw { error: new Error("timeout"), logs: null, stage: "confirm" };
    return { slot: 1 };
  }
  async fetch(): Promise<VersionedTransactionResponse | null> {
    return null;
  }
  async state(sig: string): Promise<SignatureState> {
    return this.states.get(sig) ?? { state: "pending" };
  }
}

function setup(nCreators: number, opts: { lamports?: bigint[]; vaultCount?: number; seed?: number } = {}) {
  const dir = new CreatorDirectory(SEED, nCreators);
  const targets: FeeTarget[] = Array.from({ length: nCreators }, (_, i) => ({
    venue: "pumpfun",
    kind: "creator",
    mint: Keypair.generate().publicKey.toBase58(),
    authority: Keypair.fromSeed(new Uint8Array(32).fill(0)).publicKey.toBase58(), // replaced below
    lamports: opts.lamports?.[i] ?? 10_000_000n,
    lockedRent: 0n,
    frontLamports: 0n,
  }));
  // authority i = creator index i
  targets.forEach((t, i) => (t.authority = deriveCreatorKeypair(SEED, i).publicKey.toBase58()));
  const inv = new FakeInventory();
  const vaultKeys = makeVaults(opts.vaultCount ?? 3, inv);
  const rng = seededRng(opts.seed ?? 1);
  const store = new MemoryFeeSweepStore();
  const chain = new FakeSweepChain(store);
  let clock = 1_000;
  const sweeper = new FeeSweeper({
    network: "devnet",
    venues: [new FakeVenue(targets, dir)],
    pool: new VaultPool(vaultKeys, inv, rng),
    chain,
    store,
    rng,
    price: fixedPrice(1_000),
    tipLamports: 0n,
    sleep: async () => undefined,
    now: () => ++clock,
  });
  return { dir, targets, chain, store, sweeper, vaultKeys };
}

describe("fee sweep: one creator per transaction (H7)", () => {
  it("sends exactly one tx per target, each signed by one vault and one authority", async () => {
    const { chain, targets, sweeper } = setup(8);
    const r = await sweeper.runOnce();
    expect(r.confirmed).toBe(8);
    expect(chain.sent).toHaveLength(8);
    const authorities = chain.sent.map((s) => s.signers[1]);
    expect(new Set(authorities).size).toBe(8);
    expect(new Set(authorities)).toEqual(new Set(targets.map((t) => t.authority)));
    for (const s of chain.sent) {
      const ixSigners = new Set(s.ixs.flatMap((ix) => ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())));
      for (const k of ixSigners) expect([s.payer, s.signers[1]]).toContain(k);
    }
  });

  it("refuses instructions that need a second authority", () => {
    const vault = Keypair.generate().publicKey;
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    const ixs = [
      SystemProgram.transfer({ fromPubkey: a, toPubkey: vault, lamports: 1 }),
      SystemProgram.transfer({ fromPubkey: b, toPubkey: vault, lamports: 1 }),
    ];
    expect(() => assertSingleAuthority(ixs, vault, a)).toThrow(/H7/);
    expect(() => assertSingleAuthority(ixs.slice(0, 1), vault, a)).not.toThrow();
  });

  it("real pump builder: only vault + creator sign, creator ends at 0", async () => {
    const vault = Keypair.generate().publicKey;
    const creator = Keypair.generate().publicKey;
    const state = pumpFeeState({ creatorFee: new BN(50_000) }, { lamports: 890_880 + 40_000, data: Buffer.alloc(0) }, 890_880n, 0n);
    const ixs = await pumpFeeInstructions({ mint: Keypair.generate().publicKey, creator, quoteMint: PublicKey.default, vault, state });
    assertSingleAuthority(ixs, vault, creator);
    // sweep, loan, collect, return
    expect(ixs).toHaveLength(4);
    expect(pumpTransferAmount(state)).toBe(90_000n);
    expect(state.topUp).toBe(890_880n);
    expect(pumpReturnAmount(state)).toBe(90_000n + 890_880n); // loan + fees: wallet 0 -> 0
  });

  it("real DBC builder: only vault + authority sign, temp accounts closed to the vault", async () => {
    const vault = Keypair.generate().publicKey;
    const creator = Keypair.generate().publicKey;
    const ixs = await dbcFeeInstructions({
      kind: "creator",
      pool: Keypair.generate().publicKey,
      state: { baseMint: Keypair.generate().publicKey, baseVault: Keypair.generate().publicKey, quoteVault: Keypair.generate().publicKey, config: Keypair.generate().publicKey },
      config: { tokenType: 1, quoteMint: NATIVE_MINT, quoteTokenFlag: 0 },
      authority: creator,
      vault,
      quoteAmount: 123n,
    });
    assertSingleAuthority(ixs, vault, creator);
    expect(ixs).toHaveLength(5);
    const closes = ixs.slice(3);
    for (const c of closes) {
      expect([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]).toContain(c.programId.toBase58());
      expect(c.keys[1]!.pubkey.equals(vault)).toBe(true); // destination
    }
  });
});

describe("fee sweep: random order", () => {
  it("order differs between runs and from discovery order; every target once", async () => {
    const orders = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) {
      const { chain, targets, sweeper } = setup(6, { seed });
      await sweeper.runOnce();
      const order = chain.sent.map((s) => s.signers[1]!);
      expect([...order].sort()).toEqual(targets.map((t) => t.authority).sort());
      orders.add(order.join(","));
    }
    expect(orders.size).toBeGreaterThan(8);
  });
});

describe("fee sweep: threshold", () => {
  it("is strictly above the tx cost even with a zero policy", () => {
    const cost = feeTxCost({ signatures: 2, computeUnits: 120_000, microLamportsPerCu: 1_000_000, tipLamports: 5_000n });
    expect(cost).toBe(10_000n + 120_000n + 5_000n);
    expect(sweepThreshold(cost, 0n, { minLamports: 0n, costMultiple: 0n })).toBe(cost + 1n);
    expect(sweepThreshold(cost, 890_880n, { minLamports: 0n, costMultiple: 1n })).toBe(cost + 890_880n + 1n);
    expect(sweepThreshold(cost, 0n, DEFAULT_THRESHOLD)).toBe(DEFAULT_THRESHOLD.minLamports);
  });

  it("skips targets below the threshold", async () => {
    const { chain, sweeper, targets } = setup(4, { lamports: [10_000_000n, 1_000n, 2_000_000n, 1_999_999n] });
    const r = await sweeper.runOnce();
    expect(r.belowThreshold).toBe(2);
    expect(chain.sent.map((s) => s.signers[1]).sort()).toEqual([targets[0]!.authority, targets[2]!.authority].sort());
  });
});

describe("fee sweep: vault rotation", () => {
  it("never lands two consecutive sweeps on the same vault and uses every vault", async () => {
    const { chain, sweeper, vaultKeys } = setup(30, { vaultCount: 3 });
    await sweeper.runOnce();
    const payers = chain.sent.map((s) => s.payer);
    for (let i = 1; i < payers.length; i++) expect(payers[i]).not.toBe(payers[i - 1]);
    expect(new Set(payers)).toEqual(new Set(vaultKeys.map((v) => v.publicKey.toBase58())));
  });
});

describe("fee sweep: bookkeeping", () => {
  it("records per mint; unknown outcome stays 'sent' and is resolved next run", async () => {
    const { chain, sweeper, store, targets } = setup(2);
    chain.submitFails = true;
    const r1 = await sweeper.runOnce();
    expect(r1.failed).toBe(2);
    expect(store.rows.every((x) => x.status === "sent")).toBe(true);
    // one landed (unreadable amount -> left alone), one expired -> failed
    chain.states.set(store.rows[0]!.signature, { state: "landed", slot: 5, err: null });
    chain.states.set(store.rows[1]!.signature, { state: "expired" });
    const n = await sweeper.resolvePending();
    expect(n).toBe(1);
    expect(store.rows[0]!.status).toBe("sent");
    expect(store.rows[1]!.status).toBe("failed");

    chain.submitFails = false;
    const r2 = await sweeper.runOnce();
    expect(r2.confirmed).toBe(2);
    const totals = await store.totals("devnet");
    expect(totals.map((t) => t.mint).sort()).toEqual(targets.map((t) => t.mint).sort());
    expect(totals.every((t) => t.lamports === 10_000_000n)).toBe(true);
  });

  it("schedule: 6-12 h between runs", () => {
    const rng = seededRng(3);
    for (let i = 0; i < 200; i++) {
      const d = nextSweepDelay(rng);
      expect(d).toBeGreaterThanOrEqual(DEFAULT_SWEEP_SCHEDULE.intervalMinMs);
      expect(d).toBeLessThanOrEqual(DEFAULT_SWEEP_SCHEDULE.intervalMaxMs);
    }
  });

  it("creator directory derives the relayer's creator addresses", () => {
      const dir = new CreatorDirectory(SEED, 3);
    expect(dir.has(deriveCreatorKeypair(SEED, 2).publicKey.toBase58())).toBe(true);
    expect(dir.missing([deriveCreatorKeypair(SEED, 3).publicKey.toBase58()])).toHaveLength(1);
  });
});
