"use client";

import { useId, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CaretDown, Check, GlobeSimple, Minus, PaperPlaneTilt, ShieldCheck, WarningCircle, XLogo } from "@phosphor-icons/react";
import { api } from "@/lib/api/client";
import type { RiskyExtension, TokenSafety, UnzeenRule } from "@/lib/api/types";
import { shortAddr, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { usePending, type PendingState } from "@/hooks/use-pending";
import { usePool } from "@/hooks/use-pool";
import { ruleText, RULES_SCOPE } from "@/lib/launch-rules";
import { useNow } from "@/hooks/use-now";
import { Skeleton } from "@/components/ui/skeleton";
import { Analyzing } from "./analyzing";
import { LeaveLink, normalizeExternal } from "./leave-link";

const EASE = [0.16, 1, 0.3, 1] as const;

const DEFAULT_RULES: UnzeenRule[] = ["creator_initial_buy_locked_24h", "initial_buy_cap_5pct", "authorities_revoked"];

const EXTENSION_TEXT: Record<RiskyExtension, string> = {
  permanentDelegate: "Permanent delegate (can move anyone's tokens)",
  transferHook: "Transfer hook (custom code on every transfer)",
  transferFee: "Transfer fee",
  defaultFrozen: "New accounts start frozen",
  mintClose: "Mint can be closed",
  pausable: "Transfers can be paused",
};

type Tone = "ok" | "warn" | "neutral" | "na";

/** GET /api/tokens/:mint/safety; refreshed quietly every minute (the backend's own tick). */
export function useSafety(mint: string): PendingState<TokenSafety> {
  return usePending(`safety:${mint}`, () => api.getSafety(mint), 60_000);
}

export function SafetyPanel({ state: s, className }: { state: PendingState<TokenSafety>; className?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={`${id}-t`} className={className}>
      <header className="flex items-baseline justify-between gap-3 border-b border-border/60 px-4 py-3">
        <h2 id={`${id}-t`} className="flex items-center gap-2 text-sm font-medium">
          <ShieldCheck size={15} weight="light" className="text-muted-foreground" aria-hidden />
          Token safety
        </h2>
        {s.state === "ready" && <AsOf ts={s.data.asOf} />}
      </header>
      {s.state === "loading" && <SafetySkeleton />}
      {s.state === "pending" && <Analyzing retryAt={s.retryAt} compact className="px-4 py-5" />}
      {s.state === "missing" && <p className="px-4 py-5 text-sm text-muted-foreground">This mint does not exist on Solana.</p>}
      {s.state === "error" && (
        <p role="alert" className="px-4 py-5 text-sm text-muted-foreground">
          {s.error}
        </p>
      )}
      {s.state === "ready" && <SafetyBody safety={s.data} />}
    </section>
  );
}

function AsOf({ ts }: { ts: number }) {
  const now = useNow(15_000);
  if (now === null) return null;
  return <span className="tabular text-[11px] text-faint-foreground">Updated {timeAgo(ts, now)} ago</span>;
}

export function SafetyBody({ safety }: { safety: TokenSafety }) {
  const a = safety.authorities;
  const unzeen = !!safety.unzeen?.launch;
  const h = safety.holders;
  const m = safety.market;

  return (
    <div>
      {unzeen && <UnzeenBadge rules={safety.unzeen?.rules ?? DEFAULT_RULES} />}
      <dl className="divide-y divide-border/60">
        <Row label="Mint authority" tone={a.mintRevoked ? "ok" : "warn"} value={a.mintRevoked ? "Revoked" : "Active · supply can grow"} />
        <Row label="Freeze authority" tone={a.freezeRevoked ? "ok" : "warn"} value={a.freezeRevoked ? "Revoked" : "Active · wallets can be frozen"} />
        <Row
          label="Metadata"
          tone={a.metadataImmutable === null ? "na" : a.metadataImmutable ? "ok" : "warn"}
          value={a.metadataImmutable === null ? "Unknown" : a.metadataImmutable ? "Immutable" : "Can be changed"}
        />
        {a.riskyExtensions.length > 0 && (
          <Row
            label="Token-2022"
            tone="warn"
            value={
              <ul className="space-y-0.5 text-right">
                {a.riskyExtensions.map((x) => (
                  <li key={x}>{EXTENSION_TEXT[x] ?? x}</li>
                ))}
              </ul>
            }
          />
        )}

        {h ? (
          <>
            <Row
              label="Top 10 holders"
              hint="Without the bonding curve, the AMM pool and unzeen vaults."
              tone={Number(h.top10Pct) > 35 ? "warn" : "neutral"}
              value={<Meter pct={Number(h.top10Pct)} label={`${h.top10Pct}%`} warn={Number(h.top10Pct) > 35} />}
            />
            <Row
              label="Dev share"
              tone={h.devPct === null ? "neutral" : Number(h.devPct) > 10 ? "warn" : "neutral"}
              value={h.devPct === null ? (unzeen ? "Anonymous" : "Unknown") : `${h.devPct}%`}
            />
            <Row label="unzeen pool" hint="Shared inventory of every unzeen holder, not one wallet." tone="neutral" value={`${h.unzeenPoolPct}%`} />
          </>
        ) : (
          <Row label="Holders" tone="na" value={<NotYet />} />
        )}

        {m.status === "curve" ? (
          <Row
            label="Bonding curve"
            tone="neutral"
            value={m.curveProgressPct ? <Meter pct={Number(m.curveProgressPct)} label={`${m.curveProgressPct}%`} /> : <NotYet />}
          />
        ) : (
          <Row
            label="Graduated"
            tone={m.lpBurnedPct === undefined ? "neutral" : Number(m.lpBurnedPct) >= 99 ? "ok" : "neutral"}
            value={m.lpBurnedPct === undefined ? "LP status unknown" : `LP ${m.lpBurnedPct}% burned or locked`}
          />
        )}

        <FirstBlocks fb={safety.firstBlocks} unzeen={unzeen} />
        <DevHistory dev={safety.dev} unzeen={unzeen} />
        <Socials socials={safety.socials} />
      </dl>
    </div>
  );
}

function FirstBlocks({ fb, unzeen }: { fb: TokenSafety["firstBlocks"]; unzeen: boolean }) {
  if (!fb) return <Row label="First blocks" hint="Snipers and same-slot buyers right after launch." tone="na" value={<NotYet />} />;
  const clean = fb.snipers === 0 && fb.sameSlotBuyers === 0;
  return (
    <Row
      label="First blocks"
      hint="Snipers and same-slot buyers right after launch."
      tone={clean ? "ok" : fb.sameSlotBuyers > 0 || Number(fb.sniperPct) > 5 ? "warn" : "neutral"}
      value={
        <span className="block text-right">
          {clean ? "No snipers" : `${fb.snipers} snipers · ${fb.sniperPct}%`}
          {fb.sameSlotBuyers > 0 && <span className="block">{`${fb.sameSlotBuyers} same-slot buyers · ${fb.sameSlotPct}%`}</span>}
          {(fb.unzeenLaunchBuy || unzeen) && <span className="block text-faint-foreground">unzeen launch buy (by design)</span>}
        </span>
      }
    />
  );
}

function DevHistory({ dev, unzeen }: { dev: TokenSafety["dev"]; unzeen: boolean }) {
  if (unzeen) return <Row label="Dev history" tone="neutral" value="Anonymous by design" />;
  if (!dev) return <Row label="Dev history" tone="na" value={<NotYet />} />;
  const since = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(dev.since);
  return (
    <Row
      label="Dev history"
      hint={`Seen by unzeen since ${since}. Rugs = sold 50%+ within an hour; a lower bound.`}
      tone={dev.rugsSeen > 0 ? "warn" : "neutral"}
      value={
        <span className="block text-right">
          launched {dev.launchesSeen} · rugged {dev.rugsSeen}
          <span className="block font-mono text-[11px] text-faint-foreground">{shortAddr(dev.address, 4, 4)}</span>
        </span>
      }
    />
  );
}

function Socials({ socials }: { socials: TokenSafety["socials"] }) {
  const links = (
    [
      ["twitter", socials?.twitter, XLogo],
      ["telegram", socials?.telegram, PaperPlaneTilt],
      ["website", socials?.website, GlobeSimple],
    ] as const
  )
    .map(([k, url, Icon]) => ({ k, Icon, t: normalizeExternal(url) }))
    .filter((x) => x.t !== null);
  return (
    <Row
      label="Socials"
      tone={links.length ? "neutral" : "na"}
      value={
        links.length === 0 ? (
          "None listed"
        ) : (
          <span className="flex flex-wrap justify-end gap-1.5">
            {links.map(({ k, Icon, t }) => (
              <LeaveLink
                key={k}
                href={t!.href}
                className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs text-muted-foreground transition-colors duration-150 hover:border-border-strong hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <Icon size={12} weight="light" aria-hidden />
                <span className="max-w-[9rem] truncate">{t!.host}</span>
              </LeaveLink>
            ))}
          </span>
        )
      }
    />
  );
}

function NotYet() {
  return <span className="text-faint-foreground">Not available yet</span>;
}

function Row({ label, value, tone, hint }: { label: string; value: React.ReactNode; tone: Tone; hint?: string }) {
  const Icon = tone === "ok" ? Check : tone === "warn" ? WarningCircle : Minus;
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-2.5 text-sm">
      <dt className="flex min-w-0 items-start gap-2 text-muted-foreground">
        <Icon
          size={13}
          weight={tone === "warn" ? "fill" : "light"}
          aria-label={tone === "ok" ? "OK" : tone === "warn" ? "Risk" : undefined}
          aria-hidden={tone !== "ok" && tone !== "warn"}
          className={cn("mt-[3px] shrink-0", tone === "ok" && "text-zec", tone === "warn" && "text-sell", (tone === "neutral" || tone === "na") && "text-faint-foreground/50")}
        />
        <span>
          {label}
          {hint && <span className="block text-[11px] leading-snug text-faint-foreground">{hint}</span>}
        </span>
      </dt>
      <dd className={cn("tabular shrink-0 text-right", tone === "warn" ? "text-foreground" : "text-foreground/85", "max-w-[60%]")}>{value}</dd>
    </div>
  );
}

function Meter({ pct, label, warn }: { pct: number; label: string; warn?: boolean }) {
  const w = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden className="relative h-1 w-16 overflow-hidden rounded-full bg-surface-3">
        <motion.span
          className={cn("absolute inset-0 origin-left rounded-full", warn ? "bg-sell/80" : "bg-zec/80")}
          initial={{ scaleX: 0 }}
          animate={{ scaleX: w / 100 }}
          transition={{ duration: 0.5, ease: EASE }}
        />
      </span>
      {label}
    </span>
  );
}

/** "Unzeen launch: dev anonymous, rules enforced" with the rules folded underneath. No numbers about the creator. */
function UnzeenBadge({ rules }: { rules: UnzeenRule[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { pool } = usePool();
  const shown = rules.map((r) => ({ r, text: ruleText(r, pool?.launchRules) })).filter((x) => x.text !== null);
  return (
    <div className="border-b border-border/60 px-4 py-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-rules`}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 rounded-xl border border-zec/30 bg-zec/[0.06] px-3 py-2.5 text-left transition-colors duration-150 hover:border-zec/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ShieldCheck size={16} weight="duotone" className="shrink-0 text-zec" aria-hidden />
        <span className="min-w-0 flex-1 text-sm">
          <span className="font-medium">Unzeen launch</span>
          <span className="text-muted-foreground">: dev anonymous, rules enforced</span>
        </span>
        <CaretDown size={12} weight="light" className={cn("shrink-0 text-muted-foreground transition-transform duration-200", open && "rotate-180")} aria-hidden />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={`${id}-rules`}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: EASE }}
            style={{ overflow: "hidden" }}
          >
            <ul className="space-y-1.5 px-1 pt-3 text-sm">
              {shown.map(({ r, text }) => (
                <li key={r} className="flex items-start gap-2">
                  <Check size={13} weight="bold" className="mt-[3px] shrink-0 text-zec" aria-hidden />
                  {text}
                </li>
              ))}
            </ul>
            <p className="px-1 pt-2 text-[11px] text-pretty text-faint-foreground">
              {RULES_SCOPE} Enforced by the pool&apos;s ledger, not promised. The creator stays anonymous: no history, no numbers.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SafetySkeleton() {
  return (
    <div aria-busy className="space-y-3 px-4 py-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex justify-between gap-6">
          <Skeleton className="h-4 w-28 bg-skeleton" />
          <Skeleton className="h-4 bg-skeleton" style={{ width: `${40 + ((i * 23) % 50)}px` }} />
        </div>
      ))}
    </div>
  );
}
