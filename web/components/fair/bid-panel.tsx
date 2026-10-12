"use client";

import { useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Eye, LockSimple, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import { API_MODE, ApiError, errorText } from "@/lib/api/client";
import type { FairBid, FairLaunch, PoolInfo, Portfolio } from "@/lib/api/types";
import { getSigner } from "@/lib/crypto/session";
import { postFair } from "@/lib/fair/api";
import { removeLocalBid, saveLocalBid, type LocalBid } from "@/lib/fair/bid-store";
import { encodeBid } from "@/lib/fair/plaintext";
import { checkBid, creatorMaxTier, holdTierFor, type BidCheck } from "@/lib/fair/tiers";
import { formatZec, parseUnits, ZEC_DECIMALS } from "@/lib/format";
import { useNetwork } from "@/lib/network";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { DecryptText } from "@/components/motion/decrypt-text";
import { SealedGlyphs } from "./parts";

const EASE = [0.16, 1, 0.3, 1] as const;

const REASON: Record<Exclude<BidCheck, { ok: true }>["reason"], (x: { min: string; max: string; cap: string }) => string> = {
  empty: () => "",
  below_minimum: ({ min }) => `At least ${min} ZEC.`,
  above_max: ({ max }) => `At most ${max} ZEC, the largest hold.`,
  tier_too_small: () => "Pick a hold at least as large as your amount.",
  creator_cap: ({ cap }) => `As the creator your hold is capped at ${cap} ZEC (your share of supply is capped).`,
  insufficient_balance: () => "Not enough ZEC on your balance for this hold.",
};

/** Amount -> tier -> sealed in this browser (drand tlock) -> fl_bid. Nothing readable leaves the tab. */
export function BidForm({ launch, pool, portfolio, isCreator, onSealed }: { launch: FairLaunch; pool: PoolInfo; portfolio: Portfolio | null; isCreator: boolean; onSealed: () => void }) {
  const ids = useId();
  const network = useNetwork();
  const params = pool.fairLaunch!;
  const [amount, setAmount] = useState("");
  const [hold, setHold] = useState<bigint | null>(null);
  const [phase, setPhase] = useState<"idle" | "sealing" | "sending">("idle");
  const [error, setError] = useState<string | null>(null);

  let amountZat: bigint | null = null;
  let formatError: string | null = null;
  if (amount.trim()) {
    try {
      amountZat = BigInt(parseUnits(amount, ZEC_DECIMALS));
    } catch {
      formatError = "Enter an amount in ZEC, up to 8 decimals.";
    }
  }
  const tiers = params.holdTiersZat;
  const capZat = isCreator ? creatorMaxTier(tiers, params.creatorMaxLamports, pool.rate?.lamportsPerZecBuy) : null;
  const auto = amountZat !== null ? holdTierFor(amountZat, tiers) : null;
  const chosen = hold !== null && amountZat !== null && hold >= amountZat ? hold : auto;
  const balance = portfolio ? BigInt(portfolio.zecBalance) : null;
  const check = checkBid({ amountZat, holdZat: chosen, tiers, minActionZat: pool.minActionZat, balanceZat: balance, creatorCapZat: capZat });
  const largest = tiers.length ? tiers[tiers.length - 1] : "0";
  const hint = formatError ?? (check.ok ? null : REASON[check.reason]({ min: formatZec(pool.minActionZat), max: formatZec(largest), cap: capZat !== null ? formatZec(capZat.toString()) : "—" }) || null);
  const busy = phase !== "idle";

  const submit = async () => {
    if (!check.ok || amountZat === null || busy) return;
    const signer = getSigner(network);
    if (!signer) return setError(errorText(new ApiError("locked", "")));
    setError(null);
    setPhase("sealing");
    try {
      const plaintext = encodeBid({ chainId: pool.chainId, launchId: launch.id, anonPubkey: signer.pubkey, amountZat });
      // tlock + BLS12-381 load only when someone actually seals a bid.
      const { sealBid } = await import("@/lib/fair/tlock");
      const ciphertext = await sealBid(launch.drand.round, plaintext, params.drand);
      plaintext.fill(0);
      if (API_MODE === "mock" && process.env.NEXT_PUBLIC_MOCK_FAIR_LAUNCH === "1") {
        // The mock cannot decrypt after the round; it is told the amount instead (same tab only).
        (await import("@/lib/api/mock-fair")).mockFairHint(ciphertext, amountZat);
      }
      setPhase("sending");
      // Kept locally BEFORE the POST (review F12): a tab closed mid-request still has its amount and
      // ciphertext. Refused -> removed; accepted -> no longer pending.
      const local = { launchId: launch.id, amountZat: amountZat.toString(), holdZat: check.holdZat.toString(), ciphertext };
      await saveLocalBid(network, signer.pubkey, { ...local, pending: true });
      try {
        await postFair(network, { op: "fl_bid", launchId: launch.id, holdZat: check.holdZat.toString(), ciphertext });
      } catch (e) {
        // A network failure may still have landed: keep the pending copy then (pruned later if not).
        if (e instanceof ApiError && e.code !== "network") await removeLocalBid(network, signer.pubkey, launch.id);
        throw e;
      }
      await saveLocalBid(network, signer.pubkey, local);
      setAmount("");
      setHold(null);
      onSealed();
    } catch (e) {
      setError(errorText(e instanceof ApiError ? e : new ApiError("internal", String(e))));
    } finally {
      setPhase("idle");
    }
  };

  const allowed = tiers.map(BigInt).filter((t) => (amountZat === null || t >= amountZat) && (capZat === null || t <= capZat));

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between text-xs">
        <label htmlFor={`${ids}-amt`} className="text-muted-foreground">
          Your bid
        </label>
        <span className="text-faint-foreground">
          Balance <span className="tabular text-muted-foreground">{balance === null ? "…" : `${formatZec(balance.toString())} ZEC`}</span>
        </span>
      </div>
      <div className={cn("flex h-14 items-center rounded-2xl border bg-surface-1 px-4 transition-colors duration-150 focus-within:border-ring", hint && amount ? "border-destructive/60" : "border-border")}>
        <input
          id={`${ids}-amt`}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder="0.00"
          value={amount}
          disabled={busy}
          aria-invalid={!!(hint && amount)}
          aria-describedby={`${ids}-h`}
          onChange={(e) => {
            setError(null);
            setAmount(e.target.value.replace(",", "."));
          }}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          className="tabular min-w-0 flex-1 bg-transparent text-2xl font-medium tracking-tight outline-none placeholder:text-faint-foreground"
        />
        <span className="ml-3 shrink-0 text-sm text-muted-foreground">ZEC</span>
      </div>

      <div>
        <p className="mb-2 text-xs text-muted-foreground">
          Hold{" "}
          <span className="text-faint-foreground">
            {chosen !== null ? `${formatZec(chosen.toString())} ZEC — hides your exact amount` : "— the smallest tier that covers your bid"}
          </span>
        </p>
        <div role="radiogroup" aria-label="Hold" className="flex flex-wrap gap-1.5">
          {allowed.length === 0 ? (
            <span className="text-xs text-faint-foreground">No tier fits this amount.</span>
          ) : (
            allowed.map((t) => (
              <Chip key={t.toString()} role="radio" aria-checked={chosen === t} active={chosen === t} disabled={busy} onClick={() => setHold(t)}>
                {formatZec(t.toString())}
              </Chip>
            ))
          )}
        </div>
      </div>

      <p id={`${ids}-h`} className={cn("text-xs text-pretty", hint && amount ? "text-sell" : "text-faint-foreground")}>
        {(amount && hint) ||
          (isCreator && capZat !== null
            ? `Creator's own bid: hold up to ${formatZec(capZat.toString())} ZEC. Your tokens from it are locked like an instant launch's first buy.`
            : "The pool holds the tier, not your amount. After the round you pay only for what your bid bought; the rest returns to your balance.")}
      </p>

      <AnimatePresence initial={false}>
        {error && (
          <motion.p key="e" role="alert" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} style={{ overflow: "hidden" }} className="text-xs text-sell">
            {error}
          </motion.p>
        )}
      </AnimatePresence>

      <Button onClick={() => void submit()} disabled={!check.ok || busy || !!formatError} aria-busy={busy} className={cn("h-12 w-full rounded-full text-[15px]", busy && "busy-hatch disabled:opacity-90")}>
        {phase === "sealing" ? "Sealing in your browser…" : phase === "sending" ? "Sending sealed bid…" : "Seal bid"}
      </Button>
      <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-pretty text-faint-foreground">
        <ShieldCheck size={12} weight="light" aria-hidden />
        Encrypted here to drand round #{launch.drand.round.toLocaleString("en-US")}. Not even the pool can open it before then.
      </p>
    </div>
  );
}

/** Press and hold to read your own amount from this browser's encrypted store. */
function HoldToPeek({ local }: { local: LocalBid | undefined }) {
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (!local)
    return <p className="text-xs text-faint-foreground">Sealed on another device. The amount and the ciphertext live only where you sealed it.</p>;
  const start = () => {
    timer.current = setTimeout(() => setShown(true), 180);
  };
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    setShown(false);
  };
  return (
    <button
      type="button"
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={(e) => (e.key === " " || e.key === "Enter") && !e.repeat && setShown(true)}
      onKeyUp={stop}
      onBlur={stop}
      onContextMenu={(e) => e.preventDefault()}
      aria-pressed={shown}
      className="inline-flex h-8 touch-none items-center gap-1.5 rounded-full border border-border px-3 text-xs text-muted-foreground transition-colors select-none hover:border-border-strong hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-pressed:border-zec/50 aria-pressed:text-foreground"
    >
      <Eye size={13} weight="light" aria-hidden />
      {shown ? <DecryptText text={`${formatZec(local.amountZat)} ZEC`} durationMs={260} className="tabular" /> : "Hold to peek"}
    </button>
  );
}

/** Your sealed bid: glyphs, the tier, peek from the local store, and withdraw before close. */
export function SealedBid({ launch, bid, local, canCancel, onChanged }: { launch: FairLaunch; bid: FairBid; local: LocalBid | undefined; canCancel: boolean; onChanged: () => void }) {
  const network = useNetwork();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = async () => {
    const signer = getSigner(network);
    if (!signer) return;
    setBusy(true);
    setError(null);
    try {
      await postFair(network, { op: "fl_cancel", launchId: launch.id });
      await removeLocalBid(network, signer.pubkey, launch.id);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <motion.div
      initial={{ opacity: 0, filter: "blur(10px)" }}
      animate={{ opacity: 1, filter: "blur(0px)" }}
      transition={{ duration: 0.4, ease: EASE }}
      className="rounded-2xl border border-border bg-surface-1 p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <LockSimple size={13} weight="duotone" className="text-zec" aria-hidden />
          Your sealed bid
        </span>
        <span className="tabular text-xs text-faint-foreground">hold {formatZec(bid.holdZat)} ZEC</span>
      </div>
      <p className="mt-3 text-3xl">
        <SealedGlyphs length={6} seed={3} className="text-3xl" /> <span className="text-base text-muted-foreground">ZEC</span>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <HoldToPeek local={local} />
        {canCancel && (
          <button
            type="button"
            onClick={() => void cancel()}
            disabled={busy}
            className="inline-flex h-8 items-center rounded-full px-3 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
          >
            {busy ? "Withdrawing…" : "Withdraw bid"}
          </button>
        )}
      </div>
      {canCancel && <p className="mt-2 text-[11px] text-faint-foreground">To change the amount, withdraw and seal a new bid before the window closes.</p>}
      {error && (
        <p role="alert" className="mt-2 flex gap-1.5 text-xs text-sell">
          <WarningCircle size={13} weight="light" className="mt-px shrink-0" aria-hidden />
          {error}
        </p>
      )}
    </motion.div>
  );
}
