"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { CheckCircle, Clock, FilePlus, Trash, WarningCircle } from "@phosphor-icons/react";
import { api, API_MODE, ApiError, errorText } from "@/lib/api/client";
import type { ScenarioBlockType, ScenarioErrorDetails, TokenListItem } from "@/lib/api/types";
import { notifyAccepted } from "@/lib/activity";
import { getSigner, useKeyState } from "@/lib/crypto/session";
import { useNetwork } from "@/lib/network";
import { DEFAULT_SCENARIO_PARAMS, defaultBlock, formatSecs } from "@/lib/scenarios/catalog";
import { emptyDraft, insertStep, moveStep, removeStep, toPlan, updateStep, type Draft } from "@/lib/scenarios/draft";
import { clearHandOff, peekHandOff } from "@/lib/scenarios/handoff";
import { deleteDraft, rememberSigned, saveDraft, setCurrentDraft, useScenarioStore } from "@/lib/scenarios/store";
import { draftFromTemplate, templateById, TEMPLATES, type TemplateId } from "@/lib/scenarios/templates";
import { validatePlan, type ValidateCtx } from "@/lib/scenarios/validate";
import type { TokenLookup } from "@/lib/scenarios/describe";
import { useNow } from "@/hooks/use-now";
import { usePool } from "@/hooks/use-pool";
import { usePortfolio } from "@/hooks/use-portfolio";
import { useTokens } from "@/hooks/use-tokens";
import { KeyGate } from "@/components/key/key-gate";
import { EmptyState } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Chain, type DragItem } from "./chain";
import { Segmented, type BuilderEnv } from "./fields";
import { Inspector } from "./inspector";
import { isLiveScenario, MyScenarios } from "./my-scenarios";
import { Palette } from "./palette";
import { Review } from "./review";
import { TemplatePicker } from "./template-picker";
import { startBalanceShort } from "@/lib/scenarios/describe";

const EASE = [0.16, 1, 0.3, 1] as const;
const H = 3600;

export function ScenariosApp() {
  return (
    <KeyGate next="/scenarios">
      <Scenarios />
    </KeyGate>
  );
}

const pricedToken = (t: TokenListItem) => (t.venue === "pumpfun" || t.venue === "meteora-dbc") && (t.quote ?? "SOL") === "SOL" && t.status === "curve";

function Scenarios() {
  const network = useNetwork();
  const key = useKeyState();
  const pubkey = key.status === "unlocked" ? key.pubkey : null;
  const { pool } = usePool();
  const { tokens } = useTokens();
  const { portfolio } = usePortfolio();
  const store = useScenarioStore();
  const tabsId = useId();

  const [tab, setTab] = useState<"build" | "mine">("build");
  const [edited, setDraft] = useState<Draft | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [view, setView] = useState<"edit" | "review" | "signed">("edit");
  const [drag, setDrag] = useState<DragItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [signed, setSigned] = useState<{ id: string; manual: boolean } | null>(null);
  const [seedMint] = useState<string | null>(() => peekHandOff());
  const now = useNow(15_000) ?? 0;

  const params = pool?.scenarios ?? DEFAULT_SCENARIO_PARAMS;
  const enabled = useMemo(() => new Set<ScenarioBlockType>(params.blocks), [params.blocks]);
  const list = useMemo(() => tokens ?? [], [tokens]);
  const byMint = useMemo(() => new Map(list.map((t) => [t.mint, t])), [list]);
  const tokenOf = useCallback((m: string) => byMint.get(m) ?? null, [byMint]);
  const tok: TokenLookup = useCallback((m: string) => byMint.get(m) ?? null, [byMint]);

  // The token this page was opened for, if any; else the liveliest priced pump.fun token, for templates.
  const seed = useMemo(() => {
    const pumps = list.filter((t) => t.venue === "pumpfun" && pricedToken(t));
    const a = (seedMint && byMint.get(seedMint)) || pumps[0] || list.find(pricedToken);
    const b = pumps.find((t) => t.mint !== a?.mint);
    return { mint: a?.mint, venue: a?.venue, priceSol: a?.priceSol, mintB: b?.mint, venueB: b?.venue, priceSolB: b?.priceSol, minDepositZat: pool?.minDepositZat };
  }, [list, byMint, pool?.minDepositZat, seedMint]);

  // First load: the draft in progress, or a fresh one when opened for a token.
  const [blank] = useState(() => emptyDraft(DEFAULT_SCENARIO_PARAMS.ttlSecs.default));
  const stored = store.ready && !seedMint ? store.file.drafts.find((d) => d.id === store.file.current) : undefined;
  const draft: Draft | null = edited ?? (store.ready ? (stored ?? blank) : null);
  useEffect(() => clearHandOff(), []);

  // Autosave what the user touched, encrypted (never plain localStorage).
  useEffect(() => {
    if (!edited || !pubkey) return;
    const t = setTimeout(() => void saveDraft(network, pubkey, edited), 500);
    return () => clearTimeout(t);
  }, [edited, network, pubkey]);

  const ctx: ValidateCtx = useMemo(
    () => ({
      params,
      now,
      minDepositZat: pool?.minDepositZat ?? "1000000",
      venues: pool?.venues?.map((v) => v.venue),
      features: { fl: false, chat: pool?.features?.chat === true, fullTrades: pool?.features?.fullTrades === true },
      priced: (m) => {
        const t = byMint.get(m);
        return !!t && pricedToken(t);
      },
      network,
      minActionZat: pool?.minActionZat,
      venueInfo: pool?.venues,
      orders: pool?.orders,
      // v0.20: own_result on an own order outside the plan counts as a trade of its mint (P2).
      refMint: (id) => portfolio?.orders?.find((o) => o.id === id)?.mint ?? null,
      token: (m) => {
        const t = byMint.get(m);
        return t ? { mint: m, symbol: t.symbol, decimals: t.decimals, venue: t.venue, quote: t.quote ?? "SOL", status: t.status, priced: pricedToken(t) } : null;
      },
    }),
    [params, pool, byMint, network, now, portfolio?.orders],
  );

  const plan = useMemo(() => (draft ? toPlan(draft) : null), [draft]);
  const check = useMemo(() => (plan ? validatePlan(plan, ctx) : null), [plan, ctx]);
  const live = (portfolio?.scenarios ?? []).filter(isLiveScenario).length;

  if (pool && !pool.features?.scenarios)
    return (
      <EmptyState art title="Scenarios are off on this pool">
        <p>The operator hasn&apos;t switched them on for this network yet. Manual trades and orders work as usual.</p>
      </EmptyState>
    );

  if (!draft || !plan || !check)
    return (
      <div className="space-y-3" aria-busy>
        <div className="h-36 animate-pulse rounded-xl bg-surface-1" />
        <div className="h-96 animate-pulse rounded-xl bg-surface-1" />
      </div>
    );

  const env: BuilderEnv = { draft, plan, tokens: list, tokenOf, pool, network };
  const selIndex = draft.steps.findIndex((s) => s.uid === selected);
  const sel = selIndex >= 0 ? draft.steps[selIndex] : null;
  const full = draft.steps.length >= params.maxSteps;
  const blocking = check.issues;
  const hasWithdraw = draft.steps.some((s) => s.block.type === "withdraw_token" || s.block.type === "withdraw_zec");
  const planIssues = blocking.filter((x) => x.step < 0);

  const edit = (next: Draft) => setDraft({ ...next, updatedAt: Date.now() });

  const add = (t: ScenarioBlockType, at?: number) => {
    if (full) return;
    const pos = at ?? (selIndex >= 0 ? selIndex + 1 : draft.steps.length);
    const { draft: d, uid } = insertStep(draft, defaultBlock(t, { mint: seed.mint, venue: seed.venue }), pos);
    edit(d);
    setSelected(uid);
  };

  const pickTemplate = (id: TemplateId) => {
    const t = templateById(id)!;
    const d = draftFromTemplate(t, seed);
    setDraft(d);
    setSelected(d.steps[0]?.uid ?? null);
    setView("edit");
  };

  const sign = async () => {
    const signer = getSigner(network);
    if (!signer || !pubkey) return setSignError(errorText(new ApiError("locked", "")));
    setBusy(true);
    setSignError(null);
    try {
      const r = await api.postAction(signer, { op: "scenario_create", plan });
      await rememberSigned(network, pubkey, r.id, { name: draft.name, template: draft.template, at: Date.now(), plan }, draft.id);
      notifyAccepted();
      setSigned({ id: r.id, manual: r.status === "waiting_start" });
      setView("signed");
    } catch (e) {
      const d = e instanceof ApiError ? (e.details as Partial<ScenarioErrorDetails> | undefined) : undefined;
      if (d && typeof d.step === "number" && draft.steps[d.step]) {
        setSelected(draft.steps[d.step].uid);
        setView("edit");
        toast.error(`Step ${d.step + 1}: ${errorText(e)}`);
      }
      setSignError(
        e instanceof ApiError && e.code === "insufficient_balance"
          ? (startBalanceShort("0", pool?.minActionZat) ?? errorText(e))
          : errorText(e),
      );
    } finally {
      setBusy(false);
    }
  };

  const fresh = () => {
    const d = emptyDraft(params.ttlSecs.default);
    setDraft(d);
    setSelected(null);
    setView("edit");
    setSigned(null);
  };

  return (
    <div>
      {/* tabs */}
      <div role="tablist" aria-label="Scenarios" className="mb-6 inline-flex gap-0.5 rounded-full border border-border p-1">
        {(
          [
            ["build", "Build"],
            ["mine", `My scenarios${live ? ` · ${live}` : ""}`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn("relative rounded-full px-4 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none", tab === id ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {tab === id && <motion.span layoutId={`${tabsId}-tab`} className="absolute inset-0 rounded-full bg-surface-3" transition={{ type: "spring", bounce: 0, duration: 0.3 }} />}
            <span className="relative">{label}</span>
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {tab === "mine" ? (
          <motion.div key="mine" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease: EASE }}>
            {API_MODE === "mock" && <DemoClock />}
            <MyScenarios more={portfolio?.more?.scenarios ?? 0} scenarios={portfolio?.scenarios ?? (portfolio ? [] : null)} names={store.file.signed} tok={tok} network={network} onBuild={() => setTab("build")} />
          </motion.div>
        ) : view === "review" ? (
          <motion.div key="review" initial={{ opacity: 0, y: 12, filter: "blur(6px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={{ opacity: 0, y: 6 }} transition={{ duration: 0.35, ease: EASE }}>
            <Review name={draft.name} plan={plan} check={check} pool={pool} tok={tok} busy={busy} error={signError} balanceZat={portfolio?.zecBalance ?? null} onBack={() => setView("edit")} onSign={() => void sign()} />
          </motion.div>
        ) : view === "signed" && signed ? (
          <motion.div key="signed" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.35, ease: EASE }}>
            <Signed manual={signed.manual} onMine={() => setTab("mine")} onNew={fresh} />
          </motion.div>
        ) : (
          <motion.div key="build" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease: EASE }} className="space-y-6">
            <TemplatePicker active={draft.template} onPick={pickTemplate} enabled={enabled} compact={draft.steps.length > 0} />

            <div className="ledger lg:grid-cols-[216px_minmax(0,1fr)] xl:grid-cols-[216px_minmax(0,1fr)_360px]">
              {/* palette */}
              <aside aria-label="Block palette" className="max-lg:order-last">
                <div className="lg:sticky lg:top-20">
                  <p className="px-4 pt-4 text-xs text-muted-foreground lg:hidden">Add a block</p>
                  <Palette enabled={enabled} full={full} onAdd={(t) => add(t)} onDragStart={(t) => setDrag({ kind: "new", type: t })} onDragEnd={() => setDrag(null)} />
                  <div className="hidden space-y-1 px-4 pb-5 text-[11px] text-pretty text-faint-foreground lg:block">
                    <p>Drag onto the chain, or press to add after the selected step.</p>
                    <p className="font-mono text-[10px]">↑↓ select · Alt+↑↓ move · Del remove</p>
                  </div>
                </div>
              </aside>

              {/* chain */}
              <section aria-labelledby="chain-title" className="flex min-h-[560px] flex-col">
                <header className="space-y-3 border-b border-border px-4 py-4 sm:px-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 id="chain-title" className="sr-only">
                      Your scenario
                    </h2>
                    <Input aria-label="Scenario name (kept only on this device)" value={draft.name} maxLength={48} onChange={(e) => edit({ ...draft, name: e.target.value })} className="h-9 max-w-xs flex-1 border-transparent bg-transparent px-1 text-lg font-medium hover:border-border focus-visible:border-ring" />
                    <Drafts drafts={store.file.drafts} current={draft.id} onOpen={(d) => {
                      setDraft(d);
                      setSelected(null);
                      if (pubkey) void setCurrentDraft(network, pubkey, d.id);
                    }} onDelete={(id) => pubkey && void deleteDraft(network, pubkey, id)} onNew={fresh} />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <Segmented
                      label="Plan lifetime"
                      className="max-w-sm"
                      value={String(draft.ttlSecs)}
                      onChange={(v) => edit({ ...draft, ttlSecs: Number(v) })}
                      options={[1, 6, 24, 72, 168].map((h) => ({
                        id: String(h * H),
                        label: h === 168 ? "7 d" : `${h} h`,
                        disabled: h * H > (hasWithdraw ? params.ttlSecs.max : (params.ttlSecs.maxNoWithdraw ?? params.ttlSecs.max)),
                        title: h === 168 && hasWithdraw ? "7 days only for plans without a withdrawal" : undefined,
                      }))}
                    />
                    {hasWithdraw && (params.ttlSecs.maxNoWithdraw ?? 0) > params.ttlSecs.max && <p className="text-[11px] text-faint-foreground">7 d only for plans without a withdrawal.</p>}
                    <p className="tabular font-mono text-[11px] text-faint-foreground">
                      <span className={cn(full && "text-zec")}>
                        {draft.steps.length}/{params.maxSteps} blocks
                      </span>{" "}
                      · <span className={cn(check.runs > params.maxRuns && "text-destructive")}>{check.runs}/{params.maxRuns} actions</span>
                    </p>
                  </div>
                  <p className="text-[11px] text-faint-foreground">Name and drafts stay on this device, encrypted with your key. The pool never sees them.</p>
                </header>

                <div className="flex-1 px-3 py-4 sm:px-4">
                  <Chain
                    steps={draft.steps}
                    plan={plan}
                    check={check}
                    tok={tok}
                    selected={selected}
                    onSelect={setSelected}
                    onDropNew={(t, at) => add(t, at)}
                    onMove={(uid, to) => edit(moveStep(draft, uid, to))}
                    onRemove={(uid) => {
                      edit(removeStep(draft, uid));
                      if (selected === uid) setSelected(null);
                    }}
                    drag={drag}
                    setDrag={setDrag}
                  />
                </div>

                <footer className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3 sm:px-5">
                  <div className="min-w-0 flex-1 text-xs">
                    {draft.steps.length === 0 ? (
                      <span className="text-muted-foreground">Pick a template or add blocks.</span>
                    ) : blocking.length ? (
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <WarningCircle size={14} weight="light" className="shrink-0 text-destructive" aria-hidden />
                        {planIssues[0] ? (
                          planIssues[0].message
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              const first = draft.steps[blocking.find((b) => b.step >= 0)!.step];
                              if (first) setSelected(first.uid);
                            }}
                            className="rounded underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                          >
                            {blocking.length} {blocking.length === 1 ? "thing" : "things"} to fix — show step {blocking.find((b) => b.step >= 0)!.step + 1}
                          </button>
                        )}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <CheckCircle size={14} weight="duotone" className="shrink-0 text-zec" aria-hidden />
                        Ready. Lives {formatSecs(check.ttlSecs)}{check.floors.length ? ` · ${check.floors.length} privacy ${check.floors.length === 1 ? "floor" : "floors"} applied` : ""}.
                      </span>
                    )}
                  </div>
                  <Button onClick={() => setView("review")} disabled={!check.ok || draft.steps.length === 0} className="h-10 rounded-full px-5">
                    Review & sign
                  </Button>
                </footer>
              </section>

              {/* inspector */}
              <aside aria-label="Block settings" className="lg:col-span-2 xl:col-span-1">
                <AnimatePresence mode="wait" initial={false}>
                  {sel ? (
                    <motion.div key={sel.uid} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2, ease: EASE }} className="xl:sticky xl:top-20">
                      <Inspector
                        env={env}
                        step={sel}
                        index={selIndex}
                        issues={check.issues.filter((x) => x.step === selIndex)}
                        floors={check.floors.filter((x) => x.step === selIndex)}
                        warnings={check.warnings.filter((x) => x.step === selIndex)}
                        onChange={(s) => edit(updateStep(draft, s.uid, () => s))}
                        onMove={(dir) => edit(moveStep(draft, sel.uid, selIndex + dir))}
                        onRemove={() => {
                          edit(removeStep(draft, sel.uid));
                          setSelected(null);
                        }}
                      />
                    </motion.div>
                  ) : (
                    <motion.div key="none" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex h-full min-h-48 flex-col justify-center gap-3 px-6 py-8 text-sm text-muted-foreground">
                      <p className="font-medium text-foreground">Select a step to set it up</p>
                      <ul className="space-y-1.5 text-xs text-pretty">
                        <li>Every block runs through the same batches as a manual trade.</li>
                        <li>
                          <span className="hatch-zec mr-1.5 inline-block h-2.5 w-1.5 align-middle" aria-hidden />
                          Tape marks a privacy floor: the pool adds it, you can&apos;t turn it off.
                        </li>
                        <li>Keyboard: ↑ ↓ to walk the chain, Alt + ↑ ↓ to move a step, Delete to remove it.</li>
                      </ul>
                    </motion.div>
                  )}
                </AnimatePresence>
              </aside>
            </div>
            <p className="text-[11px] text-pretty text-faint-foreground">
              {TEMPLATES.length} shared templates · {params.maxSteps} blocks max · {params.maxActivePerKey} running plans per key · a plan lives {formatSecs(params.ttlSecs.min)}–{formatSecs(params.ttlSecs.max)} (up to {formatSecs(params.ttlSecs.maxNoWithdraw ?? params.ttlSecs.max)} without withdrawals). While it runs, the operator holds your intention — never your addresses.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Drafts({ drafts, current, onOpen, onDelete, onNew }: { drafts: Draft[]; current: string; onOpen: (d: Draft) => void; onDelete: (id: string) => void; onNew: () => void }) {
  const others = drafts.filter((d) => d.id !== current);
  return (
    <div className="ml-auto flex items-center gap-1">
      {others.length > 0 && (
        <details className="group relative">
          <summary className="flex h-8 cursor-pointer list-none items-center rounded-full border border-border px-3 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            Drafts · {others.length}
          </summary>
          <ul className="absolute right-0 z-30 mt-1 w-64 rounded-xl border border-border bg-popover p-1 shadow-xl">
            {others.map((d) => (
              <li key={d.id} className="flex items-center gap-1">
                <button type="button" onClick={(e) => {
                  (e.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open");
                  onOpen(d);
                }} className="min-w-0 flex-1 truncate rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                  {d.name || "Untitled"} <span className="text-[11px] text-faint-foreground">· {d.steps.length} blocks</span>
                </button>
                <Button variant="ghost" size="icon-xs" aria-label={`Delete draft ${d.name}`} onClick={() => onDelete(d.id)}>
                  <Trash weight="light" />
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <Button variant="ghost" size="sm" onClick={onNew} className="rounded-full">
        <FilePlus weight="light" />
        New
      </Button>
    </div>
  );
}

function Signed({ manual, onMine, onNew }: { manual: boolean; onMine: () => void; onNew: () => void }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-border px-6 py-14 text-center">
      <motion.span aria-hidden initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 0.6, ease: EASE }} className="redaction-tape absolute inset-x-0 top-0 h-1.5 origin-left" />
      <CheckCircle size={32} weight="duotone" className="mx-auto text-zec" aria-hidden />
      <h2 className="mt-4 text-2xl font-medium tracking-tight">{manual ? "Signed. Waiting for your Start." : "Signed. Stay unzeen."}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-pretty text-muted-foreground">
        {manual
          ? "Nothing runs until you press Start in My scenarios. After that the pool takes it from there."
          : "The pool runs every step in shared batches. Your device sends nothing while it does — close this tab if you like."}
      </p>
      {API_MODE === "mock" && <p className="mt-2 text-[11px] text-faint-foreground">Demo clock: one hour of a plan runs in about 20 seconds.</p>}
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Button onClick={onMine} className="h-10 rounded-full px-5">
          Open My scenarios
        </Button>
        <Button variant="outline" onClick={onNew} className="h-10 rounded-full px-5">
          Build another
        </Button>
      </div>
    </div>
  );
}

function DemoClock() {
  return (
    <p className="mb-4 flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
      <Clock size={14} weight="light" className="text-zec" aria-hidden />
      Demo clock: one hour of a plan runs in about 20 seconds, so waits and floors play out while you watch.
    </p>
  );
}
