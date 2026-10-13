"use client";

import { ErrorState } from "@/components/ui/states";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { motion, useReducedMotion } from "motion/react";
import { ArrowClockwise, ArrowUpRight, LockSimple } from "@phosphor-icons/react";
import { api, ApiError, errorText } from "@/lib/api/client";
import type { CreatorToken, PoolInfo } from "@/lib/api/types";
import { lastRate, submitAction } from "@/lib/activity";
import { getSigner, useKeyState } from "@/lib/crypto/session";
import { useDisplay } from "@/lib/display-store";
import { formatCompact, formatSol, formatZec, lamportsToSol, unitsToNumber, VENUE_LABEL } from "@/lib/format";
import { useNetwork } from "@/lib/network";
import { canClaim as canClaimFees, claimAmount, minClaimZat } from "@/lib/claim";
import { cn } from "@/lib/utils";
import { usePool } from "@/hooks/use-pool";
import { useNow } from "@/hooks/use-now";
import { KeyGate } from "@/components/key/key-gate";
import { EmptyState } from "@/components/layout/page-shell";
import { PeekProvider, PeekToggle, Veiled, usePeek } from "@/components/portfolio/peek";
import { TokenGlyph } from "@/components/tokens/token-glyph";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

const EASE = [0.16, 1, 0.3, 1] as const;
const N0 = BigInt(0);
const when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

export function CreatorApp() {
  return (
    <KeyGate next="/creator">
      <PeekProvider>
        <Cabinet />
      </PeekProvider>
    </KeyGate>
  );
}

type Load = { s: "loading" } | { s: "error"; message: string } | { s: "ready"; tokens: CreatorToken[] };

/**
 * One signed GET /api/creator when the page opens (and on "Refresh" / after a claim), never polled.
 * The answer is padded to a fixed size, so it does not tell a creator from anyone else.
 */
function Cabinet() {
  const network = useNetwork();
  const key = useKeyState();
  const { pool } = usePool();
  const [load, setLoad] = useState<Load>({ s: "loading" });
  const [busy, setBusy] = useState(false);
  const pubkey = key.status === "unlocked" ? key.pubkey : null;

  const fetchCabinet = useCallback(async () => {
    const signer = getSigner(network);
    if (!signer) return;
    try {
      const c = await api.getCreator(signer);
      setLoad({ s: "ready", tokens: c.tokens });
    } catch (e) {
      setLoad({ s: "error", message: errorText(e) });
    }
  }, [network]);
  const refresh = async () => {
    setBusy(true);
    await fetchCabinet();
    setBusy(false);
  };

  useEffect(() => {
    const signer = pubkey ? getSigner(network) : null;
    if (!signer) return;
    let alive = true;
    api
      .getCreator(signer)
      .then((c) => alive && setLoad({ s: "ready", tokens: c.tokens }))
      .catch((e: unknown) => alive && setLoad({ s: "error", message: errorText(e) }));
    return () => {
      alive = false;
    };
  }, [pubkey, network]);

  if (load.s === "loading")
    return (
      <div aria-busy className="space-y-3">
        <Skeleton className="h-56 rounded-none bg-skeleton" />
      </div>
    );
  if (load.s === "error") return <ErrorState error={load.message} title="Could not load your launches" />;
  if (load.tokens.length === 0)
    return (
      <EmptyState art title="No launches from this key yet">
        <p>Tokens you launch through Unzeen show up here with their fees, volume and holders.</p>
        <Button asChild className="mt-5 h-10 rounded-full px-5">
          <Link href="/launch">Launch a token</Link>
        </Button>
      </EmptyState>
    );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {load.tokens.length} {load.tokens.length === 1 ? "launch" : "launches"} from this key
        </p>
        <div className="flex gap-2">
          <PeekToggle />
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border px-3 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
          >
            <ArrowClockwise size={13} weight="light" className={cn(busy && "animate-spin motion-reduce:animate-none")} aria-hidden />
            Refresh
          </button>
        </div>
      </div>
      <ul className="space-y-6">
        {load.tokens.map((t, i) => (
          <TokenCard key={t.mint} t={t} pool={pool} index={i} onClaimed={fetchCabinet} />
        ))}
      </ul>
      <p className="border-t border-border/60 pt-4 text-xs text-pretty text-faint-foreground">
        Fees are collected by the pool every 6–12 h, for every creator at once. Fees from your launch buy stay with the pool. Claiming credits ZEC inside the ledger,
        SOL fees at the pool’s sell rate and fees of ZEC pairs one to one: no on-chain transaction ties your launches together. Your position and lock are shown only here, never on the public token
        page.
      </p>
    </div>
  );
}

function TokenCard({ t, pool, index, onClaimed }: { t: CreatorToken; pool: PoolInfo | null; index: number; onClaimed: () => Promise<void> }) {
  const network = useNetwork();
  const display = useDisplay();
  const reduce = useReducedMotion();
  const now = useNow(60_000);
  const [claiming, setClaiming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const last = lastRate(network, "sell");
  const sellRate = pool?.rate ? BigInt(pool.rate.lamportsPerZecSell) : last ? BigInt(last.lamportsPerZec) : null;
  // v0.14: lamports (SOL / USDC / USD1 pairs) + zatoshis (ZEC pairs, 1:1); the minimum applies to the sum.
  const owed = claimAmount(t.fees.claimableLamports, t.fees.claimableZat, sellRate);
  const claimable = owed.lamports;
  const claimZat = owed.totalZat;
  const hasOwed = owed.lamports > N0 || owed.zat > N0;
  const canClaim = canClaimFees(owed, minClaimZat(pool));
  const claimedZat = /^\d+$/.test(t.fees.claimedZat ?? "") ? BigInt(t.fees.claimedZat!) : N0;
  const claimedLamports = /^\d+$/.test(t.fees.claimedLamports) ? BigInt(t.fees.claimedLamports) : N0;
  // A ZEC pair owes and pays in ZEC: lead with ZEC there, never with a SOL figure it does not have.
  const zecFirst = owed.zat > N0 || (owed.lamports === N0 && claimedZat > N0 && claimedLamports === N0);

  const cap = BigInt(t.cap.capTokens || "0");
  const pos = BigInt(t.cap.positionTokens || "0");
  const peek = usePeek();
  const capPct = cap > N0 ? Math.min(100, Number((pos * BigInt(10_000)) / cap) / 100) : 0;
  const locked = BigInt(t.lock.lockedAmount || "0");
  const tokens = (v: bigint) => formatCompact(unitsToNumber(v.toString(), t.decimals));

  const claim = async () => {
    setClaiming(true);
    setErr(null);
    try {
      await submitAction(network, { op: "claim", mint: t.mint }, { op: "claim", mint: t.mint, symbol: t.symbol, amount: (claimZat ?? N0).toString() });
      toast.success(`$${t.symbol} fees claimed`, { description: claimZat ? `≈ ${formatZec(claimZat.toString())} ZEC added to your balance.` : "Added to your ZEC balance." });
      await onClaimed();
    } catch (e) {
      setErr(e instanceof ApiError && e.code === "below_minimum" ? "Below the pool minimum for now. Let it build up." : errorText(e));
    } finally {
      setClaiming(false);
    }
  };

  return (
    <motion.li
      initial={reduce ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: Math.min(index, 6) * 0.05, ease: EASE }}
      className="ledger lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]"
    >
      <div className="flex flex-col justify-between gap-5 p-5 sm:p-6">
        <div className="flex items-start gap-4">
          <TokenGlyph symbol={t.symbol} image={t.image} className="size-12 shrink-0 rounded-xl text-xs" />
          <div className="min-w-0">
            <p className="truncate text-xl font-medium tracking-tight">${t.symbol}</p>
            <p className="truncate text-sm text-muted-foreground">{t.name}</p>
            <p className="mt-1 text-xs text-faint-foreground">
              {VENUE_LABEL[t.venue]} · {t.status === "graduated" ? "graduated" : t.curveProgressPct ? `curve ${t.curveProgressPct}%` : "on curve"}
              {t.createdAt !== null && ` · launched ${when.format(t.createdAt)}`}
            </p>
          </div>
        </div>
        <div>
          <p className="text-xs text-faint-foreground">Creator fees to claim</p>
          {zecFirst ? (
            <p className="tabular mt-1 text-3xl font-medium tracking-tight">
              <Veiled>{formatZec(owed.zat.toString())}</Veiled> <span className="text-base font-normal text-muted-foreground">ZEC</span>
            </p>
          ) : (
            <p className="tabular mt-1 text-3xl font-medium tracking-tight">
              <Veiled>{formatSol(lamportsToSol(claimable.toString()))}</Veiled> <span className="text-base font-normal text-muted-foreground">SOL</span>
            </p>
          )}
          {zecFirst && claimable > N0 && (
            <p className="tabular text-xs text-faint-foreground">
              + <Veiled>{formatSol(lamportsToSol(claimable.toString()))}</Veiled> SOL
            </p>
          )}
          {zecFirst && claimable === N0 ? (
            <p className="text-xs text-faint-foreground">Paid in ZEC, credited one to one. No SOL rate in between.</p>
          ) : (
            claimZat !== null &&
            claimable > N0 && (
              <p className="tabular text-xs text-faint-foreground">
                ≈ <Veiled>{formatZec(claimZat.toString())}</Veiled> ZEC {owed.zat > N0 ? "in total" : "at the pool’s sell rate"}
              </p>
            )
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button onClick={claim} disabled={!canClaim || claiming} className={cn("h-10 rounded-full px-5", claiming && "busy-hatch disabled:opacity-90")}>
              {claiming ? "Claiming…" : "Claim to balance"}
            </Button>
            <Link href={`/token/${t.mint}`} className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              Token page <ArrowUpRight size={12} aria-hidden />
            </Link>
          </div>
          {!canClaim && hasOwed && <p className="mt-2 text-xs text-faint-foreground">Below the pool minimum for now. It keeps building up.</p>}
          {err && (
            <p role="alert" className="mt-2 text-xs text-sell">
              {err}
            </p>
          )}
        </div>
      </div>

      <dl className="ledger-flat grid grid-cols-2 gap-px bg-border sm:grid-cols-3">
        {zecFirst ? (
          <Fact label="Claimed so far" value={<Veiled>{formatZec(claimedZat.toString())}</Veiled>} unit={claimedLamports > N0 ? `ZEC + ${formatSol(lamportsToSol(claimedLamports.toString()))} SOL` : "ZEC"} />
        ) : (
          <Fact label="Claimed so far" value={<Veiled>{formatSol(lamportsToSol(t.fees.claimedLamports))}</Veiled>} unit={claimedZat > N0 ? `SOL + ${formatZec(claimedZat.toString())} ZEC` : "SOL"} />
        )}
        <Fact
          label="Pool volume"
          value={(() => {
            const v = display.sol(lamportsToSol(t.volumeLamports));
            return v === null ? "—" : formatSol(v);
          })()}
          unit={display.converted ? `≈ ${display.unit}` : zecFirst ? "SOL equivalent" : "SOL"}
        />
        <Fact label="Pool trades" value={t.trades.toLocaleString("en-US")} />
        <Fact label="Holders" value={t.holders === null ? "—" : t.holders.toLocaleString("en-US")} unit={t.holders === null ? "not counted yet" : "from the last tick"} />
        <Fact
          label="Launch buy lock"
          value={
            locked > N0 && t.lock.until ? (
              <span className="inline-flex items-center gap-1.5">
                <LockSimple size={14} weight="light" className="text-zec" aria-hidden />
                <Veiled>{tokens(locked)}</Veiled>
              </span>
            ) : (
              "None"
            )
          }
          unit={locked > N0 && t.lock.until ? `until ${when.format(t.lock.until)}${now !== null && t.lock.until - now < 3_600_000 ? " · ending soon" : ""}` : "free to move"}
        />
        <div className="col-span-2 bg-background px-4 py-4 sm:col-span-1">
          <dt className="text-xs text-faint-foreground">Your position · cap {t.cap.capBps / 100}%</dt>
          <dd className="tabular mt-1 text-lg">
            {t.cap.capBps === 0 ? (
              "No cap"
            ) : (
              <>
                <Veiled>{tokens(pos)}</Veiled> <span className="text-sm text-faint-foreground">/ {tokens(cap)}</span>
              </>
            )}
          </dd>
          {t.cap.capBps > 0 && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-sm bg-surface-2" aria-hidden>
              <motion.div
                className={cn("h-full origin-left", capPct >= 90 ? "bg-sell" : "bg-zec")}
                initial={reduce ? false : { scaleX: 0 }}
                // The bar is the position too: it stays empty until Peek, like the number above it.
                animate={{ scaleX: peek.shown ? capPct / 100 : 0 }}
                transition={{ duration: 0.5, ease: EASE }}
              />
            </div>
          )}
        </div>
      </dl>
    </motion.li>
  );
}

function Fact({ label, value, unit }: { label: string; value: React.ReactNode; unit?: string }) {
  return (
    <div className="bg-background px-4 py-4">
      <dt className="text-xs text-faint-foreground">{label}</dt>
      <dd className="tabular mt-1 truncate text-lg">{value}</dd>
      {unit && <dd className="truncate text-[11px] text-faint-foreground">{unit}</dd>}
    </div>
  );
}
