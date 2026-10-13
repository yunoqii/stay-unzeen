"use client";

// Parameters of the selected block. Every change goes straight into the draft; the validator re-runs on each
// edit and its messages for this step show at the top.

import { ArrowDown, ArrowUp, Trash, WarningCircle } from "@phosphor-icons/react";
import type { MintRef, OrderKind, SafetyRequire, ScenarioBlock, TokenListItem, Venue } from "@/lib/api/types";
import { BLOCKS, formatSecs } from "@/lib/scenarios/catalog";
import type { DraftStep } from "@/lib/scenarios/draft";
import { ORDER_LABEL } from "@/lib/orders";
import { VENUE_LABEL } from "@/lib/format";
import type { PlanNote, PlanIssue } from "@/lib/scenarios/validate";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { BLOCK_ICON } from "./block-icon";
import { AmountField, DurationInput, ExecField, Field, GuardField, MintPicker, NumberInput, OnFailField, Segmented, Select, StepSelect, UnitsInput, type BuilderEnv } from "./fields";
import { FloorTape } from "./floor-tape";

const priced = (t: TokenListItem | null | undefined) => !!t && (t.venue === "pumpfun" || t.venue === "meteora-dbc") && (t.quote ?? "SOL") === "SOL" && t.status === "curve";

/** Can retry help this block at all (transient errors only happen on market steps). */
const RETRYABLE = new Set(["buy", "sell", "sell_all", "swap", "dca", "create", "order_place", "withdraw_token", "withdraw_zec"]);
const NO_ONFAIL = new Set(["manual_start", "wait_fixed", "wait_random", "end", "repeat", "check_safety"]);

export function Inspector({
  env,
  step,
  index,
  issues,
  floors,
  warnings,
  onChange,
  onMove,
  onRemove,
}: {
  env: BuilderEnv;
  step: DraftStep;
  index: number;
  issues: PlanIssue[];
  floors: PlanNote[];
  warnings: PlanNote[];
  onChange: (s: DraftStep) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const b = step.block;
  const Icon = BLOCK_ICON[b.type];
  const set = (patch: Partial<ScenarioBlock>) => onChange({ ...step, block: { ...b, ...patch } as ScenarioBlock });
  const uid = step.uid;
  const tok = (m: MintRef | undefined) => (typeof m === "string" && m ? env.tokenOf(m) : null);
  const symbolOf = (m: MintRef | undefined) => tok(m)?.symbol ?? (typeof m === "object" ? "tokens" : "tokens");
  const decimalsOf = (m: MintRef | undefined) => tok(m)?.decimals ?? 6;
  const isPriced = (m: MintRef | undefined) => (typeof m === "object" ? true : priced(tok(m)));
  const venues = (env.pool?.venues ?? []).filter((v) => v.trade).map((v) => v.venue);
  const venueSelect = (value: Venue, onPick: (v: Venue) => void, label = "Venue") => (
    <Field label={label}>
      <Select label={label} value={value} onChange={(v) => onPick(v as Venue)}>
        {(venues.length ? venues : (["pumpfun", "meteora-dbc", "raydium-launchlab", "jupiter"] as Venue[])).map((v) => (
          <option key={v} value={v}>
            {VENUE_LABEL[v]}
          </option>
        ))}
      </Select>
    </Field>
  );
  // Picking a pool token also picks its venue.
  const pickMint = (m: MintRef, extra: (v: Venue) => Partial<ScenarioBlock> = (v) => ({ venue: v }) as Partial<ScenarioBlock>) => {
    const t = tok(m);
    set({ mint: m, ...(t ? extra(t.venue) : {}) } as Partial<ScenarioBlock>);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start gap-3 border-b border-border px-5 py-4">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-border text-zec">
          <Icon size={16} weight="duotone" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] text-faint-foreground">Step {index + 1}</p>
          <h2 className="font-medium">{BLOCKS[b.type].label}</h2>
          <p className="text-xs text-muted-foreground">{BLOCKS[b.type].hint}</p>
        </div>
        <div className="flex gap-0.5">
          <Button variant="ghost" size="icon-sm" aria-label="Move up" onClick={() => onMove(-1)} disabled={index === 0}>
            <ArrowUp weight="light" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Move down" onClick={() => onMove(1)} disabled={index === env.draft.steps.length - 1}>
            <ArrowDown weight="light" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Remove block" onClick={onRemove}>
            <Trash weight="light" />
          </Button>
        </div>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {(issues.length > 0 || warnings.length > 0 || floors.length > 0) && (
          <div className="space-y-1.5">
            {issues.map((x) => (
              <p key={x.code + x.message} role="alert" className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-pretty text-foreground">
                <WarningCircle size={14} weight="light" className="mt-px shrink-0 text-destructive" aria-hidden />
                {x.message}
              </p>
            ))}
            {warnings.map((x) => (
              <p key={x.code} className="flex gap-2 rounded-lg border border-border px-3 py-2 text-xs text-pretty text-muted-foreground">
                <WarningCircle size={14} weight="light" className="mt-px shrink-0 text-zec" aria-hidden />
                {x.text}
              </p>
            ))}
            {floors.map((f) => (
              <FloorTape key={f.code} text={f.text} />
            ))}
          </div>
        )}

        {params()}

        {!NO_ONFAIL.has(b.type) && <OnFailField env={env} uid={uid} value={step.onFail} onChange={(f) => onChange({ ...step, onFail: f })} retryable={RETRYABLE.has(b.type)} />}
        {NO_ONFAIL.has(b.type) && <p className="text-[11px] text-faint-foreground">{b.type === "check_safety" ? "A failed check follows “Otherwise” above." : "This step can't fail; the plan just moves on."}</p>}
      </div>
    </div>
  );

  function params() {
    switch (b.type) {
      case "manual_start":
        return <p className="text-sm text-pretty text-muted-foreground">The plan waits until you press Start in My scenarios. The next step may then run Now — like a manual trade, because it is one.</p>;
      case "time_at": {
        const local = new Date(b.at - new Date(b.at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
        return (
          <Field label="Date and time (your clock)" hint="Fires up to 10 min later on purpose: an exact “09:00” every day would link your trades.">
            <Input type="datetime-local" aria-label="Date and time" value={Number.isFinite(b.at) ? local : ""} onChange={(e) => set({ at: new Date(e.target.value).getTime() })} />
          </Field>
        );
      }
      case "price_cross":
        return (
          <>
            <MintPicker env={env} uid={uid} value={b.mint} onChange={(m) => set({ mint: m })} filter={priced} />
            <Field label="When the price is">
              <Segmented label="Direction" value={b.op} onChange={(op) => set({ op })} options={[{ id: "gte", label: "At or above" }, { id: "lte", label: "At or below" }]} />
              <div className="relative">
                <Input inputMode="decimal" aria-label="Price" placeholder={tok(b.mint)?.priceSol ?? "0.00000003"} value={b.priceSol} onChange={(e) => set({ priceSol: e.target.value.replace(",", ".").trim() })} className="tabular pr-12" />
                <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-mono text-xs text-faint-foreground">SOL</span>
              </div>
              {tok(b.mint) && <p className="text-[11px] text-faint-foreground">Now: {tok(b.mint)!.priceSol} SOL</p>}
            </Field>
            <Timeout value={b.timeoutSecs} onChange={(t) => set({ timeoutSecs: t })} />
          </>
        );
      case "deposit_received":
        return (
          <>
            <Field label="At least" hint="Counts only shielded deposits made after the plan starts — not sales or claims.">
              <UnitsInput label="Minimum deposit" value={b.minZat} decimals={8} suffix="ZEC" onChange={(v) => set({ minZat: v })} />
            </Field>
            <Timeout value={b.timeoutSecs} onChange={(t) => set({ timeoutSecs: t })} />
          </>
        );
      case "own_result":
        return (
          <>
            <Field label="Order">
              <StepSelect env={env} uid={uid} direction="before" types={["order_place"]} value={"step" in b.ref ? b.ref.step : -1} onChange={(s) => set({ ref: { step: s } })} label="Order step" placeholder="Choose a Place order step" />
            </Field>
            <Field label="Continue when it">
              <Segmented label="Outcome" value={b.on} onChange={(on) => set({ on })} options={[{ id: "filled", label: "Fills" }, { id: "failed", label: "Closes unfilled" }, { id: "any", label: "Either" }]} />
            </Field>
            <Timeout value={b.timeoutSecs} onChange={(t) => set({ timeoutSecs: t })} />
          </>
        );
      case "curve_progress":
        return (
          <>
            <MintPicker env={env} uid={uid} value={b.mint} onChange={(m) => set({ mint: m })} filter={(t) => priced(t)} />
            <Field label="Wait until">
              <Segmented
                label="Curve condition"
                value={b.graduated ? "grad" : "pct"}
                onChange={(m) => onChange({ ...step, block: m === "grad" ? { type: "curve_progress", mint: b.mint, graduated: true, timeoutSecs: b.timeoutSecs } : { type: "curve_progress", mint: b.mint, gtePct: 80, timeoutSecs: b.timeoutSecs } })}
                options={[{ id: "pct", label: "Curve filled to" }, { id: "grad", label: "It graduates" }]}
              />
              {!b.graduated && <NumberInput label="Fill level" value={b.gtePct} min={1} max={100} suffix="%" onChange={(n) => set({ gtePct: n })} />}
            </Field>
            <Timeout value={b.timeoutSecs} onChange={(t) => set({ timeoutSecs: t })} />
          </>
        );
      case "wait_fixed":
        return (
          <Field label="About" hint={`Never exact: ±10 % (at least ±30 s). ${Number.isFinite(b.secs) ? `≈ ${formatSecs(b.secs)}.` : ""} A random wait hides you better.`}>
            <DurationInput label="Wait" secs={b.secs} onChange={(s) => set({ secs: s })} />
          </Field>
        );
      case "wait_random":
        return (
          <>
            <Field label="At least">
              <DurationInput label="Shortest wait" secs={b.minSecs} onChange={(s) => set({ minSecs: s })} />
            </Field>
            <Field label="At most" hint="A fresh random pick each time the step runs.">
              <DurationInput label="Longest wait" secs={b.maxSecs} onChange={(s) => set({ maxSecs: s })} />
            </Field>
          </>
        );
      case "buy":
        return (
          <>
            <MintPicker env={env} uid={uid} value={b.mint} onChange={(m) => pickMint(m)} />
            {venueSelect(b.venue, (v) => set({ venue: v }))}
            <AmountField env={env} uid={uid} label="Spend" value={b.zec} unit={{ kind: "zat" }} onChange={(zec) => set({ zec })} />
            <GuardField value={b.guard} onChange={(guard) => set({ guard })} priced={isPriced(b.mint)} />
            <ExecField value={b.exec} onChange={(exec) => set({ exec })} allowNow={index === 1 && env.draft.steps[0]?.block.type === "manual_start"} />
          </>
        );
      case "sell":
      case "sell_all":
        return (
          <>
            <MintPicker env={env} uid={uid} value={b.mint} onChange={(m) => pickMint(m)} />
            {venueSelect(b.venue, (v) => set({ venue: v }))}
            {b.type === "sell" && <AmountField env={env} uid={uid} label="Sell" value={b.amount} unit={{ kind: "tokens", decimals: decimalsOf(b.mint), symbol: symbolOf(b.mint) }} onChange={(amount) => set({ amount })} />}
            <GuardField value={b.guard} onChange={(guard) => set({ guard })} priced={isPriced(b.mint)} />
            <ExecField value={b.exec} onChange={(exec) => set({ exec })} allowNow={index === 1 && env.draft.steps[0]?.block.type === "manual_start"} />
          </>
        );
      case "swap":
        return (
          <>
            <MintPicker env={env} uid={uid} label="Sell" value={b.from} onChange={(m) => set({ from: m })} />
            <MintPicker env={env} uid={uid} label="Buy" value={b.to} onChange={(m) => set({ to: m })} />
            <AmountField env={env} uid={uid} label="How much to move" value={b.amount} unit={{ kind: "tokens", decimals: decimalsOf(b.from), symbol: symbolOf(b.from) }} onChange={(amount) => set({ amount })} />
            <GuardField label="Sell guard" value={b.guardSell} onChange={(g) => set({ guardSell: g })} priced={isPriced(b.from)} />
            <GuardField label="Buy guard" value={b.guardBuy} onChange={(g) => set({ guardBuy: g })} priced={isPriced(b.to)} />
            <ExecField value={b.exec} onChange={(exec) => set({ exec: exec as "delayed" | "max" })} allowNow={false} />
          </>
        );
      case "dca":
        return (
          <>
            <Field label="Side">
              <Segmented label="Side" value={b.side} onChange={(side) => set({ side, total: side === "buy" ? { abs: "50000000" } : { pct: 100, of: "balance" } })} options={[{ id: "buy", label: "Buy in" }, { id: "sell", label: "Sell out" }]} />
            </Field>
            <MintPicker env={env} uid={uid} value={b.mint} onChange={(m) => pickMint(m)} />
            {venueSelect(b.venue, (v) => set({ venue: v }))}
            <AmountField env={env} uid={uid} label="In total" value={b.total} unit={b.side === "buy" ? { kind: "zat" } : { kind: "tokens", decimals: decimalsOf(b.mint), symbol: symbolOf(b.mint) }} onChange={(total) => set({ total })} />
            <Field label="Slices" hint="Each slice is ±20 % of an even share, at a random moment.">
              <NumberInput label="Slices" value={b.slices} min={2} max={12} onChange={(n) => set({ slices: n })} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Every, at least">
                <DurationInput label="Shortest gap" secs={b.everySecs.min} onChange={(s) => set({ everySecs: { ...b.everySecs, min: s } })} />
              </Field>
              <Field label="At most">
                <DurationInput label="Longest gap" secs={b.everySecs.max} onChange={(s) => set({ everySecs: { ...b.everySecs, max: s } })} />
              </Field>
            </div>
            <GuardField value={b.guard} onChange={(guard) => set({ guard })} priced={isPriced(b.mint)} />
            <ExecField value={b.exec} onChange={(exec) => set({ exec: exec as "delayed" | "max" })} allowNow={false} />
          </>
        );
      case "order_place": {
        const o = b.order;
        const setO = (patch: Partial<typeof o>) => set({ order: { ...o, ...patch } });
        const kinds: OrderKind[] = env.pool?.orders?.kinds ?? ["limit_buy", "limit_sell", "take_profit", "stop_loss", "bracket"];
        const priceInput = (label: string, value: string | undefined, onSet: (v: string) => void) => (
          <Field label={label}>
            <div className="relative">
              <Input inputMode="decimal" aria-label={label} placeholder={tok(o.mint)?.priceSol ?? "0.00000003"} value={value ?? ""} onChange={(e) => onSet(e.target.value.replace(",", ".").trim())} className="tabular pr-12" />
              <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-mono text-xs text-faint-foreground">SOL</span>
            </div>
          </Field>
        );
        return (
          <>
            <MintPicker env={env} uid={uid} value={o.mint} onChange={(m) => setO({ mint: m })} filter={(t) => t.venue === "pumpfun" && t.status === "curve" && (t.quote ?? "SOL") === "SOL"} />
            <Field label="Type">
              <Select
                label="Order type"
                value={o.kind}
                onChange={(k) => {
                  const kind = k as OrderKind;
                  const base = { ...o, kind, amount: kind === "limit_buy" ? { abs: "10000000" } : o.kind === "limit_buy" ? { pct: 100, of: "balance" as const } : o.amount };
                  if (kind === "bracket") set({ order: { ...base, triggerPriceSol: undefined, tpPriceSol: o.tpPriceSol ?? "", slPriceSol: o.slPriceSol ?? "" } });
                  else set({ order: { ...base, triggerPriceSol: o.triggerPriceSol ?? "", tpPriceSol: undefined, slPriceSol: undefined, slSlippageBps: undefined } });
                }}
              >
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {ORDER_LABEL[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <AmountField env={env} uid={uid} value={o.amount} unit={o.kind === "limit_buy" ? { kind: "zat" } : { kind: "tokens", decimals: decimalsOf(o.mint), symbol: symbolOf(o.mint) }} onChange={(amount) => setO({ amount })} />
            {o.kind === "bracket" ? (
              <div className="grid grid-cols-2 gap-2">
                {priceInput("Take profit at", o.tpPriceSol, (v) => setO({ tpPriceSol: v }))}
                {priceInput("Stop-loss at", o.slPriceSol, (v) => setO({ slPriceSol: v }))}
              </div>
            ) : (
              priceInput("Trigger price", o.triggerPriceSol, (v) => setO({ triggerPriceSol: v }))
            )}
            <Field label="Order lives">
              <Segmented label="Order lifetime" value={String(o.ttlSecs ?? 86_400)} onChange={(v) => setO({ ttlSecs: Number(v) })} options={[1, 6, 24, 72].map((h) => ({ id: String(h * 3600), label: `${h} h` }))} />
            </Field>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={!!o.rearm} onChange={(e) => setO({ rearm: e.target.checked || undefined })} className="accent-[var(--zec)]" />
              Re-arm after a slippage miss
            </label>
            <ExecField value={o.exec ?? "delayed"} onChange={(exec) => setO({ exec: exec as "delayed" | "max" })} allowNow={false} />
          </>
        );
      }
      case "order_cancel":
        return (
          <Field label="Order" hint="An order that already fired can't be cancelled; then this step fails.">
            <StepSelect env={env} uid={uid} direction="before" types={["order_place"]} value={"step" in b.ref ? b.ref.step : -1} onChange={(s) => set({ ref: { step: s } })} label="Order step" placeholder="Choose a Place order step" />
          </Field>
        );
      case "create": {
        const c = b.create;
        const setC = (patch: Partial<typeof c>) => set({ create: { ...c, ...patch } });
        const createVenues = (env.pool?.venues ?? []).filter((v) => v.create).map((v) => v.venue);
        return (
          <>
            <div className="grid grid-cols-[1fr_120px] gap-2">
              <Field label="Name">
                <Input aria-label="Token name" maxLength={32} value={c.meta.name} onChange={(e) => setC({ meta: { ...c.meta, name: e.target.value } })} placeholder="Ghost Protocol" />
              </Field>
              <Field label="Ticker">
                <Input aria-label="Ticker" maxLength={10} value={c.meta.symbol} onChange={(e) => setC({ meta: { ...c.meta, symbol: e.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase() } })} placeholder="GHOST" className="font-mono uppercase" />
              </Field>
            </div>
            <Field label="Venue">
              <Select label="Launch venue" value={c.venue} onChange={(v) => setC({ venue: v as Venue })}>
                {(createVenues.length ? createVenues : (["pumpfun", "meteora-dbc"] as Venue[])).map((v) => (
                  <option key={v} value={v}>
                    {VENUE_LABEL[v]}
                  </option>
                ))}
              </Select>
            </Field>
            <AmountField env={env} uid={uid} label="First buy" value={c.initialBuyZec ?? { abs: "0" }} unit={{ kind: "zat" }} onChange={(a) => setC({ initialBuyZec: a })} />
            <p className="text-[11px] text-pretty text-faint-foreground">Name, ticker and image are sealed until the launch runs. Your launch buy is locked for 24 h.</p>
            <ExecField value={c.exec ?? "delayed"} onChange={(exec) => setC({ exec })} allowNow={index === 1 && env.draft.steps[0]?.block.type === "manual_start"} />
          </>
        );
      }
      case "claim":
        return <MintPicker env={env} uid={uid} label="Token (or all your launches)" value={b.mint ?? ""} onChange={(m) => set({ mint: m === "" ? undefined : m })} />;
      case "withdraw_zec":
        return (
          <>
            <Field label="To a shielded address" hint="Sealed: encrypted on the server with a key outside its database, deleted the moment the payout is queued.">
              <Input aria-label="Shielded address" placeholder={env.network === "mainnet" ? "u1…" : "utest1…"} value={b.to} onChange={(e) => set({ to: e.target.value.trim() })} className="font-mono text-xs" spellCheck={false} autoComplete="off" />
            </Field>
            <AmountField env={env} uid={uid} value={b.amount} unit={{ kind: "zat" }} onChange={(amount) => set({ amount })} />
            <ExecField value={b.exec} onChange={(exec) => set({ exec: exec as "delayed" | "max" })} allowNow={false} />
          </>
        );
      case "withdraw_token": {
        const to = Array.isArray(b.to) ? b.to : [b.to];
        const parts = b.smart?.parts ?? 1;
        return (
          <>
            <MintPicker env={env} uid={uid} value={b.mint} onChange={(m) => set({ mint: m })} />
            <AmountField env={env} uid={uid} value={b.amount} unit={{ kind: "tokens", decimals: decimalsOf(b.mint), symbol: symbolOf(b.mint) }} onChange={(amount) => set({ amount })} />
            <Field label="Split into parts">
              <Segmented
                label="Parts"
                value={String(parts)}
                onChange={(v) => {
                  const n = Number(v);
                  const next = Array.from({ length: n }, (_, i) => to[i] ?? "");
                  set({ smart: n > 1 ? { parts: n, maxDelayMin: b.smart?.maxDelayMin ?? 60 } : undefined, to: n > 1 ? next : next[0] });
                }}
                options={[1, 2, 3, 4, 5].map((n) => ({ id: String(n), label: n === 1 ? "One" : String(n) }))}
              />
            </Field>
            <Field label={parts > 1 ? "Fresh Solana addresses, one per part" : "Fresh Solana address"} hint="Use a fresh address — not your main wallet. Sealed until the withdrawal is queued.">
              {to.map((a, i) => (
                <Input
                  key={i}
                  aria-label={`Address ${i + 1}`}
                  placeholder="Solana address"
                  value={a}
                  onChange={(e) => {
                    const next = [...to];
                    next[i] = e.target.value.trim();
                    set({ to: parts > 1 ? next : next[0] });
                  }}
                  className="font-mono text-xs"
                  spellCheck={false}
                  autoComplete="off"
                />
              ))}
            </Field>
            {parts > 1 && (
              <Field label="Spread over up to">
                <NumberInput label="Max delay" value={b.smart?.maxDelayMin} min={1} max={1440} suffix="min" onChange={(n) => set({ smart: { parts, maxDelayMin: n } })} />
              </Field>
            )}
            <ExecField value={b.exec} onChange={(exec) => set({ exec: exec as "delayed" | "max" })} allowNow={false} />
          </>
        );
      }
      case "check_safety": {
        const r = b.require;
        const setR = (patch: Partial<SafetyRequire>) => set({ require: { ...r, ...patch } });
        const pct = (k: "maxTop10Pct" | "minLpBurnedPct", label: string) => (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={r[k] !== undefined} onChange={(e) => setR({ [k]: e.target.checked ? (k === "maxTop10Pct" ? 30 : 90) : undefined })} className="accent-[var(--zec)]" />
            <span className="flex-1">{label}</span>
            {r[k] !== undefined && (
              <span className="w-24">
                <NumberInput label={label} value={r[k]} min={0} max={100} suffix="%" onChange={(n) => setR({ [k]: n })} />
              </span>
            )}
          </label>
        );
        return (
          <>
            <MintPicker env={env} uid={uid} value={b.mint} onChange={(m) => set({ mint: m })} />
            <Field label="Require">
              <div className="space-y-2.5 rounded-lg border border-border p-3">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={!!r.authoritiesRevoked} onChange={(e) => setR({ authoritiesRevoked: e.target.checked || undefined })} className="accent-[var(--zec)]" />
                  Mint and freeze authority revoked
                </label>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={!!r.noRiskyExtensions} onChange={(e) => setR({ noRiskyExtensions: e.target.checked || undefined })} className="accent-[var(--zec)]" />
                  No risky token extensions
                </label>
                {pct("maxTop10Pct", "Top-10 holders at most")}
                {pct("minLpBurnedPct", "LP burned at least")}
              </div>
            </Field>
            <Field label="Otherwise" hint="Read once from the pool's latest snapshot — no new request about this token is made for you.">
              <Segmented
                label="Otherwise"
                value={b.onFalse === "stop" ? "stop" : "goto"}
                onChange={(m) => set({ onFalse: m === "stop" ? "stop" : { goto: -1 } })}
                options={[{ id: "stop", label: "Stop the plan" }, { id: "goto", label: "Go to a later step" }]}
              />
              {b.onFalse !== "stop" && <StepSelect env={env} uid={uid} direction="after" value={b.onFalse.goto} onChange={(g) => set({ onFalse: { goto: g } })} label="Go to step" placeholder="Choose a later step" />}
            </Field>
          </>
        );
      }
      case "repeat":
        return (
          <>
            <Field label="Go back to">
              <StepSelect env={env} uid={uid} direction="before" value={b.from} onChange={(f) => set({ from: f })} label="Repeat from" placeholder="Choose an earlier step" />
            </Field>
            <Field label="Rounds in total" hint="Fixed amounts change ±10 % each round, so rounds never look alike.">
              <NumberInput label="Rounds" value={b.times} min={2} max={10} onChange={(n) => set({ times: n })} />
            </Field>
          </>
        );
      case "end":
        return <p className="text-sm text-muted-foreground">The plan finishes here. Orders it placed keep living until their own expiry.</p>;
      case "chat":
        return (
          <>
            <MintPicker env={env} uid={uid} value={b.mint} onChange={(m) => set({ mint: m })} />
            <Field label="Message" hint="Sealed until it posts. Posted under your nickname for this token, in the next batch.">
              <textarea
                aria-label="Message"
                maxLength={280}
                rows={3}
                value={b.text}
                onChange={(e) => set({ text: e.target.value })}
                className="w-full rounded-lg border border-input bg-surface-1 px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
              />
            </Field>
          </>
        );
    }
  }
}

function Timeout({ value, onChange }: { value: number | undefined; onChange: (t: number | undefined) => void }) {
  return (
    <Field label="Give up after" hint={value === undefined ? "Waits as long as the plan lives." : "Then the step fails with “timed out”."}>
      <Segmented
        label="Time limit"
        value={value === undefined ? "none" : "set"}
        onChange={(m) => onChange(m === "none" ? undefined : 6 * 3600)}
        options={[
          { id: "none", label: "Plan's lifetime" },
          { id: "set", label: "A time limit" },
        ]}
      />
      {value !== undefined && <DurationInput label="Time limit" secs={value} onChange={onChange} />}
    </Field>
  );
}
