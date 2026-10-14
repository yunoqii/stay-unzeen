"use client";

import { onTabListKeyDown } from "@/lib/tabs";
import { forwardRef, useEffect, useId, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUpRight, CheckCircle, ShieldWarning, WarningCircle, X } from "@phosphor-icons/react";
import { ApiError, errorText } from "@/lib/api/client";
import type { PoolInfo, Portfolio, SignedAction, Token } from "@/lib/api/types";
import { lastRate, submitAction, useAction, useActivityVersion } from "@/lib/activity";
import { formatCompact, formatSol, formatUnits, formatZec, lamportsToSol, parseUnits, shortAddr, unitsToNumber, ZEC_DECIMALS } from "@/lib/format";
import { ExecLane } from "@/components/trade/exec-lane";
import { WITHDRAW_EXEC_DEFAULT, withExec, type WithdrawExecMode } from "@/lib/exec";
import { CHAIN_LABEL, chainOf, useNetwork } from "@/lib/network";
import { nativeOf } from "@/lib/chain";
import { checkEvmAddress } from "@/lib/evm";
import { isSolanaAddress, payoutReviewed, PAYOUT_REVIEW_TEXT, WITHDRAW_ZEC_FEE_ZAT, withdrawTokenFee } from "@/lib/trade";
import { checkWithdrawUa } from "@/lib/zcash/ua";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TokenGlyph } from "@/components/tokens/token-glyph";
import { ActionStatusCard } from "@/components/trade/action-status";
import { Veiled } from "./peek";
import { ScatterParts } from "./scatter-parts";
import { CoinZec } from "@/components/icons/coin-zec";

export type WithdrawTab = "token" | "zec";
const DELAYS_MIN = [5, 15, 60, 240];

/** "Dissolve" (FRONTEND.md moment 7): what you send fades out of your view, blurred and shrinking. */
const dissolve = {
  initial: { opacity: 0, filter: "blur(6px)" },
  animate: { opacity: 1, filter: "blur(0px)", scale: 1 },
  exit: { opacity: 0, filter: "blur(14px)", scale: 0.9, transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] } },
  transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] },
} as const;

interface Props {
  tab: WithdrawTab;
  onTab: (t: WithdrawTab) => void;
  mint: string | null;
  onMint: (m: string) => void;
  portfolio: Portfolio;
  tokens: Token[] | null;
  pool: PoolInfo | null;
  onClose: () => void;
}

export const WithdrawPanel = forwardRef<HTMLElement, Props>(function WithdrawPanel(
  { tab, onTab, mint, onMint, portfolio, tokens, pool, onClose },
  ref,
) {
  const id = useId();
  const network = useNetwork();
  return (
    <section ref={ref} aria-labelledby={`${id}-t`} className="scroll-mt-24 rounded-2xl border border-border-strong bg-card/80 p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 id={`${id}-t`} className="font-medium">
          Withdraw
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close withdraw"
          className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <X size={14} weight="light" />
        </button>
      </div>
      <div role="tablist" aria-label="What to withdraw" onKeyDown={onTabListKeyDown} className="mt-4 grid grid-cols-2 gap-1 rounded-full border border-border p-1">
        {(["token", "zec"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            tabIndex={tab === t ? 0 : -1}
            onClick={() => onTab(t)}
            className={cn(
              "relative rounded-full py-2 text-sm transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              tab === t ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab === t && <motion.span layoutId={`${id}-tab`} className="absolute inset-0 rounded-full bg-surface-3" transition={{ type: "spring", bounce: 0, duration: 0.3 }} />}
            <span className="relative">{t === "token" ? `Tokens → ${CHAIN_LABEL[chainOf(network)]}` : "ZEC → shielded"}</span>
          </button>
        ))}
      </div>
      {tab === "token" ? (
        <TokenWithdraw portfolio={portfolio} tokens={tokens} mint={mint} onMint={onMint} pool={pool} />
      ) : (
        <ZecWithdraw portfolio={portfolio} pool={pool} />
      )}
    </section>
  );
});

// ---- tokens -> fresh Solana address(es) ----

function TokenWithdraw({ portfolio, tokens, mint, onMint, pool }: { portfolio: Portfolio; tokens: Token[] | null; mint: string | null; onMint: (m: string) => void; pool?: PoolInfo | null }) {
  const network = useNetwork();
  // v0.18: Robinhood Chain withdraws to 0x addresses (EIP-55); Solana to base58.
  const evm = chainOf(network) === "hood";
  const kind = evm ? "0x" : "Solana";
  const native = nativeOf(network).symbol;
  useActivityVersion();
  const ids = useId();
  const owned = portfolio.holdings.filter((h) => h.amount !== "0");
  const byMint = new Map((tokens ?? []).map((t) => [t.mint, t]));
  const selected = owned.find((h) => h.mint === mint) ?? owned[0] ?? null;
  const token = selected ? byMint.get(selected.mint) : undefined;

  const [amount, setAmount] = useState("");
  const [smart, setSmart] = useState(false);
  const [parts, setParts] = useState(2);
  const [maxDelay, setMaxDelay] = useState(15);
  const [addrs, setAddrs] = useState<string[]>(["", "", "", "", ""]);
  const [touched, setTouched] = useState<boolean[]>([false, false, false, false, false]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [sentId, setSentId] = useState<string | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  // Never "now", and the profile default does not apply to withdrawals (lib/exec.ts).
  const [exec, setExec] = useState<WithdrawExecMode>(WITHDRAW_EXEC_DEFAULT);
  const sent = useAction(sentId);

  if (sent) return <Sent action={sent} ghost={ghost} onAgain={() => setSentId(null)} />;

  if (!selected || !token)
    return (
      <p className="mt-6 rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
        {owned.length === 0 ? "No tokens to withdraw yet." : "Loading tokens…"}
      </p>
    );

  const n = smart ? parts : 1;
  const dests = addrs.slice(0, n).map((a) => a.trim());
  const available = BigInt(selected.amount);
  let parsed: bigint | null = null;
  let amountError: string | null = null;
  if (amount.trim()) {
    try {
      parsed = BigInt(parseUnits(amount, token.decimals));
      if (parsed === BigInt(0)) amountError = "Enter an amount above zero.";
      else if (parsed > available) amountError = "More than you hold.";
      else if (parsed < BigInt(n)) amountError = "Too small to split.";
    } catch {
      amountError = `Use a number with up to ${token.decimals} decimals.`;
    }
  }
  const addrErrors = dests.map((a, i) => {
    if (!a) return touched[i] ? `Paste a ${kind} address.` : null;
    if (evm) {
      const v = checkEvmAddress(a);
      if (!v.ok) return v.message;
    } else if (!isSolanaAddress(a)) return "Not a Solana address.";
    if (dests.findIndex((d) => d.toLowerCase() === a.toLowerCase()) !== i) return "Use a different address for each part.";
    return null;
  });
  const rate = lastRate(network, "buy");
  const perPart = pool?.fees?.withdrawTokenGasLamports ? BigInt(pool.fees.withdrawTokenGasLamports) + BigInt(pool.fees.withdrawTokenCostLamports ?? "0") : null;
  const fee = withdrawTokenFee(n, rate, evm ? perPart : null);
  const zecShort = fee.zat !== null && BigInt(portfolio.zecBalance) < fee.zat;
  const ready = parsed !== null && !amountError && dests.every((a, i) => a && !addrErrors[i]) && !busy && !portfolio.frozen;

  const submit = async () => {
    setTouched([true, true, true, true, true]);
    if (!ready || parsed === null) return;
    setBusy(true);
    setError(null);
    const action: SignedAction = withExec(
      smart
        ? { op: "withdraw_token", mint: selected.mint, amount: parsed.toString(), to: dests, smart: { parts, maxDelayMin: maxDelay } }
        : { op: "withdraw_token", mint: selected.mint, amount: parsed.toString(), to: dests[0] },
      exec,
    );
    try {
      const it = await submitAction(network, action, { op: "withdraw_token", mint: selected.mint, symbol: token.symbol, decimals: token.decimals, amount: parsed.toString(), parts: n });
      setGhost({
        symbol: token.symbol,
        image: token.image,
        // A1: never the exact sum; the real parts come with the status.
        label: `≈ ${formatCompact(unitsToNumber(parsed.toString(), token.decimals))}`,
        ...(smart && parts > 1 ? { addrs: dests.slice(0, parts), maxDelayMin: maxDelay } : {}),
      });
      setSentId(it.id);
      setAmount("");
      setAddrs(["", "", "", "", ""]);
      setTouched([false, false, false, false, false]);
      setExec(WITHDRAW_EXEC_DEFAULT);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError("internal", String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-5 space-y-5">
      {owned.length > 1 && (
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="radiogroup" aria-label="Token">
          {owned.map((h) => {
            const t = byMint.get(h.mint);
            const on = h.mint === selected.mint;
            return (
              <button
                key={h.mint}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => {
                  onMint(h.mint);
                  setAmount("");
                  setError(null);
                }}
                className={cn(
                  "inline-flex shrink-0 items-center gap-2 rounded-full border py-1 pr-3 pl-1 text-sm transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  on ? "border-zec/50 bg-zec/10" : "border-border text-muted-foreground hover:border-border-strong",
                )}
              >
                <TokenGlyph symbol={t?.symbol ?? "?"} image={t?.image} className="size-6 rounded-full text-[9px]" />${t?.symbol ?? shortAddr(h.mint)}
              </button>
            );
          })}
        </div>
      )}

      <div>
        <div className="flex items-baseline justify-between text-xs">
          <label htmlFor={`${ids}-amt`} className="text-muted-foreground">
            Amount
          </label>
          <span className="text-faint-foreground">
            You hold{" "}
            <span className="tabular text-muted-foreground">
              <Veiled>{formatCompact(unitsToNumber(selected.amount, token.decimals))}</Veiled> ${token.symbol}
            </span>
          </span>
        </div>
        <div className={cn("mt-2 flex h-14 items-center gap-3 rounded-2xl border bg-surface-1 px-3 focus-within:border-ring", amountError ? "border-destructive/60" : "border-border")}>
          <TokenGlyph symbol={token.symbol} image={token.image} className="size-8 rounded-full text-[10px]" />
          <input
            id={`${ids}-amt`}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={amount}
            onChange={(e) => {
              setError(null);
              setAmount(e.target.value.replace(",", "."));
            }}
            aria-invalid={!!amountError}
            className="tabular min-w-0 flex-1 bg-transparent text-2xl font-medium tracking-tight outline-none placeholder:text-faint-foreground"
          />
          <div className="flex shrink-0 gap-1">
            {[50, 100].map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setAmount(formatUnits(((available * BigInt(p)) / BigInt(100)).toString(), token.decimals))}
                className="h-7 rounded-full border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {p === 100 ? "All" : "Half"}
              </button>
            ))}
          </div>
        </div>
        {amountError && <p className="mt-1.5 text-xs text-sell">{amountError}</p>}
      </div>

      {parsed !== null && !amountError && (
        <p role="note" className="-mt-3 text-xs text-pretty text-faint-foreground">
          <span className="tabular text-muted-foreground">
            ≈ {formatCompact(unitsToNumber(parsed.toString(), token.decimals))} ${token.symbol}
          </span>{" "}
          · The exact sum is rounded by the server so it never matches your buy. The pool sends 0.5–2 % less{n > 1 ? ", each part rounded" : ""}; the rest stays in your holding.
        </p>
      )}

      <div className="space-y-2">
        <p className="flex items-start gap-2 rounded-xl border border-zec/25 bg-zec-soft px-3 py-2.5 text-xs text-pretty text-zec">
          <ShieldWarning size={15} weight="light" className="mt-px shrink-0" aria-hidden />
          <span>
            <span className="font-medium">Use a fresh address — not your main wallet.</span>{" "}
            <span className="text-zec/80">Whatever else that address touches becomes linked to these tokens.</span>
          </span>
        </p>
        {Array.from({ length: n }, (_, i) => (
          <div key={i}>
            <label htmlFor={`${ids}-to-${i}`} className="sr-only">
              {n > 1 ? `${kind} address ${i + 1}` : `${kind} address`}
            </label>
            <input
              id={`${ids}-to-${i}`}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={evm ? (n > 1 ? `Fresh 0x address ${i + 1}` : "Fresh 0x… address") : n > 1 ? `Fresh Solana address ${i + 1}` : "Fresh Solana address"}
              value={addrs[i]}
              onChange={(e) => {
                setError(null);
                setAddrs((a) => a.map((v, j) => (j === i ? e.target.value : v)));
              }}
              onBlur={() => setTouched((t) => t.map((v, j) => (j === i ? true : v)))}
              aria-invalid={!!addrErrors[i]}
              className={cn(
                "h-11 w-full rounded-xl border bg-surface-1 px-3 font-mono text-xs outline-none placeholder:font-sans placeholder:text-sm placeholder:text-faint-foreground focus-visible:border-ring",
                addrErrors[i] ? "border-destructive/60" : "border-border",
              )}
            />
            {addrErrors[i] && <p className="mt-1 text-xs text-sell">{addrErrors[i]}</p>}
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-border">
        <label className="flex cursor-pointer items-start gap-3 px-3 py-3">
          <input type="checkbox" role="switch" checked={smart} onChange={(e) => setSmart(e.target.checked)} className="peer sr-only" />
          <span aria-hidden className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full border border-border-strong bg-surface-2 transition-colors peer-checked:bg-zec/30 peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
            <span className={cn("absolute top-0.5 left-0.5 size-3.5 rounded-full bg-muted-foreground transition-transform duration-200", smart && "translate-x-4 bg-zec")} />
          </span>
          <span className="text-sm">
            Smart withdraw
            <span className="mt-0.5 block text-xs text-faint-foreground">Split into uneven parts, each to its own fresh address, each at its own random time.</span>
          </span>
        </label>
        <AnimatePresence initial={false}>
          {smart && (
            <motion.div
              key="smart"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              style={{ overflow: "hidden" }}
            >
              <div className="grid gap-3 border-t border-border/60 px-3 py-3 sm:grid-cols-2">
                <fieldset>
                  <legend className="text-xs text-muted-foreground">Parts</legend>
                  <div className="mt-1.5 flex gap-1">
                    {[2, 3, 4, 5].map((p) => (
                      <Pill key={p} on={parts === p} onClick={() => setParts(p)}>
                        {p}
                      </Pill>
                    ))}
                  </div>
                </fieldset>
                <fieldset>
                  <legend className="text-xs text-muted-foreground">Max delay</legend>
                  <div className="mt-1.5 flex gap-1">
                    {DELAYS_MIN.map((d) => (
                      <Pill key={d} on={maxDelay === d} onClick={() => setMaxDelay(d)}>
                        {d < 60 ? `${d}m` : `${d / 60}h`}
                      </Pill>
                    ))}
                  </div>
                </fieldset>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border px-3 py-3">
        <input type="checkbox" role="switch" checked={exec === "max"} onChange={(e) => setExec(e.target.checked ? "max" : "delayed")} className="peer sr-only" />
        <span aria-hidden className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full border border-border-strong bg-surface-2 transition-colors peer-checked:bg-zec/30 peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
          <span className={cn("absolute top-0.5 left-0.5 size-3.5 rounded-full bg-muted-foreground transition-transform duration-200", exec === "max" && "translate-x-4 bg-zec")} />
        </span>
        <span className="text-sm">
          Max privacy <span className="text-muted-foreground">(10–60 min)</span>
          <span className="mt-0.5 block text-xs text-pretty text-faint-foreground">
            Withdrawals are never instant: a quick one right after a buy would tie the two together on-chain.
          </span>
          <ExecLane mode={exec} gateLabel="random delay" endLabel="your address" />
        </span>
      </label>

      <dl className="space-y-1.5 text-xs">
        <Row k="Gas">
          {formatSol(lamportsToSol(fee.lamports.toString()))} {native}{n > 1 ? ` (${n} addresses)` : ""} dropped with the tokens
          {fee.zat !== null && <span className="text-faint-foreground"> · ≈ {formatZec(fee.zat.toString())} ZEC from balance</span>}
        </Row>
        <Row k="Delay">
          {smart
            ? `Random, each part within ${maxDelay < 60 ? `${maxDelay} min` : `${maxDelay / 60} h`}`
            : exec === "max"
                ? "Random, 10 – 60 min"
                : "Random, 30 s – 5 min"}
        </Row>
        <Row k="Sent from">A different pool vault than your buys</Row>
      </dl>
      {zecShort && <p className="text-xs text-sell">Not enough ZEC on your balance to pay the gas. Top up first.</p>}

      {error && <ErrorBox error={error} />}

      <Button onClick={submit} disabled={busy || portfolio.frozen} aria-busy={busy} className={cn("h-12 w-full rounded-full text-[15px]", busy && "busy-hatch disabled:opacity-90")}>
        <ArrowUpRight weight="bold" />
        {busy ? "Signing…" : `Withdraw $${token.symbol}`}
      </Button>
    </div>
  );
}

// ---- ZEC -> shielded UA ----

function ZecWithdraw({ portfolio, pool }: { portfolio: Portfolio; pool: PoolInfo | null }) {
  const network = useNetwork();
  const ids = useId();
  const [to, setTo] = useState("");
  const [toTouched, setToTouched] = useState(false);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [sentId, setSentId] = useState<string | null>(null);
  const sent = useAction(sentId);

  if (sent) return <Sent action={sent} onAgain={() => setSentId(null)} />;

  const verdict = checkWithdrawUa(to, network);
  const showUa = toTouched || to.trim().length > 12;
  const balance = BigInt(portfolio.zecBalance);
  const maxOut = balance > WITHDRAW_ZEC_FEE_ZAT ? balance - WITHDRAW_ZEC_FEE_ZAT : BigInt(0);
  const min = pool ? BigInt(pool.minActionZat) : null;
  let parsed: bigint | null = null;
  let amountError: string | null = null;
  if (amount.trim()) {
    try {
      parsed = BigInt(parseUnits(amount, ZEC_DECIMALS));
      if (parsed === BigInt(0)) amountError = "Enter an amount above zero.";
      else if (parsed > maxOut) amountError = `Up to ${formatZec(maxOut.toString())} ZEC after the network fee.`;
      else if (min !== null && parsed < min) amountError = `The minimum is ${formatZec(min.toString())} ZEC.`;
    } catch {
      amountError = "Use a number with up to 8 decimals.";
    }
  }
  const ready = verdict.ok && parsed !== null && !amountError && !busy && !portfolio.frozen;
  // v0.17 (A2): mainnet payouts above 1 ZEC wait for the operator.
  const reviewed = parsed !== null && !amountError && payoutReviewed(network, parsed);

  const submit = async () => {
    setToTouched(true);
    if (!ready || parsed === null) return;
    setBusy(true);
    setError(null);
    try {
      const it = await submitAction(network, { op: "withdraw_zec", to: to.trim(), amount: parsed.toString() }, { op: "withdraw_zec", amount: parsed.toString() });
      setSentId(it.id);
      setTo("");
      setAmount("");
      setToTouched(false);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError("internal", String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-5 space-y-5">
      <div>
        <label htmlFor={`${ids}-ua`} className="text-xs text-muted-foreground">
          Shielded Unified Address
        </label>
        <textarea
          id={`${ids}-ua`}
          rows={3}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder={network !== "devnet" ? "u1…  from ZODL or another shielded wallet" : "utest1…  from a testnet shielded wallet"}
          value={to}
          onChange={(e) => {
            setError(null);
            setTo(e.target.value);
          }}
          onBlur={() => setToTouched(true)}
          aria-invalid={showUa && !verdict.ok}
          aria-describedby={`${ids}-ua-hint`}
          className={cn(
            "mt-2 w-full resize-none rounded-xl border bg-surface-1 px-3 py-2.5 font-mono text-xs break-all outline-none placeholder:font-sans placeholder:text-sm placeholder:text-faint-foreground focus-visible:border-ring",
            showUa && !verdict.ok ? "border-destructive/60" : "border-border",
          )}
        />
        <p id={`${ids}-ua-hint`} className={cn("mt-1.5 flex items-start gap-1.5 text-xs text-pretty", showUa && !verdict.ok ? "text-sell" : "text-faint-foreground")}>
          {showUa && verdict.ok ? (
            <>
              <CheckCircle size={14} weight="light" className="mt-px shrink-0 text-zec" aria-hidden />
              <span className="text-muted-foreground">Shielded address with an Orchard receiver. Checked in your browser.</span>
            </>
          ) : showUa && !verdict.ok ? (
            verdict.message
          ) : (
            "Shielded only: transparent (t…) and Sapling (zs…) addresses are refused."
          )}
        </p>
      </div>

      <div>
        <div className="flex items-baseline justify-between text-xs">
          <label htmlFor={`${ids}-z`} className="text-muted-foreground">
            Amount
          </label>
          <button type="button" onClick={() => setAmount(formatUnits(maxOut.toString(), ZEC_DECIMALS))} className="text-faint-foreground hover:text-muted-foreground">
            Balance <span className="tabular text-muted-foreground"><Veiled>{formatZec(portfolio.zecBalance)}</Veiled> ZEC</span>
          </button>
        </div>
        <div className={cn("mt-2 flex h-14 items-center rounded-2xl border bg-surface-1 px-4 focus-within:border-ring", amountError ? "border-destructive/60" : "border-border")}>
          <input
            id={`${ids}-z`}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={amount}
            onChange={(e) => {
              setError(null);
              setAmount(e.target.value.replace(",", "."));
            }}
            aria-invalid={!!amountError}
            className="tabular min-w-0 flex-1 bg-transparent text-2xl font-medium tracking-tight outline-none placeholder:text-faint-foreground"
          />
          <span className="ml-3 inline-flex items-center gap-1 text-sm text-muted-foreground">
            <CoinZec size={14} />
            ZEC
          </span>
        </div>
        {amountError && <p className="mt-1.5 text-xs text-sell">{amountError}</p>}
      </div>

      <dl className="space-y-1.5 text-xs">
        <Row k="Network fee">{formatZec(WITHDRAW_ZEC_FEE_ZAT.toString())} ZEC</Row>
        <Row k="Delay">
          {reviewed ? `${PAYOUT_REVIEW_TEXT}: queued until approved, then batched` : "Random, 1 – 10 min, batched with other payouts"}
        </Row>
        <Row k="Privacy">Shielded to shielded. The pool keeps no outgoing record.</Row>
      </dl>

      {error && <ErrorBox error={error} />}

      <Button onClick={submit} disabled={busy || portfolio.frozen} aria-busy={busy} className={cn("h-12 w-full rounded-full text-[15px]", busy && "busy-hatch disabled:opacity-90")}>
        <ArrowUpRight weight="bold" />
        {busy ? "Signing…" : "Withdraw ZEC"}
      </Button>
    </div>
  );
}

// ---- shared bits ----

interface Ghost {
  symbol: string;
  image?: string;
  label: string;
  /** Smart withdraw: one fresh address per part (M4 split and scatter). */
  addrs?: string[];
  maxDelayMin?: number;
}

/** After sending: the tokens dissolve out of view, then the status takes their place. */
function Sent({ action, ghost, onAgain }: { action: Parameters<typeof ActionStatusCard>[0]["action"]; ghost?: Ghost | null; onAgain: () => void }) {
  const [showGhost, setShowGhost] = useState(!!ghost);
  useEffect(() => {
    if (!showGhost) return;
    const t = setTimeout(() => setShowGhost(false), 450);
    return () => clearTimeout(t);
  }, [showGhost]);
  const scatter = ghost?.addrs && ghost.addrs.length > 1 ? ghost : null;
  return (
    <div className="mt-5 space-y-4">
      {scatter && (
        <ScatterParts
          label={`${scatter.label} $${scatter.symbol}`}
          addrs={scatter.addrs!}
          maxDelayMin={scatter.maxDelayMin ?? 15}
          parts={action.status.parts}
          decimals={action.decimals}
          startedAt={action.submittedAt}
          settled={action.status.status === "executed" || action.status.status === "failed" ? action.status.status : null}
        />
      )}
      <AnimatePresence mode="wait" initial={false}>
        {showGhost && ghost && !scatter ? (
          <motion.div key="ghost" {...dissolve} className="flex items-center justify-center gap-3 py-6" aria-hidden>
            <TokenGlyph symbol={ghost.symbol} image={ghost.image} className="size-12 rounded-full text-xs" />
            <span className="tabular text-3xl font-medium tracking-tight">
              {ghost.label} <span className="text-lg text-muted-foreground">${ghost.symbol}</span>
            </span>
          </motion.div>
        ) : (
          <motion.div key={action.id} initial={{ opacity: 0, y: 6, filter: "blur(6px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}>
            <ActionStatusCard action={action} />
          </motion.div>
        )}
      </AnimatePresence>
      <Button variant="outline" onClick={onAgain} className="h-10 w-full rounded-full">
        New withdrawal
      </Button>
    </div>
  );
}

function ErrorBox({ error }: { error: ApiError }) {
  return (
    <p role="alert" className="flex gap-2 rounded-xl border border-sell/30 bg-sell/5 px-3 py-2.5 text-sm text-pretty text-foreground/90">
      <WarningCircle size={16} weight="light" className="mt-0.5 shrink-0 text-sell" aria-hidden />
      {error.code === "bad_request" ? "The pool refused this request. Check the addresses, and that the amount is not too small to split and round." : errorText(error)}
    </p>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-faint-foreground">{k}</dt>
      <dd className="text-right text-muted-foreground">{children}</dd>
    </div>
  );
}

function Pill({ on, children, onClick }: { on: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "tabular h-9 min-w-9 rounded-full border px-2.5 text-xs sm:h-8 transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        on ? "border-zec/50 bg-zec/10 text-foreground" : "border-border text-muted-foreground hover:border-border-strong",
      )}
    >
      {children}
    </button>
  );
}
