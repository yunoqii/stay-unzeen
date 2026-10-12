"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Info, RocketLaunch, ShieldCheck } from "@phosphor-icons/react";
import { ApiError, errorText } from "@/lib/api/client";
import type { PoolInfo } from "@/lib/api/types";
import { useKeyState } from "@/lib/crypto/session";
import { postFair } from "@/lib/fair/api";
import { creatorMaxTier } from "@/lib/fair/tiers";
import { formatZec } from "@/lib/format";
import { validateMeta, type MetaInput } from "@/lib/launch";
import { useNetwork } from "@/lib/network";
import { cn } from "@/lib/utils";
import { usePortfolio } from "@/hooks/use-portfolio";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { LaunchRulesCard } from "@/components/launch/launch-rules-card";
import { FeedPreview, FormStep, LaunchDisabled, LaunchKeyPrompt, SummaryRow } from "@/components/launch/launch-form";
import { TokenMetaFields } from "@/components/launch/token-meta-fields";
import { FairReveal } from "./fair-reveal";
import { windowLabel } from "./parts";

export const SEALED_PITCH = "Everyone buys in one transaction at one price when the drand round fires. No one — including us — can see bids before that.";

/**
 * Sealed-bid launch: fl_create opens a bid window. The launch shows up publicly at the next Delayed
 * batch boundary, not at the moment of this request. Pump.fun only in v1. The creator's own bid is a
 * separate step on the launch page, capped like an instant launch's first buy.
 */
export function FairCreateForm({ pool, meta, onMeta }: { pool: PoolInfo; meta: MetaInput; onMeta: (m: MetaInput) => void }) {
  const router = useRouter();
  const network = useNetwork();
  const key = useKeyState();
  const unlocked = key.status === "unlocked";
  const { portfolio, refresh } = usePortfolio();
  const params = pool.fairLaunch;
  const windows = params?.windowsSecs ?? [];
  const [windowSecs, setWindowSecs] = useState<number | null>(windows.length ? windows[Math.min(1, windows.length - 1)] : null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const metaErrors = useMemo(() => validateMeta(meta), [meta]);
  const metaOk = Object.keys(metaErrors).length === 0;
  const fee = pool.fees?.createFeeZat && /^\d+$/.test(pool.fees.createFeeZat) ? BigInt(pool.fees.createFeeZat) : null;
  const balance = portfolio ? BigInt(portfolio.zecBalance) : null;
  const short = fee !== null && balance !== null && balance < fee;
  const curveUnknown = !params || params.maxTotalLamports === null;
  const capTier = params ? creatorMaxTier(params.holdTiersZat, params.creatorMaxLamports, pool.rate?.lamportsPerZecBuy) : null;

  if (pool.createEnabled === false) return <LaunchDisabled />;

  const canSubmit = unlocked && !busy && metaOk && windowSecs !== null && !short && !curveUnknown && portfolio !== null && !portfolio.frozen;

  const submit = async () => {
    setTried(true);
    if (!canSubmit || windowSecs === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await postFair(network, {
        op: "fl_create",
        venue: "pumpfun",
        meta: { name: meta.name.trim(), symbol: meta.symbol, ...(meta.image ? { image: meta.image } : {}) },
        windowSecs,
      });
      void refresh();
      if (r.launchId) router.push(`/launch/${r.launchId}`);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError("internal", String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-8">
          <FormStep n="01" title="Token">
            <TokenMetaFields value={meta} onChange={onMeta} errors={metaErrors} showErrors={tried} disabled={busy} />
          </FormStep>

          <FormStep n="02" title="Venue" hint="sealed launches: pump.fun for now">
            <div className="flex items-center gap-3 rounded-2xl border border-zec/40 bg-zec/[0.04] p-4">
              <RocketLaunch size={20} weight="duotone" className="text-zec" aria-hidden />
              <div>
                <p className="text-sm font-medium">pump.fun</p>
                <p className="text-xs text-muted-foreground">Create and the pooled buy go out as one atomic transaction from one vault.</p>
              </div>
            </div>
          </FormStep>

          <FormStep n="03" title="Bid window">
            <div role="radiogroup" aria-label="Bid window" className="flex flex-wrap gap-1.5">
              {windows.map((w) => (
                <Chip key={w} role="radio" aria-checked={windowSecs === w} active={windowSecs === w} onClick={() => setWindowSecs(w)} disabled={busy}>
                  {windowLabel(w)}
                  {w <= 120 && <span className="ml-1.5 text-faint-foreground">demo</span>}
                </Chip>
              ))}
            </div>
            <p className="mt-3 flex gap-2 text-xs text-pretty text-muted-foreground">
              <Info size={14} weight="light" className="mt-px shrink-0" aria-hidden />
              <span>
                {SEALED_PITCH} The round is set a few seconds after the window closes; the bid count is revealed only after it, and only if there are at least {params?.minBidsForCount ?? 5}.
              </span>
            </p>
          </FormStep>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-[calc(var(--header-h)+1.5rem)] lg:self-start">
          <p className="text-xs text-muted-foreground">In the feed, after the round</p>
          <FeedPreview meta={meta} venue="pumpfun" />
          <dl className="space-y-2 rounded-2xl border border-border p-4">
            <SummaryRow label="Launch fee" value={fee === null ? "—" : `${formatZec(fee.toString())} ZEC`} strong />
            <SummaryRow label="If nothing launches" value="fee returned" />
            <SummaryRow label="Your own bid" value={capTier !== null ? `up to ${formatZec(capTier.toString())} ZEC hold` : "next step"} />
            <SummaryRow label="Balance" value={!unlocked ? "locked" : balance === null ? "…" : `${formatZec(balance.toString())} ZEC`} className={cn(short && "[&_dd]:text-sell")} />
          </dl>
          <p className="text-[11px] text-pretty text-faint-foreground">
            The launch appears publicly at the next batch boundary, not the moment you sign, so its timing does not point at you.
          </p>
          {curveUnknown && (
            <p role="status" className="rounded-xl bg-zec-soft p-3 text-xs text-zec">
              Sealed launches are waiting for the pool to publish curve parameters. Try an instant launch, or check back shortly.
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
              <Button onClick={submit} disabled={busy || (tried && !canSubmit) || curveUnknown} aria-busy={busy} className={cn("h-12 w-full rounded-full text-[15px]", busy && "busy-hatch disabled:opacity-90")}>
                {busy ? "Signing…" : `Open bids for $${meta.symbol || "TICKER"}`}
              </Button>
              <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-faint-foreground">
                <ShieldCheck size={12} weight="light" aria-hidden />
                Signed in this browser. Bids are sealed in each bidder&apos;s browser.
              </p>
            </>
          )}
        </aside>
      </div>

      <div className="mt-10 border border-border">
        <LaunchRulesCard extra={["Bids time-locked to a drand round: unreadable until it fires", "One transaction, one price for every bidder"]} firstBuyLabel="Your own bid" />
      </div>

      <h2 className="mt-12 mb-3 text-sm font-medium">How the reveal works</h2>
      <div className="border border-border">
        <FairReveal />
      </div>
    </div>
  );
}
