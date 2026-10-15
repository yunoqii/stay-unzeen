"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Feather, Key, Lightning, LockKey, RocketLaunch, ShieldCheck, ShoppingBag, Stack, WarningCircle } from "@phosphor-icons/react";
import { useNative } from "@/lib/chain";
import { ApiError, errorText } from "@/lib/api/client";
import type { LaunchPlatform, PoolInfo, Quote, SignedAction, Venue } from "@/lib/api/types";
import { submitAction, useAction } from "@/lib/activity";
import { useKeyState } from "@/lib/crypto/session";
import { nowFee, useDefaultExec, withExec, type ExecMode } from "@/lib/exec";
import { formatSol, formatUnits, formatZec, lamportsToSol, VENUE_LABEL, ZEC_DECIMALS } from "@/lib/format";
import { BAGS_NO_CURVE_TEXT, checkInitialBuy, isBagsNotReady, validateMeta, type MetaInput } from "@/lib/launch";
import { maxInitialBuyLamports, maxInitialBuyZat, minInitialBuyZat } from "@/lib/launch-rules";
import { useNetwork } from "@/lib/network";
import { launchQuotes, PLATFORM_LABEL, venueInfo, venueLabel } from "@/lib/quotes";
import { cn } from "@/lib/utils";
import { usePortfolio } from "@/hooks/use-portfolio";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { ActionStatusCard } from "@/components/trade/action-status";
import { ExecSwitch } from "@/components/trade/exec-switch";
import { TokenMetaFields } from "./token-meta-fields";
import { RedactionTape } from "@/components/motion/redaction-tape";

const EASE = [0.16, 1, 0.3, 1] as const;
const ZERO = BigInt(0);

type LaunchVenue = Extract<Venue, "pumpfun" | "meteora-dbc" | "raydium-launchlab" | "bags" | "pons">;

const VENUES: { id: LaunchVenue; icon: typeof RocketLaunch; body: string }[] = [
  { id: "pumpfun", icon: RocketLaunch, body: "Bonding curve that graduates to PumpSwap. The pool creates the token; no wallet of yours appears." },
  { id: "meteora-dbc", icon: Lightning, body: "Dynamic bonding curve with its own migration. Same privacy, different curve." },
  { id: "raydium-launchlab", icon: Stack, body: "Raydium's launchpad, under the platform you pick. Graduates to a Raydium pool." },
  { id: "bags", icon: ShoppingBag, body: "Bags launchpad on mainnet, SOL pairs only. Same privacy: a pool vault creates the token." },
  // v0.18 Robinhood Chain: only in hood builds, listed only by a pool that creates there (PoolInfo.venues).
  ...(process.env.NEXT_PUBLIC_HOOD === "1"
    ? [{ id: "pons" as const, icon: Feather, body: "Pons V2 on Robinhood Chain. ETH bonding curve that graduates to Uniswap v4; a pool vault creates the token." }]
    : []),
];

const PLATFORMS: { id: LaunchPlatform; body: string }[] = [
  { id: "unzeen", body: "Unzeen's own LaunchLab platform." },
  { id: "bonk", body: "Listed on bonk.fun." },
  { id: "stonk", body: "Listed on stonk.fun." },
];

const QUOTE_NOTE: Record<Quote, string> = {
  SOL: "The default pair. Trades settle in SOL on the curve.",
  ZEC: "Paid in ZEC, priced in ZEC. Buyers' shielded ZEC meets the curve one to one, with no SOL rate in between. ZEC on Solana is bridged.",
  USDC: "Priced in dollars. Buyers still pay from their ZEC balance.",
  USD1: "Priced in dollars (USD1). Buyers still pay from their ZEC balance.",
};

/**
 * Venues the pool launches on. v0.16: PoolInfo.venues[].create. Older servers: the keys of
 * launchRules.maxInitialBuyLamportsByVenue (v0.6), else the two classics. Bags only ever from PoolInfo.venues.
 */
function venueOn(pool: PoolInfo | null, v: LaunchVenue): boolean {
  if (pool?.venues) return !!pool.venues.find((x) => x.venue === v)?.create;
  if (v === "bags" || v === "pons") return false;
  const by = pool?.launchRules?.maxInitialBuyLamportsByVenue;
  if (!by) return v !== "raydium-launchlab";
  return v in by;
}

/** Cards on the form: Bags appears only when the pool says it can create there (mainnet). */
const shownVenues = (pool: PoolInfo | null) =>
  pool?.chain?.id === "hood" ? VENUES.filter((v) => v.id === "pons") : VENUES.filter((v) => (v.id !== "bags" || venueOn(pool, "bags")) && v.id !== "pons");

const capPct = (pool: PoolInfo | null) => `${Number(((pool?.launchRules?.capBps ?? 500) / 100).toFixed(2))}%`;

/** Numbered section of the launch form. */
export function FormStep({ n, title, hint, children, className }: { n: string; title: string; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("border-t border-border pt-5", className)}>
      <div className="mb-4 flex items-baseline gap-3">
        <span aria-hidden className="font-mono text-[11px] text-faint-foreground tabular">
          {n}
        </span>
        <h2 id={id} className="text-sm font-medium">
          {title}
        </h2>
        {hint && <span className="ml-auto text-xs text-faint-foreground">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * How the launch will read in the public feed: the only thing anyone else ever sees. M8 "Creator slot"
 * (motion-v2): the "who" slot is taped over for good, the creator is anonymous from the first second; the
 * row only reflows as the ticker is typed. `launched` flashes the row once when the launch executes.
 */
export function FeedPreview({
  meta,
  venue,
  verb = "launched",
  quote = "SOL",
  platform,
  launched = false,
}: {
  meta: MetaInput;
  venue: Venue;
  verb?: string;
  quote?: Quote;
  platform?: LaunchPlatform;
  launched?: boolean;
}) {
  const sym = meta.symbol || "TICKER";
  return (
    <motion.div
      layout
      transition={{ layout: { type: "spring", bounce: 0, duration: 0.3 } }}
      className="relative flex items-center gap-3 overflow-hidden rounded-2xl border border-border bg-surface-1 p-3"
    >
      <AnimatePresence>
        {launched && (
          <motion.span
            key="flash"
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[var(--uz-zec-a2)]"
            initial={{ opacity: 1 }}
            animate={{ opacity: 0 }}
            transition={{ duration: 0.6, ease: "linear" }}
          />
        )}
      </AnimatePresence>
      <span className="relative size-10 shrink-0 overflow-hidden rounded-xl border border-border bg-surface-2">
        {meta.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={meta.image} alt="" className="size-full object-cover" />
        ) : (
          <span aria-hidden className="grid size-full place-items-center font-mono text-xs text-faint-foreground">
            {sym.slice(0, 2)}
          </span>
        )}
      </span>
      <p className="relative min-w-0 text-sm">
        <span className="relative inline-block text-foreground" aria-label="unzeen">
          <span aria-hidden className="opacity-0">
            unzeen
          </span>
          <RedactionTape state="covered" instant className="-inset-x-0.5 inset-y-[0.15em]" />
        </span>{" "}
        <span className="text-muted-foreground">{verb}</span>{" "}
        <span className={cn("font-medium", !meta.symbol && "text-faint-foreground")}>${sym}</span>
        <span className="block truncate text-xs text-faint-foreground">
          {meta.name.trim() || "Token name"} · {venueLabel(venue, platform)}
          {quote !== "SOL" && ` · ${quote} pair`} · just now
        </span>
      </p>
    </motion.div>
  );
}

/** Calm notice when the pool has launching switched off (createEnabled=false or 503 on create). */
export function LaunchDisabled() {
  return (
    <div role="status" className="rounded-2xl border border-dashed border-border px-6 py-12 text-center">
      <RocketLaunch size={26} weight="thin" className="mx-auto text-muted-foreground" aria-hidden />
      <p className="mt-3 text-sm font-medium">Launching is temporarily disabled</p>
      <p className="mx-auto mt-1.5 max-w-sm text-sm text-pretty text-muted-foreground">
        The pool is not creating new tokens right now. Your balance is untouched; trading works as usual. Check back soon.
      </p>
    </div>
  );
}

/** Prompt instead of the submit button when there is no unlocked key. */
export function LaunchKeyPrompt({ next = "/launch", verb = "launch" }: { next?: string; verb?: "launch" | "bid" }) {
  const key = useKeyState();
  const locked = key.status === "locked";
  return (
    <div className="rounded-2xl border border-border p-4 text-center">
      {locked ? <LockKey size={22} weight="thin" className="mx-auto text-muted-foreground" aria-hidden /> : <Key size={22} weight="thin" className="mx-auto text-muted-foreground" aria-hidden />}
      <p className="mt-2 text-sm font-medium">{locked ? `Unlock your anon key to ${verb}` : verb === "bid" ? "Bid from a private balance" : "Launch from a private balance"}</p>
      <p className="mt-1 text-xs text-pretty text-muted-foreground">
        {locked ? (verb === "bid" ? "The hold comes from the balance of the key in this browser." : "The fee is paid from the balance of the key in this browser.") : "Create a 12-word anon key and top up with shielded ZEC. The key never leaves this browser."}
      </p>
      <Button asChild className="mt-4 h-10 rounded-full px-5">
        <Link href={`/key?next=${encodeURIComponent(next)}`}>{locked ? "Unlock key" : "Set up anon key"}</Link>
      </Button>
    </div>
  );
}

export function SummaryRow({ label, value, strong, className }: { label: string; value: React.ReactNode; strong?: boolean; className?: string }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3 text-sm", className)}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("tabular text-right", strong ? "font-medium text-foreground" : "text-muted-foreground")}>{value}</dd>
    </div>
  );
}

/**
 * Instant launch: one signed `create` from the balance. The pool deploys the token from a vault and
 * makes the optional first buy in the same transaction; the feed reads "unzeen launched $X".
 */
export function LaunchForm({ pool, meta, onMeta }: { pool: PoolInfo | null; meta: MetaInput; onMeta: (m: MetaInput) => void }) {
  const ids = useId();
  const network = useNetwork();
  const key = useKeyState();
  const unlocked = key.status === "unlocked";
  const { portfolio } = usePortfolio();
  const profileExec = useDefaultExec(network);
  const [execOverride, setExecOverride] = useState<ExecMode | null>(null);
  const exec = execOverride ?? profileExec;
  const [venuePick, setVenue] = useState<LaunchVenue>("pumpfun");
  const venue: LaunchVenue = venueOn(pool, venuePick) ? venuePick : (VENUES.find((v) => venueOn(pool, v.id))?.id ?? "pumpfun");
  const native = useNative().symbol;
  const [platform, setPlatform] = useState<LaunchPlatform>("unzeen");
  const quotes = launchQuotes(pool, venue);
  const info = venueInfo(pool, venue);
  const [quotePick, setQuote] = useState<Quote>("SOL");
  // A pair the picked venue does not offer falls back to SOL (the pick is kept for when it comes back).
  const quote: Quote = quotes.includes(quotePick) ? quotePick : "SOL";
  const [buy, setBuy] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [disabledByServer, setDisabledByServer] = useState(false);
  const active = useAction(activeId);

  const metaErrors = useMemo(() => validateMeta(meta), [meta]);
  const metaOk = Object.keys(metaErrors).length === 0;
  const initial = checkInitialBuy(buy, pool, venue, quote);
  // ZEC pairs (v0.17): their own cap in ZEC SPL units, per venue; not published (devnet) -> the server checks it.
  const maxZat = maxInitialBuyZat(pool, venue, quote);
  const maxLamports = maxInitialBuyLamports(pool, venue);
  // v0.24: the inclusive range the pool accepts (one D10 step .. the venue cap), shown in the field.
  const minZat = minInitialBuyZat(pool, quote);
  const noFirstBuy = maxZat === ZERO;
  const range = maxZat !== null && maxZat > ZERO && minZat !== null && minZat <= maxZat ? `${formatZec(minZat.toString())}–${formatZec(maxZat.toString())}` : null;
  const fee = pool?.fees?.createFeeZat && /^\d+$/.test(pool.fees.createFeeZat) ? BigInt(pool.fees.createFeeZat) : null;
  const nf = exec === "now" ? nowFee(pool) : null;
  const nowZat = nf && "zat" in nf ? nf.zat : ZERO;
  const total = fee === null ? null : fee + (initial.ok && initial.zat ? initial.zat : ZERO) + nowZat;
  const balance = portfolio ? BigInt(portfolio.zecBalance) : null;
  // While the launch is queued its own hold is already off the balance: "not enough" would then describe the
  // launch you just signed, not the form. Re-check once it settles.
  const inFlight = active?.status.status === "queued" || active?.status.status === "sent";
  const short = !inFlight && total !== null && balance !== null && balance < total;
  const frozen = portfolio?.frozen ?? false;

  if (pool?.createEnabled === false || disabledByServer) return <LaunchDisabled />;

  const canSubmit = unlocked && !busy && !inFlight && metaOk && initial.ok && !short && !frozen && portfolio !== null && pool !== null;

  const submit = async () => {
    setTried(true);
    if (!canSubmit || !initial.ok) return;
    setBusy(true);
    setError(null);
    const action: SignedAction = withExec(
      {
        op: "create",
        venue,
        meta: { name: meta.name.trim(), symbol: meta.symbol, ...(meta.image ? { image: meta.image } : {}) },
        ...(initial.zat ? { initialBuyZec: initial.zat.toString() } : {}),
        ...(quote !== "SOL" ? { quote } : {}),
        ...(venue === "raydium-launchlab" ? { platform } : {}),
      },
      exec,
    );
    try {
      const it = await submitAction(network, action, { op: "create", symbol: meta.symbol, amount: (initial.zat ?? ZERO).toString() });
      setActiveId(it.id);
      setExecOverride(null);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError("internal", String(e));
      // A Bags 503 means "no curve yet" (A4), not "launches are off": keep the form, explain it below.
      if (err.code === "venue_unavailable" && err.status === 503 && pool?.createEnabled !== true && !isBagsNotReady(err, venue)) setDisabledByServer(true);
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const minted = active?.status.status === "executed" ? active.status.fill?.mint : undefined;

  return (
    <div className="grid grid-cols-1 gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-8">
        <FormStep n="01" title="Token">
          <TokenMetaFields value={meta} onChange={onMeta} errors={metaErrors} showErrors={tried} disabled={busy} />
        </FormStep>

        <FormStep n="02" title="Venue">
          <div role="radiogroup" aria-label="Venue" className={cn("grid gap-2", shownVenues(pool).length > 3 ? "sm:grid-cols-2" : "sm:grid-cols-3")}>
            {shownVenues(pool).map(({ id, icon: Icon, body }) => {
              const on = venue === id;
              const available = venueOn(pool, id);
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={busy || !available}
                  title={available ? undefined : "Not switched on for this pool"}
                  onClick={() => {
                    setVenue(id);
                    setError(null);
                  }}
                  className={cn(
                    "group relative rounded-2xl border p-4 text-left transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    on ? "border-zec/50 bg-zec/[0.04]" : "border-border hover:border-border-strong hover:bg-surface-1",
                    !available && "opacity-45 hover:border-border hover:bg-transparent",
                  )}
                >
                  <span className="flex items-center justify-between">
                    <Icon size={20} weight={on ? "duotone" : "thin"} className={cn("transition-colors", on ? "text-zec" : "text-muted-foreground group-hover:text-foreground")} aria-hidden />
                    <span aria-hidden className={cn("grid size-4 place-items-center rounded-full border transition-colors", on ? "border-zec" : "border-border-strong")}>
                      {on && <motion.span layoutId={`${ids}-venue`} className="size-2 rounded-full bg-zec" transition={{ type: "spring", bounce: 0, duration: 0.25 }} />}
                    </span>
                  </span>
                  <span className="mt-3 block text-sm font-medium">{id === "raydium-launchlab" ? "Raydium LaunchLab" : VENUE_LABEL[id]}</span>
                  <span className="mt-1 block text-xs text-pretty text-muted-foreground">{available ? body : "Not switched on for this pool yet."}</span>
                </button>
              );
            })}
          </div>
          <AnimatePresence initial={false}>
            {venue === "raydium-launchlab" && (
              <motion.div
                key="platform"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.22, ease: EASE }}
                style={{ overflow: "hidden" }}
              >
                <div className="pt-3">
                  <p id={`${ids}-plat`} className="mb-2 text-xs text-muted-foreground">
                    Platform
                  </p>
                  <div role="radiogroup" aria-labelledby={`${ids}-plat`} className="flex flex-wrap gap-1.5">
                    {PLATFORMS.map((p) => (
                      <Chip key={p.id} role="radio" aria-checked={platform === p.id} active={platform === p.id} onClick={() => setPlatform(p.id)} disabled={busy} title={p.body}>
                        {PLATFORM_LABEL[p.id]}
                      </Chip>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-faint-foreground">{PLATFORMS.find((p) => p.id === platform)?.body} The creator on-chain is still a pool vault.</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </FormStep>

        <FormStep n="03" title="Pair" hint={quotes.length === 1 ? `${native} only here` : undefined}>
          <div role="radiogroup" aria-label="Pair" className="flex flex-wrap gap-1.5">
            {(native === "ETH" ? (["SOL"] as const) : (["SOL", "ZEC", "USDC", "USD1"] as const)).map((q) => {
              const offered = quotes.includes(q);
              return (
                <Chip
                  key={q}
                  role="radio"
                  aria-checked={quote === q}
                  active={quote === q}
                  disabled={busy || !offered}
                  onClick={() => setQuote(q)}
                  title={offered ? undefined : `${venueLabel(venue)} has no ${q} pair on this pool`}
                  className={cn("font-mono", quote === q && q === "ZEC" && "shadow-[0_0_18px_-4px_rgba(244,183,40,0.45)]")}
                >
                  ${meta.symbol || "TICKER"}/{q === "SOL" ? native : q}
                </Chip>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-pretty text-faint-foreground">{process.env.NEXT_PUBLIC_HOOD === "1" && quote === "SOL" && native === "ETH" ? "The pair on Pons. Trades settle in ETH on the curve; buyers still pay from their ZEC balance." : QUOTE_NOTE[quote]}</p>
        </FormStep>

        <FormStep n="04" title="Your first buy" hint="optional">
          <div
            className={cn(
              "flex h-14 items-center rounded-2xl border bg-surface-1 px-4 transition-colors duration-150 focus-within:border-ring",
              !initial.ok ? "border-destructive/60" : "border-border",
            )}
          >
            <input
              id={`${ids}-buy`}
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              placeholder={noFirstBuy ? "Not available" : (range ?? "0.00")}
              value={buy}
              disabled={busy || (noFirstBuy && buy === "")}
              aria-label={range ? `First buy in ZEC, ${range}` : "First buy in ZEC"}
              aria-invalid={!initial.ok}
              aria-describedby={`${ids}-buy-h`}
              onChange={(e) => {
                setError(null);
                setBuy(e.target.value.replace(",", "."));
              }}
              className="tabular min-w-0 flex-1 bg-transparent text-2xl font-medium tracking-tight outline-none placeholder:text-faint-foreground"
            />
            <span className="ml-3 shrink-0 text-sm text-muted-foreground">ZEC</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Chip active={buy === ""} onClick={() => setBuy("")} disabled={busy}>
              None
            </Chip>
            {maxZat !== null && maxZat > ZERO && (
              <Chip active={buy !== "" && initial.ok && initial.zat === maxZat} onClick={() => setBuy(formatUnits(maxZat.toString(), ZEC_DECIMALS))} disabled={busy}>
                Max {formatZec(maxZat.toString())}
              </Chip>
            )}
          </div>
          <p id={`${ids}-buy-h`} className={cn("mt-2 text-xs text-pretty", initial.ok ? "text-faint-foreground" : "text-sell")}>
            {!initial.ok
              ? initial.error
              : quote === "ZEC"
                ? maxZat !== null
                  ? `Up to ${formatZec(maxZat.toString())} ZEC on the ZEC curve of ${VENUE_LABEL[venue]}, in the same transaction as the launch. Locked for the rule period.`
                  : `Spent in ZEC on the ZEC curve, in the same transaction as the launch. Capped at ${capPct(pool)} of supply; the pool checks the cap when it accepts.`
                : noFirstBuy
                ? `No first buy on ${VENUE_LABEL[venue]} right now: the creator cap is smaller than one trade step. Launch without one, then buy like anyone else.`
                : range && maxLamports
                ? `${range} ZEC on ${VENUE_LABEL[venue]} (up to ≈ ${formatSol(lamportsToSol(maxLamports))} ${native} on its curve). Bought in the same transaction as the launch, locked for the rule period.`
                : maxZat !== null && maxLamports
                ? `Up to ${formatZec(maxZat.toString())} ZEC on ${VENUE_LABEL[venue]} (≈ ${formatSol(lamportsToSol(maxLamports))} ${native} on its curve). Bought in the same transaction as the launch, locked for the rule period.`
                : "Bought in the same transaction as the launch."}
          </p>
          {info && !info.atomicFirstBuy && (
            <p role="note" className="mt-3 flex gap-2 rounded-xl border border-zec/30 bg-zec-soft px-3 py-2.5 text-xs text-pretty text-zec">
              <WarningCircle size={14} weight="light" className="mt-px shrink-0" aria-hidden />
              <span>First buy is not atomic: it lands right after the launch, a sniper can get in between.</span>
            </p>
          )}
          {info && !info.creatorFees && (
            <p className="mt-2 text-xs text-pretty text-faint-foreground">Creator fees on Bags go to Bags fee share: nothing to claim here for this launch.</p>
          )}
        </FormStep>

        <FormStep n="05" title="Execution">
          <ExecSwitch value={exec} onChange={(m) => setExecOverride(m === profileExec ? null : m)} profileDefault={profileExec} />
        </FormStep>
      </div>

      <aside className="min-w-0 space-y-4 lg:sticky lg:top-[calc(var(--header-h)+1.5rem)] lg:self-start">
        <p className="text-xs text-muted-foreground">In the feed</p>
        <FeedPreview meta={meta} venue={venue} quote={quote} platform={venue === "raydium-launchlab" ? platform : undefined} launched={!!minted} />

        <dl className="space-y-2 rounded-2xl border border-border p-4">
          <SummaryRow label="Pair" value={`$${meta.symbol || "TICKER"}/${quote === "SOL" ? native : quote}`} />
          <SummaryRow label="Launch fee" value={fee === null ? "—" : `${formatZec(fee.toString())} ZEC`} />
          <SummaryRow label="First buy" value={initial.ok && initial.zat ? `≈ ${formatZec(initial.zat.toString())} ZEC` : "none"} />
          {exec === "now" && <SummaryRow label="Now lane" value={nowZat > ZERO ? `${formatZec(nowZat.toString())} ZEC` : "—"} />}
          <div aria-hidden className="hatch my-1 h-2" />
          <SummaryRow label="Held from balance" value={total === null ? "—" : `${formatZec(total.toString())} ZEC`} strong />
          <SummaryRow
            label="Balance"
            value={!unlocked ? "locked" : balance === null ? "…" : `${formatZec(balance.toString())} ZEC`}
            className={cn(short && "[&_dd]:text-sell")}
          />
        </dl>

        {short && (
          <p className="text-xs text-sell">
            Not enough ZEC on your balance.{" "}
            <Link href="/pay" className="underline underline-offset-4 hover:text-foreground">
              Top up
            </Link>
          </p>
        )}
        {frozen && (
          <p role="alert" className="rounded-xl bg-zec-soft p-3 text-xs text-zec">
            Your balance is on hold while a deposit is reviewed. Launching resumes when the review ends.
          </p>
        )}

        <AnimatePresence initial={false}>
          {error && (
            <motion.p
              key="err"
              role="alert"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
              style={{ overflow: "hidden" }}
              className="text-xs text-sell"
            >
              {isBagsNotReady(error, venue)
                ? BAGS_NO_CURVE_TEXT
                : error.code === "below_minimum" && minZat !== null
                  ? `The first buy is below one trade step: at least ${formatZec(minZat.toString())} ZEC, or launch without a first buy.`
                  : errorText(error)}
            </motion.p>
          )}
        </AnimatePresence>

        {key.status === "loading" ? (
          <div className="h-12" aria-busy />
        ) : !unlocked ? (
          <LaunchKeyPrompt />
        ) : (
          <>
            <Button onClick={submit} disabled={busy || (tried && !canSubmit)} aria-busy={busy} className={cn("h-12 w-full rounded-full text-[15px]", busy && "busy-hatch disabled:opacity-90")}>
              {busy ? "Signing…" : `Launch $${meta.symbol || "TICKER"}`}
            </Button>
            <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-faint-foreground">
              <ShieldCheck size={12} weight="light" aria-hidden />
              Signed in this browser. The creator on-chain is a pool vault.
            </p>
          </>
        )}

        <AnimatePresence initial={false}>
          {active && (
            <motion.div
              key={active.id}
              initial={{ opacity: 0, y: 8, filter: "blur(8px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3, ease: EASE }}
              className="space-y-2"
            >
              <ActionStatusCard action={active} />
              {inFlight && info && !info.atomicFirstBuy && (
                <p className="text-[11px] text-pretty text-faint-foreground">
                  On {VENUE_LABEL[venue]} this runs as two transactions, the launch and then your first buy, so it can stay queued or sent a little longer.
                </p>
              )}
              {minted && (
                <Button asChild variant="outline" className="h-10 w-full rounded-full">
                  <Link href={`/token/${minted}`}>
                    Open ${active.symbol} <ArrowRight size={14} weight="light" aria-hidden />
                  </Link>
                </Button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </aside>
    </div>
  );
}
