"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowRight, ArrowSquareOut, CaretDown, Copy, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { API_MODE } from "@/lib/api/client";
import { mockPay } from "@/lib/api/mock";
import type { PoolInfo } from "@/lib/api/types";
import { signMemo, useKeyState } from "@/lib/crypto/session";
import type { ChainId } from "@/lib/crypto/unz1";
import { depositFields, depositUri, poolChainId, PoolMismatchError } from "@/lib/deposit";
import { formatZec, shortAddr } from "@/lib/format";
import type { Network } from "@/lib/network";
import { zecToZat } from "@/lib/zip321";
import { cn } from "@/lib/utils";
import { useDepositTracker } from "@/hooks/use-deposit-tracker";
import { usePool } from "@/hooks/use-pool";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { KeyGate } from "@/components/key/key-gate";
import { PaySteps, type PayStep } from "./pay-steps";
import { QrRing } from "./qr-ring";

const PRESETS = ["0.1", "0.5", "1"];
/** Zcash target block time. */
const BLOCK_SEC = 75;

export function TopUpApp() {
  return (
    <KeyGate next="/pay">
      <TopUp />
    </KeyGate>
  );
}

function TopUp() {
  const { pool, error, network, retry } = usePool();
  const key = useKeyState();
  const [round, setRound] = useState(0);

  if (error)
    return (
      <Problem title="Can't load the pool">
        <p>{error}</p>
        <Button variant="outline" className="mt-4 h-10 rounded-full px-5" onClick={retry}>
          Try again
        </Button>
      </Problem>
    );
  if (!pool || key.status !== "unlocked") return <TopUpSkeleton />;

  let chainId: ChainId;
  try {
    chainId = poolChainId(pool, network);
  } catch (e) {
    if (!(e instanceof PoolMismatchError)) throw e;
    return (
      <Problem title="This pool doesn't match the selected network">
        <p>Payments are off: a memo signed for the wrong chain could not be credited.</p>
      </Problem>
    );
  }

  // A fresh memo (new nonce, expiry now + 24 h) per key, network, pool and round.
  return (
    <DepositRequest
      key={`${network}:${key.pubkey}:${pool.address}:${pool.chainId}:${round}`}
      pool={pool}
      chainId={chainId}
      network={network}
      onAgain={() => setRound((r) => r + 1)}
    />
  );
}

function DepositRequest({
  pool,
  chainId,
  network,
  onAgain,
}: {
  pool: PoolInfo;
  chainId: ChainId;
  network: Network;
  onAgain: () => void;
}) {
  // Signed here, with the key in memory. Never sent to Unzeen: it travels only inside the payment.
  const [memo] = useState(() => signMemo(depositFields(), chainId, network));
  const minZec = formatZec(pool.minDepositZat);
  const [amount, setAmount] = useState(() => (BigInt(pool.minDepositZat) > BigInt(10_000_000) ? minZec : "0.1"));
  const { phase, markSent } = useDepositTracker(network, memo ?? "");

  const amountZat = zecToZat(amount);
  const amountError =
    amount.trim() === ""
      ? "Enter an amount"
      : amountZat === null
        ? "Use a number with up to 8 decimals"
        : BigInt(amountZat) < BigInt(pool.minDepositZat)
          ? `Minimum is ${minZec} ZEC`
          : null;

  const uri = useMemo(
    () => (memo && amountZat && !amountError ? depositUri(pool, amountZat, memo) : null),
    [memo, amountZat, amountError, pool],
  );

  if (!memo) return <TopUpSkeleton />;

  const locked = phase.step !== "waiting"; // amount is fixed once a payment is on its way
  const ringState = phase.step === "credited" ? "credited" : phase.step === "seen" ? "seen" : phase.step === "waiting" ? "waiting" : "error";
  const progress =
    phase.step === "credited"
      ? 1
      : phase.step === "seen"
        ? phase.confirmations === null
          ? 0.12
          : Math.max(0.12, phase.confirmations / pool.confirmations)
        : 0;
  const etaMin = Math.max(1, Math.round((pool.confirmations * BLOCK_SEC) / 60));

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`);
    } catch {
      toast.error("Clipboard unavailable");
    }
  };

  const steps: PayStep[] = [
    {
      label: "Waiting for payment",
      detail: "Scan with ZODL or any wallet that reads ZIP-321. Address, amount and memo fill in.",
    },
    {
      label: API_MODE === "real" ? "Sent, confirming" : "Seen in mempool",
      detail:
        phase.step === "seen" && phase.confirmations !== null && phase.confirmations > 0
          ? `In a block · ${phase.confirmations} of ${pool.confirmations} confirmations`
          : `Credited after ${pool.confirmations} confirmations, about ${etaMin} min.`,
    },
    {
      label: "Credited",
      detail:
        phase.step === "credited" ? (
          <>
            +{formatZec(phase.deposit.amountZat)} ZEC. Balance now {formatZec(phase.balanceZat)} ZEC.
          </>
        ) : undefined,
    },
  ];
  const current = phase.step === "credited" ? 2 : phase.step === "seen" ? 1 : 0;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-10">
      {/* QR side */}
      <section aria-label="Payment QR" className="order-2 lg:order-1">
        <QrRing
          value={uri}
          progress={progress}
          state={ringState}
          dimmed={!uri || phase.step === "credited"}
          label={`Zcash payment request: ${amount} ZEC to the Unzeen pool`}
        />

        <div className="mx-auto mt-6 max-w-[22rem] space-y-2">
          <CopyRow label="Pool address" value={shortAddr(pool.address, 10, 8)} onCopy={() => copy(pool.address, "Address")} />
          <CopyRow
            label="Amount"
            value={amountError ? "—" : `${formatZec(amountZat!)} ZEC`}
            onCopy={amountError ? undefined : () => copy(formatZec(amountZat!).replace(/,/g, ""), "Amount")}
          />
          <MemoRow memo={memo} onCopy={() => copy(memo, "Memo")} />
        </div>
      </section>

      {/* Controls side */}
      <div className="order-1 space-y-5 lg:order-2">
        <div>
          <label htmlFor="topup-amount" className="text-sm text-muted-foreground">
            Amount
          </label>
          <div
            className={cn(
              "mt-2 flex h-14 items-center rounded-2xl border bg-surface-1 px-4 transition-colors duration-150 focus-within:border-ring",
              amountError && amount.trim() !== "" ? "border-destructive/60" : "border-border",
              locked && "opacity-60",
            )}
          >
            <input
              id="topup-amount"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              value={amount}
              disabled={locked}
              onChange={(e) => setAmount(e.target.value.replace(",", "."))}
              aria-invalid={!!amountError}
              aria-describedby="topup-amount-hint"
              className="min-w-0 flex-1 bg-transparent text-2xl font-medium tabular outline-none placeholder:text-faint-foreground disabled:cursor-not-allowed"
              placeholder="0.1"
            />
            <span className="text-lg text-muted-foreground">ZEC</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p id="topup-amount-hint" className={cn("text-xs", amountError ? "text-destructive" : "text-faint-foreground")}>
              {amountError ?? `Minimum ${minZec} ZEC. Smaller payments are not credited.`}
            </p>
            <div className="flex gap-1.5">
              {PRESETS.filter((p) => BigInt(zecToZat(p)!) >= BigInt(pool.minDepositZat)).map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={locked}
                  onClick={() => setAmount(p)}
                  aria-pressed={amount === p}
                  className={cn(
                    "h-7 rounded-full border px-3 text-xs tabular transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50",
                    amount === p ? "border-zec/50 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        </div>

        {uri && phase.step === "waiting" && (
          <Button asChild size="lg" className="h-12 w-full rounded-full text-sm md:hidden">
            <a href={uri}>
              Open in wallet
              <ArrowSquareOut weight="light" />
            </a>
          </Button>
        )}

        <div className="rounded-2xl border border-border bg-card/60 p-2">
          <PaySteps steps={steps} current={current} done={phase.step === "credited"} />
        </div>

        <AnimatePresence initial={false} mode="popLayout">
          {phase.step === "dust" && (
            <PhaseNote key="dust" tone="zec">
              That payment was below {minZec} ZEC and stays with the pool. Send at least the minimum.
            </PhaseNote>
          )}
          {phase.step === "rejected" && (
            <PhaseNote key="rejected" tone="zec">
              That payment could not be linked to your key (missing or wrong memo, or another network). It is held for
              manual review.
            </PhaseNote>
          )}
        </AnimatePresence>

        {phase.step === "credited" ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button asChild size="lg" className="h-11 flex-1 rounded-full text-sm">
              <Link href="/portfolio">
                Back to portfolio
                <ArrowRight weight="light" />
              </Link>
            </Button>
            <Button variant="outline" size="lg" className="h-11 flex-1 rounded-full text-sm" onClick={onAgain}>
              Top up again
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            {API_MODE === "real" && phase.step === "waiting" && uri && (
              <Button variant="outline" size="lg" className="h-11 flex-1 rounded-full text-sm" onClick={markSent}>
                I&apos;ve sent it
              </Button>
            )}
            {API_MODE === "mock" && uri && (phase.step === "waiting" || phase.step === "dust" || phase.step === "rejected") && (
              <button
                type="button"
                onClick={() => {
                  try {
                    mockPay(network, uri);
                    toast("Mock wallet sent the payment");
                  } catch {
                    toast.error("The mock wallet rejected this URI");
                  }
                }}
                className="h-11 flex-1 rounded-full border border-dashed border-border-strong px-4 font-mono text-xs tracking-wide text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                Simulate payment (mock)
              </button>
            )}
          </div>
        )}

        <ul className="space-y-2 border-t border-border/60 pt-4 text-xs text-pretty text-muted-foreground">
          <li className="flex gap-2">
            <ShieldCheck size={14} weight="light" className="mt-px shrink-0 text-zec" aria-hidden />
            Built in your browser. Unzeen learns about this payment only when it lands on chain, never who asked for
            it.
          </li>
          <li className="flex gap-2">
            <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-faint-foreground" />
            Reusable for 24 hours or longer: every payment with this memo is credited to your key.
          </li>
        </ul>
      </div>
    </div>
  );
}

function CopyRow({ label, value, onCopy }: { label: string; value: string; onCopy?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-1 px-3 py-2">
      <div className="min-w-0">
        <p className="text-[11px] text-faint-foreground">{label}</p>
        <p className="truncate font-mono text-xs tabular">{value}</p>
      </div>
      {onCopy && (
        <button
          type="button"
          onClick={onCopy}
          aria-label={`Copy ${label.toLowerCase()}`}
          className="grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Copy size={16} weight="light" />
        </button>
      )}
    </div>
  );
}

function MemoRow({ memo, onCopy }: { memo: string; onCopy: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-border bg-surface-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span className="text-xs text-muted-foreground">Paying by hand? Memo</span>
        <CaretDown size={14} weight="light" className={cn("text-muted-foreground transition-transform duration-150", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="memo"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            style={{ overflow: "hidden" }}
          >
            <div className="px-3 pb-3">
              <p className="font-mono text-[11px] leading-relaxed break-all text-muted-foreground">{memo}</p>
              <p className="mt-2 text-[11px] text-pretty text-faint-foreground">
                Paste it exactly. Without this memo the payment can&apos;t be credited to your key.
              </p>
              <Button variant="outline" size="sm" className="mt-2 rounded-full" onClick={onCopy}>
                <Copy weight="light" />
                Copy memo
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function PhaseNote({ children, tone }: { children: React.ReactNode; tone: "zec" }) {
  return (
    <motion.div
      initial={{ opacity: 0, filter: "blur(6px)" }}
      animate={{ opacity: 1, filter: "blur(0px)" }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
    >
      <Notice icon={<WarningCircle size={16} weight="light" />} tone={tone}>
        {children}
      </Notice>
    </motion.div>
  );
}

function Notice({ icon, tone, children }: { icon: React.ReactNode; tone: "zec" | "muted"; children: React.ReactNode }) {
  return (
    <div
      role="status"
      className={cn(
        "flex gap-2 rounded-xl p-3 text-sm text-pretty",
        tone === "zec" ? "bg-zec-soft text-zec" : "bg-surface-1 text-muted-foreground",
      )}
    >
      <span className="mt-0.5 shrink-0" aria-hidden>
        {icon}
      </span>
      <div>{children}</div>
    </div>
  );
}

function Problem({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-md rounded-2xl border border-border bg-card/60 p-6 text-center text-sm text-muted-foreground">
      <WarningCircle size={28} weight="thin" className="mx-auto text-zec" aria-hidden />
      <p className="mt-3 font-medium text-foreground">{title}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function TopUpSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-2 lg:gap-10" aria-busy>
      <Skeleton className="mx-auto aspect-square w-full max-w-[22rem] rounded-full bg-skeleton" />
      <div className="space-y-4">
        <Skeleton className="h-14 rounded-2xl bg-skeleton" />
        <Skeleton className="h-40 rounded-2xl bg-skeleton" />
      </div>
    </div>
  );
}

