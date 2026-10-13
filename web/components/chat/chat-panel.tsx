"use client";

// Token chat (docs/API.md v0.12). Text is only ever a React text node inside <bdi>: no
// markdown, no linkify, no previews, no dangerouslySetInnerHTML. Nicknames are server-made ASCII.

import Link from "next/link";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { DropdownMenu } from "radix-ui";
import { toast } from "sonner";
import { DotsThree, Eye, EyeSlash, Key, PaperPlaneRight, SealCheck, WarningCircle } from "@phosphor-icons/react";
import { api, ApiError, errorText } from "@/lib/api/client";
import type { ChatParams, ChatReportReason, SignedAction } from "@/lib/api/types";
import { useActions } from "@/lib/activity";
import type { ChatItem } from "@/lib/chat/feed";
import { ackBadge, rememberNick, useOwnChat } from "@/lib/chat/own";
import { ownAmounts, slowByDefault } from "@/lib/chat/slow";
import { checkChatText, linksToYou, normalizeChatText, PROBLEM_TEXT, remaining, SELF_LINK_TEXT } from "@/lib/chat/text";
import { getSigner, useKeyState } from "@/lib/crypto/session";
import { formatZec, timeAgo } from "@/lib/format";
import { useHistory } from "@/lib/history/store";
import { useNetwork } from "@/lib/network";
import { BodyTooLong } from "@/lib/pad";
import { cn } from "@/lib/utils";
import type { ChatFeed } from "@/hooks/use-chat";
import { useCreatorMints } from "@/hooks/use-creator-mints";
import { useNow } from "@/hooks/use-now";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState, StaleNote } from "@/components/ui/states";
import { EmptyState } from "@/components/layout/page-shell";
import { NickGlyph } from "./nick-glyph";

const BADGE_TITLE = "Verified by the Unzeen pool: this nickname belongs to the account that launched the token.";
const QUEUED = "Queued — posts appear in the next batch";
const SLOW_NOTE = "Delayed a few minutes so your message can't be tied to your trade";
const BADGE_WARNING = "Posting as creator uses a separate nickname. Everything you post with the badge is publicly the creator's. Your regular nickname here stays unlinked.";
/** A local "queued" note is dropped after this even if the poll never showed the message (deleted, hidden). */
const PENDING_GIVE_UP_MS = 15 * 60_000;

interface Pending {
  id: string;
  text: string;
  nick?: string;
  creator: boolean;
  slow: boolean;
  at: number;
}

export function eligibilityText(e: unknown, params: ChatParams | undefined): string {
  if (e instanceof ApiError && e.code === "chat_not_eligible" && params) return `Hold at least ${formatZec(params.minAccountZat)} ZEC in your account (balance plus tokens) to post.`;
  if (e instanceof BodyTooLong) return PROBLEM_TEXT.too_many_bytes;
  // v0.12: details = the rule code, the same codes as lib/chat/text.ts.
  if (e instanceof ApiError && e.code === "chat_text_invalid" && typeof e.details === "string" && e.details in PROBLEM_TEXT) return PROBLEM_TEXT[e.details as keyof typeof PROBLEM_TEXT];
  return errorText(e);
}

export function ChatPanel({ mint, feed, params }: { mint: string; feed: ChatFeed; params: ChatParams | undefined }) {
  const id = useId();
  const network = useNetwork();
  const key = useKeyState();
  const unlocked = key.status === "unlocked" ? key : null;
  const own = useOwnChat(mint);
  const creatorMints = useCreatorMints(!!unlocked);
  const isCreator = creatorMints.has(mint);
  const now = useNow(5_000);
  const [pending, setPending] = useState<Pending[]>([]);
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  const [queuedOps, setQueuedOps] = useState<ReadonlyMap<string, "delete" | "hide">>(new Map());

  const ownNick = (nick: string) => !!nick && (nick === own.nicks.member || nick === own.nicks.creator);

  // Pending notes leave once the poll shows the message (or it is gone for good).
  const ids = feed.state.byId;
  const visiblePending = pending.filter((p) => !ids.has(p.id) && (now === null || now - p.at < PENDING_GIVE_UP_MS));

  // Stick to the bottom like a chat, unless the reader scrolled up.
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const count = feed.items.length + visiblePending.length;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [count]);

  const act = async (action: SignedAction, done: string) => {
    const signer = getSigner(network);
    if (!signer) return void toast.error(errorText(new ApiError("locked", "")));
    try {
      await api.postAction(signer, action);
      if (action.op === "chat_delete" || action.op === "chat_hide") setQueuedOps((m) => new Map(m).set(action.id, action.op === "chat_delete" ? "delete" : "hide"));
      toast.success(done);
    } catch (e) {
      toast.error(eligibilityText(e, params));
    }
  };

  return (
    <div className="flex min-h-0 flex-col">
      <p className="border-b border-border/60 px-4 py-2 text-[11px] text-pretty text-faint-foreground">
        Your nickname is different in every token chat. Messages go out in batches together with trades, so nobody can time them to you.
        {feed.status === "ready" && feed.error && <StaleNote at={feed.updatedAt} after={0} className="ml-2" />}
      </p>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-labelledby={`${id}-label`}
        className="max-h-[28rem] min-h-56 overflow-y-auto overscroll-contain"
      >
        <span id={`${id}-label`} className="sr-only">
          Chat messages
        </span>
        {feed.hasOlder && (
          <button
            type="button"
            onClick={feed.loadOlder}
            disabled={feed.loadingOlder}
            className="w-full border-b border-border/60 px-4 py-2.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-surface-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset disabled:opacity-50"
          >
            {feed.loadingOlder ? "Loading…" : "Load earlier messages"}
          </button>
        )}

        {feed.status === "loading" ? (
          <ul aria-hidden className="space-y-4 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <li key={i} className="flex gap-3">
                <Skeleton className="size-7 rounded-lg bg-skeleton" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3 w-24 bg-skeleton" />
                  <Skeleton className="h-4 bg-skeleton" style={{ width: `${45 + ((i * 17) % 45)}%` }} />
                </div>
              </li>
            ))}
          </ul>
        ) : feed.status === "error" ? (
          <ErrorState error={feed.error ?? "Chat is unavailable right now."} title="Chat unavailable" compact className="m-4" />
        ) : feed.items.length === 0 && visiblePending.length === 0 ? (
          <EmptyState art title="No messages yet." className="m-4 border-none">
            Say something. Nobody will know it was you.
          </EmptyState>
        ) : (
          <ol className="py-1">
            <AnimatePresence initial={false}>
              {feed.items.map((m) => (
                <MessageRow
                  key={m.id}
                  m={m}
                  now={now}
                  mine={ownNick(m.nick)}
                  canAct={!!unlocked}
                  canHide={isCreator}
                  revealed={revealed.has(m.id)}
                  queued={queuedOps.get(m.id)}
                  onReveal={() => setRevealed((s) => new Set(s).add(m.id))}
                  onDelete={() => act({ op: "chat_delete", id: m.id }, "Deleting with the next batch.")}
                  onHide={() => act({ op: "chat_hide", id: m.id }, "Hiding with the next batch.")}
                  onReport={(reason) => act({ op: "chat_report", id: m.id, reason }, "Reported. Thanks for keeping it clean.")}
                />
              ))}
              {visiblePending.map((p) => (
                <PendingRow key={`p-${p.id}`} p={p} />
              ))}
            </AnimatePresence>
          </ol>
        )}
      </div>

      {key.status === "loading" ? null : !unlocked ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 px-4 py-3 text-sm">
          <span className="text-muted-foreground">Reading is open to everyone. Unlock your anon key to post.</span>
          <Link href={`/key?next=${encodeURIComponent(`/token/${mint}`)}`} className="inline-flex items-center gap-1.5 text-zec underline-offset-4 hover:underline">
            <Key size={14} weight="light" aria-hidden />
            {key.status === "locked" ? "Unlock" : "Get a key"}
          </Link>
        </div>
      ) : (
        <Composer
          key={`${unlocked.network}:${unlocked.pubkey}`}
          mint={mint}
          params={params}
          isCreator={isCreator}
          badgeAck={own.badgeAck}
          onPosted={(p) => setPending((list) => [...list, p])}
        />
      )}
    </div>
  );
}

function MessageRow({
  m,
  now,
  mine,
  canAct,
  canHide,
  revealed,
  queued,
  onReveal,
  onDelete,
  onHide,
  onReport,
}: {
  m: ChatItem;
  now: number | null;
  mine: boolean;
  canAct: boolean;
  canHide: boolean;
  revealed: boolean;
  queued?: "delete" | "hide";
  onReveal: () => void;
  onDelete: () => void;
  onHide: () => void;
  onReport: (r: ChatReportReason) => void;
}) {
  const gone = !!m.removed;
  const hidden = !!m.hiddenByCreator && !revealed;
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, filter: "blur(6px)" }}
      animate={{ opacity: 1, filter: "blur(0px)" }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className={cn("group flex gap-3 px-4 py-2.5", mine && "bg-zec/[0.03]")}
    >
      <NickGlyph nick={m.nick} creator={m.isCreator} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <span className={cn("font-mono", m.isCreator ? "text-zec" : "text-muted-foreground")}>anon-{m.nick}</span>
          {m.isCreator && (
            <span title={BADGE_TITLE} className="inline-flex items-center gap-1 rounded-full border border-zec/40 bg-zec/10 px-1.5 py-px text-[10px] text-zec">
              <SealCheck size={11} weight="fill" aria-hidden />
              creator
              <span className="sr-only">. {BADGE_TITLE}</span>
            </span>
          )}
          {mine && <span className="rounded-full border border-border px-1.5 py-px text-[10px] text-faint-foreground">you</span>}
          <span className="tabular font-mono text-[11px] text-faint-foreground">{now === null ? "" : timeAgo(m.ts, now)}</span>
          {queued && <span className="text-[11px] text-faint-foreground italic">{queued === "delete" ? "deleting with the next batch…" : "hiding with the next batch…"}</span>}
        </div>

        {gone ? (
          <p className="mt-1 text-sm text-faint-foreground italic">{m.removed === "reports" ? "Hidden after reports" : "Removed by moderators"}</p>
        ) : hidden ? (
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-faint-foreground">
            <EyeSlash size={14} weight="light" aria-hidden />
            <span className="italic">Hidden by creator</span>
            <button
              type="button"
              onClick={onReveal}
              className="hit inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <Eye size={12} weight="light" aria-hidden />
              Show
            </button>
          </p>
        ) : (
          <p className={cn("mt-1 text-sm leading-relaxed [overflow-wrap:anywhere] whitespace-pre-line text-foreground/90", m.hiddenByCreator && "text-muted-foreground")}>
            {m.hiddenByCreator && <span className="mr-1.5 text-[11px] text-faint-foreground not-italic">Hidden by creator ·</span>}
            <bdi>{m.text}</bdi>
          </p>
        )}
      </div>

      {canAct && !gone && !queued && (
        <MessageMenu mine={mine} canHide={canHide && !mine && !m.hiddenByCreator} onDelete={onDelete} onHide={onHide} onReport={onReport} />
      )}
    </motion.li>
  );
}

const ITEM =
  "flex cursor-default items-center gap-2 rounded-md px-2.5 py-2 text-sm text-foreground/90 outline-none select-none data-[highlighted]:bg-surface-3 data-[highlighted]:text-foreground";

function MessageMenu({ mine, canHide, onDelete, onHide, onReport }: { mine: boolean; canHide: boolean; onDelete: () => void; onHide: () => void; onReport: (r: ChatReportReason) => void }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label="Message actions"
        className="hit -mr-1 grid size-7 shrink-0 place-items-center rounded-md text-faint-foreground opacity-100 transition-[opacity,color] hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[state=open]:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
      >
        <DotsThree size={18} weight="bold" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className="z-50 min-w-44 rounded-xl border border-border bg-popover p-1 shadow-xl">
          {mine ? (
            <DropdownMenu.Item onSelect={onDelete} className={cn(ITEM, "text-sell data-[highlighted]:text-sell")}>
              Delete
            </DropdownMenu.Item>
          ) : (
            <>
              {canHide && (
                <>
                  <DropdownMenu.Item onSelect={onHide} className={ITEM}>
                    Hide (as creator)
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator className="my-1 h-px bg-border" />
                </>
              )}
              <DropdownMenu.Label className="px-2.5 pt-1.5 pb-1 text-[11px] text-faint-foreground">Report as</DropdownMenu.Label>
              {(["spam", "scam", "abuse"] as const).map((r) => (
                <DropdownMenu.Item key={r} onSelect={() => onReport(r)} className={ITEM}>
                  {r === "spam" ? "Spam" : r === "scam" ? "Scam or phishing" : "Abuse"}
                </DropdownMenu.Item>
              ))}
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function PendingRow({ p }: { p: Pending }) {
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="flex gap-3 bg-zec/[0.03] px-4 py-2.5"
    >
      {p.nick ? <NickGlyph nick={p.nick} creator={p.creator} className="mt-0.5 opacity-60" /> : <span className="size-7 shrink-0" />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 text-xs">
          {p.nick && <span className={cn("font-mono", p.creator ? "text-zec/70" : "text-muted-foreground/70")}>anon-{p.nick}</span>}
          <span className="inline-flex items-center gap-1.5 text-[11px] text-faint-foreground">
            <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-zec/70 motion-reduce:animate-none" />
            {p.slow ? SLOW_NOTE : QUEUED}
          </span>
        </div>
        <p className="mt-1 text-sm leading-relaxed [overflow-wrap:anywhere] whitespace-pre-line text-foreground/60">
          <bdi>{p.text}</bdi>
        </p>
      </div>
    </motion.li>
  );
}

// ---- composer ----

function Composer({
  mint,
  params,
  isCreator,
  badgeAck,
  onPosted,
}: {
  mint: string;
  params: ChatParams | undefined;
  isCreator: boolean;
  badgeAck: boolean;
  onPosted: (p: Pending) => void;
}) {
  const id = useId();
  const network = useNetwork();
  const history = useHistory();
  const key = useKeyState();
  const pubkey = key.status === "unlocked" ? key.pubkey : null;
  const tabActions = useActions(network, pubkey);
  const [raw, setRaw] = useState("");
  const [slowOverride, setSlowOverride] = useState<boolean | null>(null);
  const [badgeWanted, setBadge] = useState(false);
  const badge = badgeWanted && isCreator;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "self" | "badge">(null);
  const now = useNow(15_000);

  const own = useMemo(
    () => [...history.entries.map((e) => ({ mint: e.mint, submittedAt: e.submittedAt })), ...tabActions.map((a) => ({ mint: a.mint, submittedAt: a.submittedAt }))],
    [history.entries, tabActions],
  );
  const recent = now !== null && slowByDefault(own, mint, now);
  const slow = slowOverride ?? recent;

  const text = normalizeChatText(raw);
  const left = remaining(text);
  const check = checkChatText(text);
  const blocked = !check.ok && check.problem !== "empty";

  const send = async (force: "self" | "badge" | null = null) => {
    setError(null);
    if (!check.ok) return setError(PROBLEM_TEXT[check.problem]);
    if (force !== "self" && force !== "badge" && now !== null && linksToYou(text, { mint, ownAmounts: ownAmounts(history.entries, now) })) return setConfirm("self");
    if (badge && !badgeAck && force !== "badge") return setConfirm("badge");
    const signer = getSigner(network);
    if (!signer) return setError(errorText(new ApiError("locked", "")));
    setConfirm(null);
    setBusy(true);
    try {
      const action: SignedAction = { op: "chat", mint, text, ...(badge ? { showCreatorBadge: true } : {}), ...(slow ? { slow: true } : {}) };
      const r = await api.postAction(signer, action);
      if (r.nick) void rememberNick(network, signer.pubkey, mint, r.nick, badge);
      if (badge) void ackBadge(network, signer.pubkey);
      onPosted({ id: r.id, text, nick: r.nick, creator: badge, slow, at: Date.now() });
      setRaw("");
    } catch (e) {
      setError(eligibilityText(e, params));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      className="border-t border-border/60 p-3 sm:p-4"
    >
      <label htmlFor={`${id}-t`} className="sr-only">
        Message
      </label>
      <div className="flex items-end gap-2 rounded-xl border border-border bg-surface-1 px-3 py-2 focus-within:border-ring">
        <textarea
          id={`${id}-t`}
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            setConfirm(null);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          maxLength={2000}
          placeholder="Say something, anonymously"
          autoComplete="off"
          spellCheck
          aria-invalid={blocked || undefined}
          aria-describedby={`${id}-hint`}
          className="max-h-40 min-h-10 flex-1 resize-none bg-transparent text-sm leading-relaxed outline-none placeholder:text-faint-foreground"
        />
        <button
          type="submit"
          disabled={busy || !check.ok}
          aria-label="Post message"
          className="hit grid size-9 shrink-0 place-items-center rounded-lg bg-zec text-background transition-[opacity,transform] duration-150 active:scale-95 disabled:opacity-30 motion-reduce:active:scale-100"
        >
          <PaperPlaneRight size={16} weight="fill" />
        </button>
      </div>

      <div id={`${id}-hint`} className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Toggle on={slow} onChange={(v) => setSlowOverride(v)} label="Slow post" />
          {isCreator && <Toggle on={badge} onChange={setBadge} label="Post as creator" />}
        </div>
        <span className={cn("tabular font-mono text-[11px]", left < 0 ? "text-sell" : left < 30 ? "text-zec" : "text-faint-foreground")} aria-live="polite">
          {left}
        </span>
      </div>
      {slow && <p className="mt-1.5 text-[11px] text-faint-foreground">{recent ? SLOW_NOTE : "Delayed a few minutes."}</p>}

      <AnimatePresence initial={false}>
        {(error || blocked || confirm) && (
          <motion.div
            key={confirm ?? error ?? (check.ok ? "" : check.problem)}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            role="alert"
            className={cn(
              "mt-2 flex gap-2 rounded-xl border px-3 py-2.5 text-sm text-pretty",
              confirm ? "border-zec/30 bg-zec/5" : "border-sell/30 bg-sell/5",
            )}
          >
            <WarningCircle size={16} weight="light" aria-hidden className={cn("mt-0.5 shrink-0", confirm ? "text-zec" : "text-sell")} />
            <div className="min-w-0">
              <p className="text-foreground/90">
                {confirm === "self" ? SELF_LINK_TEXT : confirm === "badge" ? BADGE_WARNING : (error ?? (!check.ok ? PROBLEM_TEXT[check.problem] : ""))}
              </p>
              {confirm && (
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => void send(confirm)}
                    className="rounded-full border border-zec/50 bg-zec/10 px-3 py-1 text-xs text-foreground transition-colors hover:bg-zec/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    {confirm === "self" ? "Post anyway" : "Post as creator"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirm(null)}
                    className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    Edit
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </form>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-muted-foreground">
      <input type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span aria-hidden className="relative h-4 w-7 shrink-0 rounded-full border border-border-strong bg-surface-2 transition-colors peer-checked:bg-zec/30 peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
        <span className={cn("absolute top-[1px] left-[1px] size-3 rounded-full bg-muted-foreground transition-transform duration-200", on && "translate-x-3 bg-zec")} />
      </span>
      <span className={cn(on && "text-foreground")}>{label}</span>
    </label>
  );
}
