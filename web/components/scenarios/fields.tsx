"use client";

// Form pieces of the block inspector. Amounts are typed in whole units (ZEC, tokens) and kept as integer
// strings in base units; step references are draft uids (lib/scenarios/draft.ts).

import { useId, useState } from "react";
import { motion } from "motion/react";
import { CaretDown } from "@phosphor-icons/react";
import type { AmountSpec, Guard, MintRef, OnFail, OnFailTarget, PoolInfo, ScenarioBlockType, ScenarioPlan, TokenListItem } from "@/lib/api/types";
import type { Network } from "@/lib/network";
import { formatUnits, parseUnits, VENUE_LABEL } from "@/lib/format";
import { BLOCKS } from "@/lib/scenarios/catalog";
import { earlier, later, type Draft } from "@/lib/scenarios/draft";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface BuilderEnv {
  draft: Draft;
  plan: ScenarioPlan;
  tokens: TokenListItem[];
  tokenOf(mint: string): TokenListItem | null;
  pool: PoolInfo | null;
  network: Network;
}

export function Field({ label, hint, children, className }: { label: string; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="text-xs text-muted-foreground">{label}</div>
      {children}
      {hint && <p className="text-[11px] text-pretty text-faint-foreground">{hint}</p>}
    </div>
  );
}

export function Select({ value, onChange, children, label, className }: { value: string; onChange: (v: string) => void; children: React.ReactNode; label: string; className?: string }) {
  return (
    <div className={cn("relative min-w-0", className)}>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-full min-w-0 appearance-none truncate rounded-lg border border-input bg-surface-1 pr-8 pl-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
      >
        {children}
      </select>
      <CaretDown size={12} weight="light" aria-hidden className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-faint-foreground" />
    </div>
  );
}

/** Segmented choice with a sliding marker. */
export function Segmented<T extends string>({ value, options, onChange, label, className }: { value: T; options: { id: T; label: string; disabled?: boolean; title?: string }[]; onChange: (v: T) => void; label: string; className?: string }) {
  const id = useId();
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex gap-0.5 rounded-full border border-border p-0.5", className)}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.id)}
            className={cn(
              "relative flex-1 rounded-full px-2.5 py-1 text-xs whitespace-nowrap transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-35",
              on ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {on && <motion.span layoutId={`${id}-seg`} className="absolute inset-0 rounded-full bg-surface-3" transition={{ type: "spring", bounce: 0, duration: 0.25 }} />}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Decimal input that keeps base units; shows the stored value until the user types. */
export function UnitsInput({ value, decimals, onChange, suffix, label, placeholder }: { value: string; decimals: number; onChange: (base: string) => void; suffix: string; label: string; placeholder?: string }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const shown = text ?? (/^\d+$/.test(value) && value !== "0" ? formatUnits(value, decimals) : "");
  return (
    <div>
      <div className="relative">
        <Input
          inputMode="decimal"
          aria-label={label}
          aria-invalid={!!err}
          placeholder={placeholder ?? "0.0"}
          value={shown}
          onChange={(e) => {
            const t = e.target.value.replace(",", ".");
            setText(t);
            if (t.trim() === "") {
              setErr(null);
              onChange("0");
              return;
            }
            try {
              onChange(parseUnits(t, decimals));
              setErr(null);
            } catch (x) {
              setErr(x instanceof Error && x.message.startsWith("At most") ? x.message : "Numbers only");
            }
          }}
          onBlur={() => setText(null)}
          className="tabular pr-16"
        />
        <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-mono text-xs text-faint-foreground">{suffix}</span>
      </div>
      {err && <p className="mt-1 text-[11px] text-destructive">{err}</p>}
    </div>
  );
}

export function NumberInput({ value, onChange, label, min, max, suffix, step = 1 }: { value: number | undefined; onChange: (n: number) => void; label: string; min?: number; max?: number; suffix?: string; step?: number }) {
  return (
    <div className="relative">
      <Input
        type="number"
        inputMode="decimal"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value === undefined || !Number.isFinite(value) ? "" : value}
        onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))}
        className={cn("tabular", suffix && "pr-14")}
      />
      {suffix && <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-mono text-xs text-faint-foreground">{suffix}</span>}
    </div>
  );
}

const UNITS = [
  { id: "m", label: "min", secs: 60 },
  { id: "h", label: "h", secs: 3600 },
  { id: "d", label: "d", secs: 86_400 },
] as const;

/** Seconds, typed as a number of minutes / hours / days. */
export function DurationInput({ secs, onChange, label }: { secs: number; onChange: (s: number) => void; label: string }) {
  const best = [...UNITS].reverse().find((u) => Number.isFinite(secs) && secs > 0 && secs % u.secs === 0) ?? UNITS[0];
  const [unit, setUnit] = useState<(typeof UNITS)[number]["id"]>(best.id);
  const u = UNITS.find((x) => x.id === unit)!;
  const n = Number.isFinite(secs) ? Math.round((secs / u.secs) * 100) / 100 : NaN;
  return (
    <div className="flex gap-1.5">
      <Input
        type="number"
        inputMode="decimal"
        min={0}
        aria-label={label}
        value={Number.isFinite(n) ? n : ""}
        onChange={(e) => onChange(e.target.value === "" ? NaN : Math.round(Number(e.target.value) * u.secs))}
        className="tabular min-w-0 flex-1"
      />
      <Select label={`${label} unit`} value={unit} onChange={(v) => setUnit(v as typeof unit)} className="w-20 flex-none">
        {UNITS.map((x) => (
          <option key={x.id} value={x.id}>
            {x.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

// ---- references ----

const isStep = (r: unknown): r is { step: number } => !!r && typeof r === "object" && "step" in r;

/** Earlier steps that yield a mint (launch, rotation). */
const MINT_SOURCES: ScenarioBlockType[] = ["create", "swap"];

export function MintPicker({ env, uid, value, onChange, label = "Token", filter, allowSteps = true }: { env: BuilderEnv; uid: number; value: MintRef | undefined; onChange: (m: MintRef) => void; label?: string; filter?: (t: TokenListItem) => boolean; allowSteps?: boolean }) {
  const steps = allowSteps ? earlier(env.draft, uid).filter((s) => MINT_SOURCES.includes(s.block.type)) : [];
  const list = env.tokens.filter((t) => !filter || filter(t));
  const literal = typeof value === "string" ? value : "";
  const known = literal === "" || list.some((t) => t.mint === literal);
  const [paste, setPaste] = useState(!known);
  const sel = isStep(value) ? `s:${value.step}` : paste ? "paste" : literal ? `m:${literal}` : "";
  return (
    <Field label={label}>
      <Select
        label={label}
        value={sel}
        onChange={(v) => {
          if (v === "paste") {
            setPaste(true);
            onChange("");
          } else if (v.startsWith("s:")) {
            setPaste(false);
            onChange({ step: Number(v.slice(2)) });
          } else {
            setPaste(false);
            onChange(v.slice(2));
          }
        }}
      >
        <option value="" disabled>
          Choose a token
        </option>
        {steps.length > 0 && (
          <optgroup label="From this scenario">
            {steps.map((s) => (
              <option key={s.uid} value={`s:${s.uid}`}>
                {s.block.type === "create" ? `Token launched in step ${env.draft.steps.indexOf(s) + 1}` : `Token bought in step ${env.draft.steps.indexOf(s) + 1}`}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label="Pool tokens">
          {list.map((t) => (
            <option key={t.mint} value={`m:${t.mint}`}>
              ${t.symbol} · {VENUE_LABEL[t.venue]}
              {t.quote && t.quote !== "SOL" ? ` · ${t.quote}` : ""}
              {t.status === "graduated" ? " · graduated" : ""}
            </option>
          ))}
        </optgroup>
        <option value="paste">Paste a mint address…</option>
      </Select>
      {sel === "paste" && <Input aria-label={`${label} mint address`} placeholder="Mint address" value={literal} onChange={(e) => onChange(e.target.value.trim())} className="font-mono text-xs" spellCheck={false} autoComplete="off" />}
    </Field>
  );
}

/** Steps whose result a share can be taken of, by unit. */
const OUTPUTS: Record<"zat" | "tokens", ScenarioBlockType[]> = {
  zat: ["deposit_received", "sell", "sell_all", "claim"],
  tokens: ["buy", "create", "swap"],
};

export function AmountField({
  env,
  uid,
  value,
  onChange,
  unit,
  label = "Amount",
}: {
  env: BuilderEnv;
  uid: number;
  value: AmountSpec;
  onChange: (a: AmountSpec) => void;
  unit: { kind: "zat" } | { kind: "tokens"; decimals: number; symbol: string };
  label?: string;
}) {
  const sources = earlier(env.draft, uid).filter((s) => OUTPUTS[unit.kind].includes(s.block.type) || (s.block.type === "dca" && (s.block.side === "buy") === (unit.kind === "tokens")));
  const mode: "abs" | "balance" | "step" = "abs" in value ? "abs" : value.of === "balance" ? "balance" : "step";
  const pct = "pct" in value ? value.pct : 100;
  const what = unit.kind === "zat" ? "ZEC" : unit.symbol;
  return (
    <Field label={label}>
      <Segmented
        label={`${label} mode`}
        value={mode}
        onChange={(m) =>
          onChange(
            m === "abs"
              ? { abs: unit.kind === "zat" ? "10000000" : "0" }
              : m === "balance"
                ? { pct, of: "balance" }
                : { pct, of: { step: sources[sources.length - 1]?.uid ?? -1 } },
          )
        }
        options={[
          { id: "abs", label: "Fixed" },
          { id: "balance", label: `% of ${unit.kind === "zat" ? "balance" : "position"}` },
          { id: "step", label: "% of a step", disabled: sources.length === 0, title: sources.length === 0 ? "No earlier step yields this" : undefined },
        ]}
      />
      {mode === "abs" && "abs" in value && <UnitsInput label={label} value={value.abs} decimals={unit.kind === "zat" ? 8 : unit.decimals} suffix={what} onChange={(abs) => onChange({ abs })} />}
      {mode !== "abs" && (
        <div className="flex gap-1.5">
          <div className="w-24 flex-none">
            <NumberInput label={`${label} percent`} value={pct} min={1} max={100} suffix="%" onChange={(n) => onChange({ ...(value as Exclude<AmountSpec, { abs: string }>), pct: n })} />
          </div>
          {mode === "step" && isStep((value as { of: unknown }).of) ? (
            <Select label={`${label} source step`} value={String(((value as { of: { step: number } }).of).step)} onChange={(v) => onChange({ pct, of: { step: Number(v) } })}>
              <option value="-1" disabled>
                Choose a step
              </option>
              {sources.map((s) => (
                <option key={s.uid} value={s.uid}>
                  of what step {env.draft.steps.indexOf(s) + 1} got · {BLOCKS[s.block.type].label}
                </option>
              ))}
            </Select>
          ) : (
            <div className="flex flex-1 items-center gap-1">
              {[25, 50, 100].map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => onChange({ ...(value as Exclude<AmountSpec, { abs: string }>), pct: p })}
                  className={cn(
                    "tabular h-10 flex-1 rounded-lg border text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    pct === p ? "border-zec/50 bg-zec/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {p}%
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {mode !== "abs" && <p className="text-[11px] text-faint-foreground">Measured when the step runs, not now.</p>}
    </Field>
  );
}

export function GuardField({ value, onChange, label = "Price guard", priced }: { value: Guard; onChange: (g: Guard) => void; label?: string; priced: boolean }) {
  const mode = "slippageBps" in value ? "slip" : "limit";
  return (
    <Field
      label={label}
      hint={
        mode === "slip"
          ? priced
            ? "Measured from the price tick at the moment the step runs."
            : "This token has no price tick — slippage can't be checked. Set a limit price."
          : "Price per whole token in the pair's units. Works for any token."
      }
    >
      <Segmented
        label={`${label} type`}
        value={mode}
        onChange={(m) => onChange(m === "slip" ? { slippageBps: 500 } : { limitPrice: "" })}
        options={[
          { id: "slip", label: "Slippage" },
          { id: "limit", label: "Limit price" },
        ]}
      />
      {"slippageBps" in value ? (
        <div className="flex gap-1">
          {[100, 300, 500, 1000, 3000].map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => onChange({ slippageBps: b })}
              className={cn(
                "tabular h-9 flex-1 rounded-lg border text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                value.slippageBps === b ? "border-zec/50 bg-zec/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {b / 100}%
            </button>
          ))}
        </div>
      ) : (
        <div className="relative">
          <Input inputMode="decimal" aria-label={`${label} limit`} placeholder="0.00000003" value={value.limitPrice} onChange={(e) => onChange({ limitPrice: e.target.value.replace(",", ".").trim() })} className="tabular pr-12" />
          <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-mono text-xs text-faint-foreground">SOL</span>
        </div>
      )}
    </Field>
  );
}

export function ExecField({ value, onChange, allowNow }: { value: "now" | "delayed" | "max"; onChange: (v: "now" | "delayed" | "max") => void; allowNow: boolean }) {
  return (
    <Field
      label="Execution"
      hint={value === "now" ? "Now only right after manual start — 1–3 s, network-visible. A retry goes Delayed." : value === "max" ? "5–15 min batch · the most private." : "30–60 s batch with others."}
    >
      <Segmented
        label="Execution"
        value={value}
        onChange={onChange}
        options={[
          ...(allowNow ? [{ id: "now" as const, label: "Now" }] : []),
          { id: "delayed" as const, label: "Delayed" },
          { id: "max" as const, label: "Max privacy" },
        ]}
      />
    </Field>
  );
}

export function StepSelect({ env, uid, value, onChange, direction, types, label, placeholder }: { env: BuilderEnv; uid: number; value: number; onChange: (uid: number) => void; direction: "before" | "after"; types?: ScenarioBlockType[]; label: string; placeholder: string }) {
  const list = (direction === "before" ? earlier(env.draft, uid) : later(env.draft, uid)).filter((s) => !types || types.includes(s.block.type));
  return (
    <Select label={label} value={String(list.some((s) => s.uid === value) ? value : -1)} onChange={(v) => onChange(Number(v))}>
      <option value="-1" disabled>
        {list.length ? placeholder : "No matching step"}
      </option>
      {list.map((s) => (
        <option key={s.uid} value={s.uid}>
          Step {env.draft.steps.indexOf(s) + 1} · {BLOCKS[s.block.type].label}
        </option>
      ))}
    </Select>
  );
}

/** onFail of every step: stop / skip / retry then … / go to a later step. */
export function OnFailField({ env, uid, value, onChange, retryable }: { env: BuilderEnv; uid: number; value: OnFail | undefined; onChange: (f: OnFail) => void; retryable: boolean }) {
  const v = value ?? "stop";
  const mode = typeof v === "string" ? v : "retry" in v ? "retry" : "goto";
  const then: OnFailTarget = typeof v === "object" && "retry" in v ? v.then : "stop";
  const targetOf = (t: OnFailTarget) => (typeof t === "object" ? t.goto : -1);
  const hasLater = later(env.draft, uid).length > 0;
  return (
    <Field
      label="If this step fails"
      hint={mode === "retry" ? "Retries only passing errors (slippage, liquidity, venue down), 1–5 batches apart. A sell retries with a slightly different amount." : undefined}
    >
      <Segmented
        label="If this step fails"
        value={mode}
        onChange={(m) => onChange(m === "retry" ? { retry: 2, then: "stop" } : m === "goto" ? { goto: later(env.draft, uid)[0]?.uid ?? -1 } : m)}
        options={[
          { id: "stop", label: "Stop" },
          { id: "skip", label: "Skip" },
          { id: "retry", label: "Retry", disabled: !retryable, title: retryable ? undefined : "Nothing to retry here" },
          { id: "goto", label: "Go to", disabled: !hasLater, title: hasLater ? undefined : "Only to a later step" },
        ]}
      />
      {mode === "goto" && <StepSelect env={env} uid={uid} direction="after" value={targetOf(v as OnFailTarget)} onChange={(g) => onChange({ goto: g })} label="Go to step" placeholder="Choose a later step" />}
      {mode === "retry" && typeof v === "object" && "retry" in v && (
        <div className="grid grid-cols-[96px_1fr] gap-1.5">
          <Select label="Retries" value={String(v.retry)} onChange={(n) => onChange({ ...v, retry: Number(n) as 1 | 2 | 3 })}>
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n}×
              </option>
            ))}
          </Select>
          <Select
            label="Then"
            value={typeof then === "string" ? then : "goto"}
            onChange={(t) => onChange({ ...v, then: t === "goto" ? { goto: later(env.draft, uid)[0]?.uid ?? -1 } : (t as "stop" | "skip") })}
          >
            <option value="stop">then stop</option>
            <option value="skip">then skip</option>
            {hasLater && <option value="goto">then go to…</option>}
          </Select>
          {typeof then === "object" && (
            <div className="col-span-2">
              <StepSelect env={env} uid={uid} direction="after" value={targetOf(then)} onChange={(g) => onChange({ ...v, then: { goto: g } })} label="Then go to step" placeholder="Choose a later step" />
            </div>
          )}
        </div>
      )}
    </Field>
  );
}
