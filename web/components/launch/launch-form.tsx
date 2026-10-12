"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Key, Lightning, LockKey, RocketLaunch, ShieldCheck } from "@phosphor-icons/react";
import { ApiError, errorText } from "@/lib/api/client";
import type { PoolInfo, SignedAction, Venue } from "@/lib/api/types";
import { submitAction, useAction } from "@/lib/activity";
import { useKeyState } from "@/lib/crypto/session";
import { nowFee, useDefaultExec, withExec, type ExecMode } from "@/lib/exec";
import { formatSol, formatUnits, formatZec, lamportsToSol, VENUE_LABEL, ZEC_DECIMALS } from "@/lib/format";
import { checkInitialBuy, validateMeta, type MetaInput } from "@/lib/launch";
import { maxInitialBuyLamports, maxInitialBuyZat } from "@/lib/launch-rules";
import { useNetwork } from "@/lib/network";
import { cn } from "@/lib/utils";
import { usePortfolio } from "@/hooks/use-portfolio";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { ActionStatusCard } from "@/components/trade/action-status";
import { ExecSwitch } from "@/components/trade/exec-switch";
import { TokenMetaFields } from "./token-meta-fields";

const EASE = [0.16, 1, 0.3, 1] as const;
const ZERO = BigInt(0);

const VENUES: { id: Exclude<Venue, "jupiter">; icon: typeof RocketLaunch; body: string }[] = [
  { id: "pumpfun", icon: RocketLaunch, body: "Bonding curve that graduates to PumpSwap. The pool creates the token; no wallet of yours appears." },
  { id: "meteora-dbc", icon: Lightning, body: "Dynamic bonding curve with its own migration. Same privacy, different curve." },
];

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

/** How the launch will read in the public feed: the only thing anyone else ever sees. */
export function FeedPreview({ meta, venue, verb = "launched" }: { meta: MetaInput; venue: Venue; verb?: string }) {
  const sym = meta.symbol || "TICKER";
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface-1 p-3">
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
      <p className="min-w-0 text-sm">
        <span className="text-foreground">unzeen</span> <span className="text-muted-foreground">{verb}</span>{" "}
        <span className={cn("font-medium", !meta.symbol && "text-faint-foreground")}>${sym}</span>
        <span className="block truncate text-xs text-faint-foreground">
          {meta.name.trim() || "Token name"} · {VENUE_LABEL[venue]} · just now
        </span>
      </p>
    </div>
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
  const [venue, setVenue] = useState<Exclude<Venue, "jupiter">>("pumpfun");
  const [buy, setBuy] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [disabledByServer, setDisabledByServer] = useState(false);
  const active = useAction(activeId);

  const metaErrors = useMemo(() => validateMeta(meta), [meta]);
  const metaOk = Object.keys(metaErrors).length === 0;
  const initial = checkInitialBuy(buy, pool, venue);
  const maxZat = maxInitialBuyZat(pool, venue);
  const maxLamports = maxInitialBuyLamports(pool, venue);
  const fee = pool?.fees?.createFeeZat && /^\d+$/.test(pool.fees.createFeeZat) ? BigInt(pool.fees.createFeeZat) : null;
  const nf = exec === "now" ? nowFee(pool) : null;
  const nowZat = nf && "zat" in nf ? nf.zat : ZERO;
  const total = fee === null ? null : fee + (initial.ok && initial.zat ? initial.zat : ZERO) + nowZat;
  const balance = portfolio ? BigInt(portfolio.zecBalance) : null;
  const short = total !== null && balance !== null && balance < total;
  const frozen = portfolio?.frozen ?? false;

  if (pool?.createEnabled === false || disabledByServer) return <LaunchDisabled />;

  const canSubmit = unlocked && !busy && metaOk && initial.ok && !short && !frozen && portfolio !== null && pool !== null;

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
      },
      exec,
    );
    try {
      const it = await submitAction(network, action, { op: "create", symbol: meta.symbol, amount: (initial.zat ?? ZERO).toString() });
      setActiveId(it.id);
      setExecOverride(null);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError("internal", String(e));
      if (err.code === "venue_unavailable" && err.status === 503 && pool?.createEnabled !== true) setDisabledByServer(true);
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const minted = active?.status.status === "executed" ? active.status.fill?.mint : undefined;

  return (
    <div className="grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-8">
        <FormStep n="01" title="Token">
          <TokenMetaFields value={meta} onChange={onMeta} errors={metaErrors} showErrors={tried} disabled={busy} />
        </FormStep>

        <FormStep n="02" title="Venue">
          <div role="radiogroup" aria-label="Venue" className="grid gap-2 sm:grid-cols-2">
            {VENUES.map(({ id, icon: Icon, body }) => {
              const on = venue === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={busy}
                  onClick={() => setVenue(id)}
                  className={cn(
                    "group relative rounded-2xl border p-4 text-left transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    on ? "border-zec/50 bg-zec/[0.04]" : "border-border hover:border-border-strong hover:bg-surface-1",
                  )}
                >
                  <span className="flex items-center justify-between">
                    <Icon size={20} weight={on ? "duotone" : "thin"} className={cn("transition-colors", on ? "text-zec" : "text-muted-foreground group-hover:text-foreground")} aria-hidden />
                    <span aria-hidden className={cn("grid size-4 place-items-center rounded-full border transition-colors", on ? "border-zec" : "border-border-strong")}>
                      {on && <motion.span layoutId={`${ids}-venue`} className="size-2 rounded-full bg-zec" transition={{ type: "spring", bounce: 0, duration: 0.25 }} />}
                    </span>
                  </span>
                  <span className="mt-3 block text-sm font-medium">{VENUE_LABEL[id]}</span>
                  <span className="mt-1 block text-xs text-pretty text-muted-foreground">{body}</span>
                </button>
              );
            })}
          </div>
        </FormStep>

        <FormStep n="03" title="Your first buy" hint="optional">
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
              placeholder="0.00"
              value={buy}
              disabled={busy}
              aria-label="First buy in ZEC"
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
              : maxZat !== null && maxLamports
                ? `Up to ${formatZec(maxZat.toString())} ZEC on ${VENUE_LABEL[venue]} (≈ ${formatSol(lamportsToSol(maxLamports))} SOL on its curve). Bought in the same transaction as the launch, locked for the rule period.`
                : "Bought in the same transaction as the launch."}
          </p>
        </FormStep>

        <FormStep n="04" title="Execution">
          <ExecSwitch value={exec} onChange={(m) => setExecOverride(m === profileExec ? null : m)} profileDefault={profileExec} />
        </FormStep>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-[calc(var(--header-h)+1.5rem)] lg:self-start">
        <p className="text-xs text-muted-foreground">In the feed</p>
        <FeedPreview meta={meta} venue={venue} />

        <dl className="space-y-2 rounded-2xl border border-border p-4">
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
              {errorText(error)}
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
