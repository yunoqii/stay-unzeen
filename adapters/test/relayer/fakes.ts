import { Keypair, PublicKey, type Signer } from "@solana/web3.js";
import { AdapterError } from "../../src/errors";
import type { Clock } from "../../src/relayer/engine";
import type { ChainProbe, JobExecutor } from "../../src/relayer/executors";
import type { Execution, JobSpec, SentAttempt } from "../../src/relayer/types";
import type { VaultInventory } from "../../src/relayer/vaults";
import type { SignatureState, SignedTx } from "../../src/tx";

/** A tiny simulated chain: block height advances with the fake clock. */
export class FakeChain implements ChainProbe {
  height = 1_000;
  /** signature -> landed (err null = success). */
  readonly landed = new Map<string, { err: unknown | null; slot: number }>();
  /** signatures only "processed" (not confirmed). */
  readonly processed = new Set<string>();
  rebroadcasts = 0;
  failProbe = 0;

  async state(signature: string, lvbh: number): Promise<SignatureState> {
    if (this.failProbe > 0) {
      this.failProbe--;
      throw new Error("fetch failed");
    }
    const l = this.landed.get(signature);
    if (l) return { state: "landed", slot: l.slot, err: l.err };
    if (this.processed.has(signature)) return { state: "pending" };
    return this.height > lvbh ? { state: "expired" } : { state: "pending" };
  }
  async rebroadcast(): Promise<void> {
    this.rebroadcasts++;
  }
  async logs(): Promise<string[] | null> {
    return ["Program log: AnchorError ... Error Code: TooMuchSolRequired. Error Number: 6002."];
  }
  land(signature: string, err: unknown | null = null): void {
    this.landed.set(signature, { err, slot: this.height });
  }
}

export class FakeClock implements Clock {
  constructor(
    public t = 1_700_000_000_000,
    private readonly chain?: FakeChain,
  ) {}
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
    // ~400 ms per block
    if (this.chain) this.chain.height += Math.ceil(ms / 400);
  }
}

export type SubmitBehavior =
  | "land" //                            broadcast, lands, confirm ok
  | "land-then-transport-error" //       lands on chain, but the client sees a transport error
  | "transport-error-dropped" //         client error, tx never lands (expires)
  | "preflight-slippage" //              rejected by simulation
  | "preflight-blockhash" //             rejected: blockhash not found (transient)
  | "landed-error"; //                   lands with a program error

/** Executor that records everything and acts per scripted behaviors. */
export class FakeExecutor implements JobExecutor {
  readonly prepared: { signature: string; vault: string }[] = [];
  readonly submitted: string[] = [];
  /** Checked when submit is called: sentRecorded(signature) must be true. */
  sentRecorded: (signature: string) => boolean = () => true;
  readonly orderViolations: string[] = [];
  behaviors: SubmitBehavior[] = [];
  unreadable = 0;
  prepareError: AdapterError | null = null;
  private n = 0;

  constructor(private readonly chain: FakeChain) {}

  vaultRequest(spec: JobSpec) {
    if (spec.kind === "withdraw" || spec.kind === "sell") return { minSol: 1n, mint: spec.mint, minTokens: spec.amount };
    if (spec.kind === "attest" || spec.kind === "fund_vaults") return { minSol: 0n };
    if (spec.kind === "consolidate") return { minSol: 1n, only: spec.from };
    if (spec.kind === "fund_quote") return { minSol: 1n, only: spec.vault };
    return { minSol: spec.lamportsIn };
  }

  async prepare(spec: JobSpec, vault: Signer): Promise<SignedTx & { mint?: string }> {
    if (this.prepareError) throw this.prepareError;
    const signature = `sig${++this.n}`;
    this.prepared.push({ signature, vault: vault.publicKey.toBase58() });
    const tx = { signature, raw: new Uint8Array([1, 2, 3]), blockhash: "bh", lastValidBlockHeight: this.chain.height + 150 };
    if (spec.kind === "fair_create") return { ...tx, mint: spec.mintKeypair.publicKey.toBase58() };
    return spec.kind === "create" ? { ...tx, mint: `NewMint${this.n}` } : tx;
  }

  async submit(tx: SignedTx): Promise<void> {
    if (!this.sentRecorded(tx.signature)) this.orderViolations.push(tx.signature);
    this.submitted.push(tx.signature);
    const b = this.behaviors.shift() ?? "land";
    switch (b) {
      case "land":
        this.chain.land(tx.signature);
        return;
      case "land-then-transport-error":
        this.chain.land(tx.signature);
        throw new AdapterError("venue_unavailable", "fetch failed", { stage: "confirm", signature: tx.signature });
      case "transport-error-dropped":
        throw new AdapterError("venue_unavailable", "ETIMEDOUT", { stage: "confirm", signature: tx.signature });
      case "preflight-slippage":
        throw new AdapterError("slippage", "sim", { stage: "preflight", signature: tx.signature });
      case "preflight-blockhash":
        throw new AdapterError("venue_unavailable", "Blockhash not found", {
          stage: "preflight",
          signature: tx.signature,
        });
      case "landed-error":
        this.chain.land(tx.signature, { InstructionError: [2, { Custom: 6002 }] });
        throw new AdapterError("slippage", "TooMuchSolRequired", {
          stage: "confirm",
          signature: tx.signature,
          landedErr: true,
        });
    }
  }

  async result(spec: JobSpec, a: SentAttempt): Promise<Execution | null> {
    if (this.unreadable > 0) {
      this.unreadable--;
      return null;
    }
    if (spec.kind === "withdraw") {
      return {
        kind: "withdraw",
        signature: a.signature,
        slot: 1,
        vault: a.vault,
        mint: spec.mint,
        to: spec.to,
        tokenAmount: spec.amount,
        gasDropLamports: 2_000_000n,
        networkFee: 5_000n,
        decimals: 6,
        blockTime: 1,
      };
    }
    if (spec.kind === "attest") {
      return { kind: "attest", signature: a.signature, slot: 1, vault: a.vault, memo: spec.memo, networkFee: 5_000n, blockTime: 1 };
    }
    if (spec.kind === "fund_vaults") {
      return { kind: "fund_vaults", signature: a.signature, slot: 1, vault: a.vault, lamports: spec.lamports, networkFee: 5_000n, blockTime: 1 };
    }
    if (spec.kind === "fund_quote") {
      return { kind: "fund_quote", signature: a.signature, slot: 1, vault: a.vault, quoteMint: "Q", quoteDelta: 5n, lamports: 9n, networkFee: 5_000n };
    }
    if (spec.kind === "consolidate") {
      return { kind: "consolidate", signature: a.signature, slot: 1, vault: a.vault, mint: spec.mint, to: spec.to, tokenAmount: 777n, networkFee: 5_000n };
    }
    if (spec.kind === "create" || spec.kind === "fair_create") {
      return {
        kind: "create",
        signature: a.signature,
        slot: 1,
        vault: a.vault,
        mint: spec.kind === "fair_create" ? spec.mintKeypair.publicKey.toBase58() : `NewMint${a.signature.slice(3)}`,
        creator: "Creator1111111111111111111111111111111111111",
        tokenAmount: 1_000n,
        solAmount: 50_000n,
        networkFee: 5_000n,
        decimals: 6,
        blockTime: 1,
        name: spec.meta.name,
        symbol: spec.meta.symbol,
        imageUrl: null,
        market: { priceSol: "0.00000003", marketCapSol: "30", status: "curve" },
      };
    }
    return {
      kind: spec.kind,
      signature: a.signature,
      slot: 1,
      vault: a.vault,
      mint: spec.mint,
      tokenAmount: 123n,
      solAmount: 456n,
      networkFee: 5_000n,
      decimals: 6,
      fromEvent: true,
      blockTime: 1,
      symbol: "UNZT",
      market: { priceSol: "0.000000001", marketCapSol: "1", status: "curve" },
    };
  }

  classify(err: unknown): AdapterError {
    if (err instanceof AdapterError) return err;
    const msg = err instanceof Error ? err.message : String(err);
    return new AdapterError(/6002|TooMuchSol/.test(msg) ? "slippage" : "internal", msg);
  }
}

/** Vault balances from a plain map. */
export class FakeInventory implements VaultInventory {
  readonly sol = new Map<string, bigint>();
  readonly tokens = new Map<string, bigint>();
  async solBalance(v: PublicKey): Promise<bigint> {
    return this.sol.get(v.toBase58()) ?? 0n;
  }
  async tokenBalance(v: PublicKey, mint: string): Promise<bigint> {
    return this.tokens.get(`${v.toBase58()}:${mint}`) ?? 0n;
  }
}

export function vaults(n: number, inv: FakeInventory, sol = 10n ** 10n): Keypair[] {
  const out = Array.from({ length: n }, () => Keypair.generate());
  for (const v of out) inv.sol.set(v.publicKey.toBase58(), sol);
  return out;
}

export const MINT = new PublicKey("So11111111111111111111111111111111111111112").toBase58();
