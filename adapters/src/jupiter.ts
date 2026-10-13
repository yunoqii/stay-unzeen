import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Connection,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getTokenMetadata,
} from "@solana/spl-token";
import { AdapterError, classifyError, type AdapterErrorCode, type ProgramErrorInfo } from "./errors";
import { lamportDelta, tokenDelta } from "./events";
import { fixedPrice, type PriorityPrice } from "./fees";
import { formatUnits } from "./math";
import type { PreparedCreate, PreparedTrade } from "./pumpfun";
import { SENDER_TIP_ACCOUNTS, type TxPipeline } from "./sender";
import { SendGate, broadcastAndConfirm, fetchTx, isSendFailure, signTx, type SendFailure, type SignedTx } from "./tx";
import type { CreateOptions, CurveStatus, TokenMeta, TradeOptions, TxResult } from "./types";

/**
 * Jupiter venue (`venue: "jupiter"`): buy/sell of tokens that already trade
 * somewhere Jupiter routes (graduated pump.fun -> PumpSwap, DBC -> DAMM v2,
 * other DBC / LaunchLab curves). Mainnet only (Jupiter has no devnet).
 *
 * API: Swap V2 Router `GET https://api.jup.ag/swap/v2/build` (checked
 * 2026-10-12: answers keyless; `x-api-key` from `JUPITER_API_KEY` when set).
 * It returns raw instructions; the transaction is built, signed and sent by OUR
 * pipeline, exactly like every other pool tx:
 * - the pool prefix (compute limit, the ONE pool-wide compute unit price, the
 *   same Sender tip on mainnet); Jupiter's own compute budget instructions are
 *   dropped, no `tipAmount` / `computeUnitPricePercentile` is ever requested;
 * - sent through the pool broadcaster (Helius Sender on mainnet), never `/execute`
 *   or Jupiter's landing service.
 *
 * Privacy:
 * - Jupiter sees vault + mint + amount at the moment of the action. A build is
 *   requested ONLY while executing a relayer job (inside its epoch / now slot),
 *   never for a user quote, a page view or a price: this module has no quote API.
 * - Nothing is logged; errors carry no URL / key / address.
 *
 * Safety (the API is a third party): every returned instruction is checked
 * against an allowlist (Jupiter v6 swap, ATA create, wSOL wrap/sync/close of the
 * vault's own accounts) before signing, and the signed tx is simulated on the
 * send-side RPC: the vault must get >= minOut and lose no more than the trade
 * plus fees / rent, otherwise nothing is sent.
 */

export const JUPITER_PROGRAM_ID = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
export const DEFAULT_JUPITER_URL = "https://api.jup.ag/swap/v2";
/** Keyless: 0.5 rps (docs 2026-10-12) -> one request per 2 s; with a key (Free plan 1 rps) 1 s. */
export const JUPITER_KEYLESS_INTERVAL_MS = 2_000;
export const JUPITER_KEY_INTERVAL_MS = 1_000;
/** Fixed compute limit of Jupiter swaps (routes are capped by maxAccounts). */
export const JUPITER_CU = 700_000;
/** Leaves room in the v0 message for our prefix (tip account) and the ATA creates. */
export const JUPITER_MAX_ACCOUNTS = 48;
/** First build's slippage; rebuilt with the exact tolerance if core's minOut needs it. */
export const JUPITER_DEFAULT_SLIPPAGE_BPS = 300;
/** Token-2022 ATA with extensions, rounded up (rent a buy may pay for the vault's new ATA). */
const ATA_RENT_ALLOWANCE = 2_500_000n;
const SIGNATURE_FEE = 5_000n;

/** Jupiter v6 program errors (IDL) and names of venue programs it routes through. */
export const JUPITER_ERRORS: readonly ProgramErrorInfo[] = [
  { code: 6000, name: "EmptyRoute" },
  { code: 6001, name: "SlippageToleranceExceeded" },
  { code: 6002, name: "InvalidCalculation" },
  { code: 6008, name: "NotEnoughAccountKeys" },
  { code: 6014, name: "IncorrectTokenProgramID" },
];
export const JUPITER_ERROR_BY_NAME: Readonly<Record<string, AdapterErrorCode>> = {
  SlippageToleranceExceeded: "slippage",
  ExceededSlippage: "slippage", // PumpSwap, Meteora DBC / DAMM v2
  TooMuchSolRequired: "slippage",
  TooLittleSolReceived: "slippage",
  EmptyRoute: "not_found",
  NotEnoughAccountKeys: "venue_unavailable",
};

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

export interface JupiterIx {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string; // base64
}

/** The fields of `/swap/v2/build` this adapter uses (everything else is ignored). */
export interface JupiterBuild {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  routePlan: { swapInfo?: { label?: string } }[];
  computeBudgetInstructions: JupiterIx[];
  setupInstructions: JupiterIx[];
  swapInstruction: JupiterIx;
  cleanupInstruction: JupiterIx | null;
  otherInstructions: JupiterIx[];
  tipInstruction: JupiterIx | null;
  tokenLedgerInstruction?: JupiterIx | null;
  addressesByLookupTableAddress: Record<string, string[]>;
}

export interface BuildRequest {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  taker: string;
  slippageBps: number;
}

export interface JupiterClientOptions {
  baseUrl?: string;
  /** `x-api-key`; empty = keyless (0.5 rps). Never logged, never in a message. */
  apiKey?: string | null;
  /** Min interval between requests of this process (default by key presence). */
  minIntervalMs?: number;
  maxAccounts?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  gate?: SendGate;
}

/**
 * Rate-limited `/build` client. All requests of the process go through one FIFO
 * gate (0.5 rps keyless / 1 rps with a key), so a burst of jobs in one epoch
 * queues instead of hitting 429.
 */
export class JupiterClient {
  readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly gate: SendGate;
  private readonly maxAccounts: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(o: JupiterClientOptions = {}) {
    this.baseUrl = (o.baseUrl ?? DEFAULT_JUPITER_URL).replace(/\/+$/, "");
    this.apiKey = o.apiKey?.trim() || null;
    this.gate = o.gate ?? new SendGate(o.minIntervalMs ?? (this.apiKey ? JUPITER_KEY_INTERVAL_MS : JUPITER_KEYLESS_INTERVAL_MS));
    this.maxAccounts = o.maxAccounts ?? JUPITER_MAX_ACCOUNTS;
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  get keyed(): boolean {
    return this.apiKey !== null;
  }

  /** Exact URL of a build request (exported for tests: no fee / tip parameters, ever). */
  buildUrl(r: BuildRequest): string {
    if (!Number.isInteger(r.slippageBps) || r.slippageBps < 0 || r.slippageBps > 10_000) throw new RangeError("bad slippageBps");
    if (r.amount <= 0n) throw new RangeError("amount must be > 0");
    const q = new URLSearchParams({
      inputMint: r.inputMint,
      outputMint: r.outputMint,
      amount: r.amount.toString(10),
      taker: r.taker,
      slippageBps: String(r.slippageBps),
      maxAccounts: String(this.maxAccounts),
      wrapAndUnwrapSol: "true",
    });
    return `${this.baseUrl}/build?${q.toString()}`;
  }

  async build(r: BuildRequest): Promise<JupiterBuild> {
    const url = this.buildUrl(r);
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    let res: Response;
    try {
      res = await this.gate.run(() => this.fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(this.timeoutMs) }));
    } catch {
      throw new AdapterError("venue_unavailable", "jupiter request failed");
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) throw jupiterHttpError(res.status, body);
    return parseBuild(body);
  }
}

/** HTTP status / error body -> AdapterError (status and a short error code only). */
export function jupiterHttpError(status: number, body: unknown): AdapterError {
  const b = (body ?? {}) as { error?: unknown; errorCode?: unknown; message?: unknown };
  const text = [b.errorCode, b.error, b.message].filter((x) => typeof x === "string").join(" ");
  if (status === 429 || status >= 500) return new AdapterError("venue_unavailable", `jupiter HTTP ${status}`);
  if (/no route|could not find any route|route not found|not tradable|TOKEN_NOT_TRADABLE|COULD_NOT_FIND_ANY_ROUTE|NO_ROUTES_FOUND/i.test(text)) {
    return new AdapterError("not_found", "jupiter: no route for this mint");
  }
  if (status === 401 || status === 403) return new AdapterError("venue_unavailable", `jupiter HTTP ${status} (api key)`);
  return new AdapterError("venue_unavailable", `jupiter HTTP ${status}`);
}

function isIx(x: unknown): x is JupiterIx {
  const i = x as JupiterIx;
  return (
    typeof i === "object" &&
    i !== null &&
    typeof i.programId === "string" &&
    typeof i.data === "string" &&
    Array.isArray(i.accounts) &&
    i.accounts.every((a) => typeof a?.pubkey === "string" && typeof a.isSigner === "boolean" && typeof a.isWritable === "boolean")
  );
}

/** Shape check of a `/build` answer; anything unexpected -> venue_unavailable (nothing signed). */
export function parseBuild(body: unknown): JupiterBuild {
  const b = body as Partial<JupiterBuild> & { error?: unknown };
  const bad = (what: string) => new AdapterError("venue_unavailable", `jupiter: malformed build (${what})`);
  if (!b || typeof b !== "object") throw bad("body");
  if (typeof b.error === "string") throw jupiterHttpError(400, b);
  for (const k of ["inputMint", "outputMint", "inAmount", "outAmount", "otherAmountThreshold", "swapMode"] as const) {
    if (typeof b[k] !== "string") throw bad(k);
  }
  for (const k of ["inAmount", "outAmount", "otherAmountThreshold"] as const) {
    if (!/^\d+$/.test(b[k] as string)) throw bad(k);
  }
  if (!isIx(b.swapInstruction)) throw bad("swapInstruction");
  const list = (v: unknown, k: string): JupiterIx[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || !v.every(isIx)) throw bad(k);
    return v;
  };
  const opt = (v: unknown, k: string): JupiterIx | null => {
    if (v === undefined || v === null) return null;
    if (!isIx(v)) throw bad(k);
    return v;
  };
  const alts = b.addressesByLookupTableAddress ?? {};
  if (typeof alts !== "object" || alts === null) throw bad("addressesByLookupTableAddress");
  return {
    inputMint: b.inputMint!,
    outputMint: b.outputMint!,
    inAmount: b.inAmount!,
    outAmount: b.outAmount!,
    otherAmountThreshold: b.otherAmountThreshold!,
    swapMode: b.swapMode!,
    slippageBps: typeof b.slippageBps === "number" ? b.slippageBps : -1,
    routePlan: Array.isArray(b.routePlan) ? b.routePlan : [],
    computeBudgetInstructions: list(b.computeBudgetInstructions, "computeBudgetInstructions"),
    setupInstructions: list(b.setupInstructions, "setupInstructions"),
    swapInstruction: b.swapInstruction,
    cleanupInstruction: opt(b.cleanupInstruction, "cleanupInstruction"),
    otherInstructions: list(b.otherInstructions, "otherInstructions"),
    tipInstruction: opt(b.tipInstruction, "tipInstruction"),
    tokenLedgerInstruction: opt(b.tokenLedgerInstruction, "tokenLedgerInstruction"),
    addressesByLookupTableAddress: alts as Record<string, string[]>,
  };
}

// ---------------------------------------------------------------------------
// instruction allowlist (pure)
// ---------------------------------------------------------------------------

export interface CheckContext {
  side: "buy" | "sell";
  taker: PublicKey;
  mint: PublicKey;
  /** buy: lamports in; sell: token base units in. */
  amountIn: bigint;
  minOut: bigint;
}

const SYSTEM_TRANSFER = 2;
const TOKEN_SYNC_NATIVE = 17;
const TOKEN_CLOSE_ACCOUNT = 9;

function toIx(i: JupiterIx): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(i.programId),
    keys: i.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(i.data, "base64"),
  });
}

/**
 * Checks a build against the job and returns the instructions to sign, in
 * order: setup, swap, cleanup. Jupiter's compute budget is dropped (the pool
 * prefix sets limit and the pool-wide price); a tip, token-ledger or "other"
 * instruction is refused (our pipeline tips; nothing else may move vault funds).
 * Throws AdapterError: `slippage` when the route cannot give minOut,
 * `venue_unavailable` for anything unexpected (nothing is signed).
 */
export function checkBuild(b: JupiterBuild, c: CheckContext): TransactionInstruction[] {
  const refuse = (why: string) => new AdapterError("venue_unavailable", `jupiter build refused: ${why}`);
  const sol = NATIVE_MINT.toBase58();
  const mint = c.mint.toBase58();
  const [inMint, outMint] = c.side === "buy" ? [sol, mint] : [mint, sol];
  if (b.inputMint !== inMint || b.outputMint !== outMint) throw refuse("mints");
  if (b.swapMode !== "ExactIn") throw refuse("swap mode");
  if (BigInt(b.inAmount) !== c.amountIn) throw refuse("amount in");
  if (BigInt(b.outAmount) < c.minOut) throw new AdapterError("slippage", "jupiter route gives less than minOut");
  // The route moved between builds: its own floor would accept less than core allows.
  if (BigInt(b.otherAmountThreshold) < c.minOut) throw new AdapterError("slippage", "jupiter threshold below minOut");
  if (b.tipInstruction) throw refuse("tip instruction");
  if (b.tokenLedgerInstruction) throw refuse("token ledger");
  if (b.otherInstructions.length > 0) throw refuse("other instructions");
  for (const i of b.computeBudgetInstructions) {
    if (i.programId !== ComputeBudgetProgram.programId.toBase58()) throw refuse("compute budget program");
  }

  const taker = c.taker.toBase58();
  const wsolAtas = new Set([
    getAssociatedTokenAddressSync(NATIVE_MINT, c.taker, false, TOKEN_PROGRAM_ID).toBase58(),
  ]);
  const signerOk = (i: JupiterIx) => i.accounts.every((a) => !a.isSigner || a.pubkey === taker);
  const data = (i: JupiterIx) => Buffer.from(i.data, "base64");

  let wrapped = 0n;
  for (const i of b.setupInstructions) {
    if (!signerOk(i)) throw refuse("foreign signer");
    const d = data(i);
    if (i.programId === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()) {
      // create / create_idempotent: [payer, ata, owner, mint, system, token program]; the vault pays, for itself.
      if (d.length > 1 || (d.length === 1 && d[0] !== 0 && d[0] !== 1)) throw refuse("ata instruction");
      if (i.accounts[0]?.pubkey !== taker || i.accounts[2]?.pubkey !== taker) throw refuse("ata owner");
      const m = i.accounts[3]?.pubkey;
      if (m !== mint && m !== sol) throw refuse("ata mint");
      continue;
    }
    if (i.programId === SystemProgram.programId.toBase58()) {
      // wSOL wrap: transfer from the vault to its own wSOL ATA, at most the buy amount.
      if (d.length !== 12 || d.readUInt32LE(0) !== SYSTEM_TRANSFER) throw refuse("system instruction");
      if (i.accounts[0]?.pubkey !== taker || !wsolAtas.has(i.accounts[1]?.pubkey ?? "")) throw refuse("system transfer target");
      wrapped += d.readBigUInt64LE(4);
      continue;
    }
    if (i.programId === TOKEN_PROGRAM_ID.toBase58()) {
      if (d.length !== 1 || d[0] !== TOKEN_SYNC_NATIVE || !wsolAtas.has(i.accounts[0]?.pubkey ?? "")) throw refuse("token setup instruction");
      continue;
    }
    throw refuse("setup program");
  }
  if (wrapped > (c.side === "buy" ? c.amountIn : 0n)) throw refuse("wrap amount");

  if (b.swapInstruction.programId !== JUPITER_PROGRAM_ID.toBase58()) throw refuse("swap program");
  if (!signerOk(b.swapInstruction)) throw refuse("foreign signer");

  const out: TransactionInstruction[] = [...b.setupInstructions.map(toIx), toIx(b.swapInstruction)];
  const cl = b.cleanupInstruction;
  if (cl) {
    // close the vault's wSOL ATA back to the vault (unwrap)
    const d = data(cl);
    const ok =
      (cl.programId === TOKEN_PROGRAM_ID.toBase58() || cl.programId === TOKEN_2022_PROGRAM_ID.toBase58()) &&
      d.length === 1 &&
      d[0] === TOKEN_CLOSE_ACCOUNT &&
      wsolAtas.has(cl.accounts[0]?.pubkey ?? "") &&
      cl.accounts[1]?.pubkey === taker &&
      cl.accounts[2]?.pubkey === taker &&
      signerOk(cl);
    if (!ok) throw refuse("cleanup instruction");
    out.push(toIx(cl));
  }
  return out;
}

/** Slippage that makes Jupiter's threshold >= minOut for a route giving `out` (rounded down). */
export function slippageForMinOut(out: bigint, minOut: bigint): number {
  if (out <= 0n || minOut > out) return 0;
  return Number(((out - minOut) * 10_000n) / out);
}

/** "curve" when the route trades on a bonding curve (pump.fun / DBC / LaunchLab ...), else "graduated". */
export function routeStatus(b: Pick<JupiterBuild, "routePlan">): CurveStatus {
  const labels = b.routePlan.map((h) => h.swapInfo?.label ?? "");
  const curve = labels.some((l) => /^pump\.fun$|bonding curve|launchlab|moonit|boop/i.test(l.trim()));
  return curve ? "curve" : "graduated";
}

// ---------------------------------------------------------------------------
// executed amounts (pure)
// ---------------------------------------------------------------------------

/**
 * Vault-side facts of a landed swap, from balances only (V2 instructions emit
 * no swap event):
 * - token amount = |token delta| of the vault for the mint;
 * - SOL of the trade = vault lamport delta + network fee + Sender tip (lamports
 *   gained by tip accounts) + rent of accounts created in the tx (vault's ATA):
 *   buy -> paid (negated), sell -> received. Network fee and rent excluded,
 *   venue fees included (RELAYER.md "out_lamports").
 */
export function swapAmounts(
  tx: VersionedTransactionResponse,
  side: "buy" | "sell",
  vault: PublicKey,
  mint: PublicKey,
): { tokenAmount: bigint; solAmount: bigint; networkFee: bigint; decimals: number | null } {
  const fee = BigInt(tx.meta?.fee ?? 0);
  const keys = tx.transaction.message.getAccountKeys(tx.meta?.loadedAddresses ? { accountKeysFromLookups: tx.meta.loadedAddresses } : undefined);
  const tips = new Set(SENDER_TIP_ACCOUNTS);
  const v = vault.toBase58();
  let tip = 0n;
  let rent = 0n;
  for (let i = 0; i < keys.length; i++) {
    const k = keys.get(i)?.toBase58();
    if (!k || k === v) continue;
    const pre = BigInt(tx.meta?.preBalances[i] ?? 0);
    const post = BigInt(tx.meta?.postBalances[i] ?? 0);
    if (tips.has(k)) tip += post - pre;
    else if (pre === 0n && post > 0n) rent += post; // created in this tx, funded by the payer
  }
  const flow = lamportDelta(tx, vault) + fee + tip + rent;
  const td = tokenDelta(tx, vault, mint);
  const m = mint.toBase58();
  const bal = [...(tx.meta?.postTokenBalances ?? []), ...(tx.meta?.preTokenBalances ?? [])].find((b) => b.owner === v && b.mint === m);
  return {
    tokenAmount: td < 0n ? -td : td,
    solAmount: side === "buy" ? (flow < 0n ? -flow : 0n) : flow > 0n ? flow : 0n,
    networkFee: fee,
    decimals: bal ? bal.uiTokenAmount.decimals : null,
  };
}

/** Public price / market cap from an executed fill (SOL per whole token, decimal strings). */
export function fillMarket(solAmount: bigint, tokenAmount: bigint, decimals: number, supply: bigint): { priceSol: string; marketCapSol: string } {
  if (tokenAmount <= 0n) throw new RangeError("empty fill");
  const p18 = (solAmount * 10n ** BigInt(decimals) * 10n ** 9n) / tokenAmount; // SOL * 1e18 per whole token
  const mcLamports = (solAmount * supply) / tokenAmount;
  return { priceSol: formatUnits(p18, 18), marketCapSol: formatUnits(mcLamports, 9) };
}

// ---------------------------------------------------------------------------
// adapter
// ---------------------------------------------------------------------------

export interface JupiterAdapterOptions {
  connection: Connection;
  cluster: string;
  client: JupiterClient;
  /** Pool-wide compute unit price (the same cache as every other builder). */
  priorityMicroLamports?: number | PriorityPrice;
  pipeline?: TxPipeline | null;
  computeUnits?: number;
  slippageBps?: number;
  /** Simulation guard on the send-side RPC (default on). Tests may turn it off. */
  simulate?: boolean;
  now?: () => number;
}

interface Fill {
  solAmount: bigint;
  tokenAmount: bigint;
  decimals: number;
  status: CurveStatus | null;
}

export class JupiterAdapter {
  readonly id = "jupiter" as const;
  private readonly connection: Connection;
  private readonly mainnet: boolean;
  private readonly client: JupiterClient;
  private readonly priority: PriorityPrice;
  private readonly pipeline: TxPipeline | null;
  private readonly cu: number;
  private readonly slippageBps: number;
  private readonly simulate: boolean;
  private readonly now: () => number;
  private readonly alts = new Map<string, { at: number; acc: AddressLookupTableAccount }>();
  /** signature -> curve status of its route (feed `tokens.status`; lost on restart = no tokens update). */
  private readonly routeOf = new Map<string, CurveStatus>();
  /** mint -> last executed fill (feeds `market()` right after `tradeResult`; no Jupiter call). */
  private readonly lastFill = new Map<string, Fill>();

  constructor(o: JupiterAdapterOptions) {
    this.connection = o.connection;
    this.mainnet = o.cluster === "mainnet-beta";
    this.client = o.client;
    const p = o.priorityMicroLamports ?? 0;
    this.priority = typeof p === "number" ? fixedPrice(p) : p;
    this.pipeline = o.pipeline ?? null;
    this.cu = o.computeUnits ?? JUPITER_CU;
    this.slippageBps = o.slippageBps ?? JUPITER_DEFAULT_SLIPPAGE_BPS;
    this.simulate = o.simulate ?? true;
    this.now = o.now ?? Date.now;
  }

  async prepareBuy(mint: string, lamportsIn: bigint, minOut: bigint, opts: TradeOptions = {}): Promise<PreparedTrade> {
    return this.prepare("buy", mint, lamportsIn, minOut, opts);
  }

  async prepareSell(mint: string, amount: bigint, minLamports: bigint, opts: TradeOptions = {}): Promise<PreparedTrade> {
    return this.prepare("sell", mint, amount, minLamports, opts);
  }

  /** Jupiter only trades existing tokens; create goes to pump.fun / Meteora DBC. */
  async prepareCreate(_meta: TokenMeta, _lamportsIn: bigint, _minOut: bigint, _opts?: CreateOptions): Promise<PreparedCreate> {
    throw new AdapterError("bad_request", "create is not available on venue jupiter");
  }

  async createResult(): Promise<null> {
    return null;
  }

  async submit(tx: SignedTx): Promise<{ signature: string; slot: number }> {
    try {
      return await broadcastAndConfirm(this.connection, tx, this.pipeline?.broadcaster);
    } catch (e) {
      throw this.sendError(e);
    }
  }

  async tradeResult(kind: "buy" | "sell", signature: string, vault: string, mint: string): Promise<TxResult | null> {
    const tx = await fetchTx(this.connection, signature, 10).catch(() => null);
    if (!tx || tx.meta?.err) return null;
    const mk = parsePk(mint);
    const a = swapAmounts(tx, kind, new PublicKey(vault), mk);
    const decimals = a.decimals ?? (await this.decimals(mk));
    if (a.tokenAmount > 0n) {
      this.lastFill.set(mint, { solAmount: a.solAmount, tokenAmount: a.tokenAmount, decimals, status: this.routeOf.get(signature) ?? null });
    }
    this.routeOf.delete(signature);
    return {
      venue: this.id,
      kind,
      signature,
      slot: tx.slot,
      mint,
      vault,
      tokenAmount: a.tokenAmount,
      solAmount: a.solAmount,
      networkFee: a.networkFee,
      blockTime: tx.blockTime ?? null,
      decimals,
      amountsKnown: true,
      fromEvent: false,
    };
  }

  /**
   * Price / cap / status for the `tokens` row, from the fill just read by
   * `tradeResult` (public on-chain data) + the mint supply. Never asks Jupiter.
   */
  async market(mint: string): Promise<{ priceSol: string; marketCapSol: string; status: CurveStatus }> {
    const f = this.lastFill.get(mint);
    if (!f || f.status === null) throw new AdapterError("not_found", "no fill to price from");
    this.lastFill.delete(mint);
    const supply = BigInt((await this.connection.getTokenSupply(parsePk(mint), "confirmed")).value.amount);
    return { ...fillMarket(f.solAmount, f.tokenAmount, f.decimals, supply), status: f.status };
  }

  /** Token-2022 on-mint metadata symbol (graduated pump create_v2 mints); null otherwise. */
  async tokenSymbol(mint: string): Promise<string | null> {
    const pk = parsePk(mint);
    const info = await this.connection.getAccountInfo(pk, "confirmed").catch(() => null);
    if (!info?.owner.equals(TOKEN_2022_PROGRAM_ID)) return null;
    const md = await getTokenMetadata(this.connection, pk, "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null);
    return md?.symbol ?? null;
  }

  classify(err: unknown, logs: readonly string[] | null = null): AdapterError {
    if (err instanceof AdapterError) return err;
    const msg = err instanceof Error ? err.message : String(err);
    const text = `${msg}\n${(logs ?? []).join("\n")}`;
    if (/exceeded CUs meter|ComputationalBudgetExceeded|Transaction too large|encoding overruns/i.test(text)) {
      return new AdapterError("venue_unavailable", "jupiter route too heavy for one transaction", { cause: err });
    }
    return classifyError(err, logs, JUPITER_ERRORS, JUPITER_PROGRAM_ID.toBase58(), JUPITER_ERROR_BY_NAME, "jupiter");
  }

  // -------------------------------------------------------------------------

  private async prepare(side: "buy" | "sell", mintStr: string, amountIn: bigint, minOut: bigint, opts: TradeOptions): Promise<PreparedTrade> {
    if (!this.mainnet) throw new AdapterError("venue_unavailable", "jupiter is mainnet only");
    const vault = opts.vault;
    if (!vault) throw new AdapterError("bad_request", "jupiter needs the vault of the mint");
    if (amountIn <= 0n) throw new AdapterError("bad_request", "amount must be > 0");
    if (minOut < 0n) throw new AdapterError("bad_request", "minOut must be >= 0");
    const mint = parsePk(mintStr);
    if (mint.equals(NATIVE_MINT)) throw new AdapterError("bad_request", "not a token mint");
    const sol = NATIVE_MINT.toBase58();
    const req: BuildRequest = {
      inputMint: side === "buy" ? sol : mintStr,
      outputMint: side === "buy" ? mintStr : sol,
      amount: amountIn,
      taker: vault.publicKey.toBase58(),
      slippageBps: this.slippageBps,
    };
    let b = await this.client.build(req);
    const out = BigInt(b.outAmount);
    if (out < minOut) throw new AdapterError("slippage", "jupiter route gives less than minOut");
    if (BigInt(b.otherAmountThreshold) < minOut) {
      // Core's minOut is tighter than the default tolerance: rebuild with exactly what it allows.
      b = await this.client.build({ ...req, slippageBps: slippageForMinOut(out, minOut) });
    }
    const ctx: CheckContext = { side, taker: vault.publicKey, mint, amountIn, minOut };
    const ixs = checkBuild(b, ctx);
    const lookupTables = await this.lookupTables(Object.keys(b.addressesByLookupTableAddress));
    let tx: SignedTx;
    try {
      tx = await signTx(this.connection, ixs, vault, [], {
        computeUnits: this.cu,
        priorityMicroLamports: this.priority.microLamports(),
        tip: this.pipeline?.tip ?? null,
        lookupTables,
      });
    } catch (e) {
      throw this.sendError(e);
    }
    if (this.simulate) await this.guard(tx, ctx);
    this.routeOf.set(tx.signature, routeStatus(b));
    return { ...tx, kind: side, mint: mintStr, vault: vault.publicKey.toBase58(), expectedOut: BigInt(b.outAmount) };
  }

  /**
   * Simulates the signed tx on the send-side RPC (the provider that receives it
   * next anyway) and checks the vault's balances: buy -> tokens +>= minOut and
   * SOL -<= amountIn + fees + ATA rent; sell -> tokens -<= amount and SOL +>=
   * minOut - fees. Any failure = stage "preflight": nothing was sent.
   */
  private async guard(tx: SignedTx, c: CheckContext): Promise<void> {
    const pre = await this.vaultBalances(c);
    let sim;
    try {
      sim = await this.connection.simulateTransaction(VersionedTransaction.deserialize(tx.raw), {
        sigVerify: false,
        commitment: "confirmed",
        accounts: { encoding: "base64", addresses: [c.taker.toBase58(), pre.ata.toBase58()] },
      });
    } catch (e) {
      throw new AdapterError("venue_unavailable", "simulation unavailable", { stage: "preflight", cause: e });
    }
    if (sim.value.err) {
      const ae = this.classify(new Error(`Transaction simulation failed: ${JSON.stringify(sim.value.err)}`), sim.value.logs ?? null);
      throw new AdapterError(ae.code, ae.message, { stage: "preflight", ...(ae.programError ? { programError: ae.programError } : {}) });
    }
    const [va, ta] = sim.value.accounts ?? [];
    if (!va) throw new AdapterError("venue_unavailable", "simulation returned no vault state", { stage: "preflight" });
    const lamports = BigInt(va.lamports) - pre.lamports;
    const tokens = tokenAmountOf(ta?.data[0] ? Buffer.from(ta.data[0], "base64") : null) - pre.tokens;
    const txCost = SIGNATURE_FEE + (BigInt(this.cu) * BigInt(this.priority.microLamports()) + 999_999n) / 1_000_000n + (this.pipeline?.tip?.lamports ?? 0n);
    const fail = (why: string) => new AdapterError("venue_unavailable", `jupiter guard: ${why}`, { stage: "preflight" });
    if (c.side === "buy") {
      if (tokens < c.minOut) throw new AdapterError("slippage", "simulated buy gives less than minOut", { stage: "preflight" });
      if (-lamports > c.amountIn + txCost + ATA_RENT_ALLOWANCE) throw fail("vault would pay more than the buy");
    } else {
      if (-tokens > c.amountIn) throw fail("vault would send more tokens than the sell");
      if (lamports + txCost < c.minOut) throw new AdapterError("slippage", "simulated sell gives less than minOut", { stage: "preflight" });
    }
  }

  private async vaultBalances(c: CheckContext): Promise<{ lamports: bigint; tokens: bigint; ata: PublicKey }> {
    const [mintAcc, vaultAcc] = await this.rpc(() => this.connection.getMultipleAccountsInfo([c.mint, c.taker], "confirmed"));
    if (!mintAcc) throw new AdapterError("not_found", "mint does not exist");
    const program = mintAcc.owner;
    if (!program.equals(TOKEN_PROGRAM_ID) && !program.equals(TOKEN_2022_PROGRAM_ID)) throw new AdapterError("not_found", "not an SPL mint");
    const ata = getAssociatedTokenAddressSync(c.mint, c.taker, false, program);
    const ataAcc = await this.rpc(() => this.connection.getAccountInfo(ata, "confirmed"));
    return { lamports: BigInt(vaultAcc?.lamports ?? 0), tokens: tokenAmountOf(ataAcc?.data ?? null), ata };
  }

  private async decimals(mint: PublicKey): Promise<number> {
    const info = await this.rpc(() => this.connection.getAccountInfo(mint, "confirmed"));
    if (!info || info.data.length < 45) throw new AdapterError("not_found", "mint does not exist");
    return info.data[44]!;
  }

  /** Jupiter's lookup tables, read from chain (never trusted from the API body), cached 10 min. */
  private async lookupTables(addresses: string[]): Promise<AddressLookupTableAccount[]> {
    const out: AddressLookupTableAccount[] = [];
    for (const a of addresses) {
      const hit = this.alts.get(a);
      if (hit && this.now() - hit.at < 10 * 60_000) {
        out.push(hit.acc);
        continue;
      }
      const r = await this.rpc(() => this.connection.getAddressLookupTable(parsePk(a)));
      if (!r.value) throw new AdapterError("venue_unavailable", "jupiter lookup table missing");
      this.alts.set(a, { at: this.now(), acc: r.value });
      out.push(r.value);
    }
    return out;
  }

  private async rpc<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof AdapterError) throw e;
      throw new AdapterError("venue_unavailable", "RPC error", { cause: e });
    }
  }

  private sendError(e: unknown): AdapterError {
    if (!isSendFailure(e)) return this.classify(e);
    const f: SendFailure = e;
    const err = this.classify(f.error, f.logs);
    return new AdapterError(err.code, err.message, {
      ...(err.programError ? { programError: err.programError } : {}),
      ...(f.signature ? { signature: f.signature } : {}),
      ...(f.stage ? { stage: f.stage } : {}),
      ...(f.landedErr ? { landedErr: true } : {}),
      cause: f.error,
    });
  }
}

/** SPL token account amount (u64 at offset 64; same for Token-2022). Missing account = 0. */
export function tokenAmountOf(data: Uint8Array | null): bigint {
  if (!data || data.length < 72) return 0n;
  return Buffer.from(data).readBigUInt64LE(64);
}

function parsePk(s: string): PublicKey {
  try {
    return new PublicKey(s);
  } catch {
    throw new AdapterError("bad_request", "bad address");
  }
}

/** Env of the Jupiter venue (JUPITER_API_KEY, JUPITER_API_URL, JUPITER_MIN_INTERVAL_MS, JUPITER_CU_LIMIT, JUPITER_SLIPPAGE_BPS). */
export function jupiterOptionsFromEnv(env: NodeJS.ProcessEnv): { client: JupiterClientOptions; computeUnits: number; slippageBps: number } {
  const int = (name: string, def: number, min: number, max: number): number => {
    const v = env[name]?.trim();
    if (!v) return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
    return n;
  };
  const apiKey = env.JUPITER_API_KEY?.trim() || null;
  const minIntervalMs = int("JUPITER_MIN_INTERVAL_MS", apiKey ? JUPITER_KEY_INTERVAL_MS : JUPITER_KEYLESS_INTERVAL_MS, 0, 60_000);
  return {
    client: {
      ...(env.JUPITER_API_URL?.trim() ? { baseUrl: env.JUPITER_API_URL.trim() } : {}),
      apiKey,
      // Never faster than the documented plan limit.
      minIntervalMs: Math.max(minIntervalMs, apiKey ? JUPITER_KEY_INTERVAL_MS : JUPITER_KEYLESS_INTERVAL_MS),
    },
    computeUnits: int("JUPITER_CU_LIMIT", JUPITER_CU, 200_000, 1_400_000),
    slippageBps: int("JUPITER_SLIPPAGE_BPS", JUPITER_DEFAULT_SLIPPAGE_BPS, 0, 5_000),
  };
}
