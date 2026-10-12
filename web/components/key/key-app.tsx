"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  CircleNotch,
  Copy,
  Key,
  LockKey,
  LockKeyOpen,
  Plus,
  ShieldCheck,
  Trash,
  Warning,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { keypairFromMnemonic, newMnemonic } from "@/lib/crypto/keys";
import { forgetDevice, getVault, lock, storeAndUnlock, unlock, useKeyState } from "@/lib/crypto/session";
import { decryptVault, encryptMnemonic, WrongPasswordError } from "@/lib/crypto/vault";
import { shortAddr } from "@/lib/format";
import { getNetwork, networkConfig, type Network } from "@/lib/network";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmWords } from "./confirm-words";
import { Field, NewPasswordForm } from "./password-form";
import { PhraseGrid } from "./phrase-grid";
import { RestoreForm } from "./restore-form";

type Flow = null | "create" | "restore";

const SURFACE = { duration: 0.3, ease: [0.16, 1, 0.3, 1] as const };

/** Where to go after unlocking, from ?next=. Whitelisted: never an open redirect. */
const NEXT_PATHS = ["/portfolio", "/pay"] as const;

function nextPath(): string | null {
  const n = new URLSearchParams(window.location.search).get("next");
  return n && (NEXT_PATHS as readonly string[]).includes(n) ? n : null;
}

export function KeyApp() {
  const state = useKeyState();
  const [flow, setFlow] = useState<Flow>(null);
  const router = useRouter();
  const prev = useRef(state.status);

  // Came here from a gated page: return there once the key gets unlocked (not if it already was).
  useEffect(() => {
    const was = prev.current;
    prev.current = state.status;
    if (state.status === "unlocked" && was !== "unlocked" && was !== "loading") {
      const n = nextPath();
      if (n) router.replace(n);
    }
  }, [state.status, router]);

  // Loading is rendered outside AnimatePresence: the first real view appears without waiting on an exit.
  if (state.status === "loading")
    return (
      <div className="w-full max-w-xl">
        <LoadingCard />
      </div>
    );

  let view: React.ReactNode;
  let viewKey: string;
  if (flow === "create") {
    viewKey = "create";
    view = <CreateFlow onCancel={() => setFlow(null)} onDone={() => setFlow(null)} />;
  } else if (flow === "restore") {
    viewKey = "restore";
    view = (
      <RestoreFlow
        replacing={state.status !== "none"}
        onCancel={() => setFlow(null)}
        onDone={() => setFlow(null)}
      />
    );
  } else if (state.status === "none") {
    viewKey = "choice";
    view = <Choice onCreate={() => setFlow("create")} onRestore={() => setFlow("restore")} />;
  } else if (state.status === "locked") {
    viewKey = "locked";
    view = <UnlockCard pubkey={state.pubkey} onRestore={() => setFlow("restore")} />;
  } else {
    viewKey = "unlocked";
    view = <UnlockedCard pubkey={state.pubkey} network={state.network} />;
  }

  return (
    <div className="w-full max-w-xl">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={viewKey}
          initial={{ opacity: 0, filter: "blur(8px)" }}
          animate={{ opacity: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, filter: "blur(6px)", transition: { duration: 0.15 } }}
          transition={SURFACE}
        >
          {view}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// ---------- shells ----------

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("relative overflow-hidden rounded-2xl border border-border bg-card/60 p-5 sm:p-7", className)}>
      {children}
    </section>
  );
}

function CardTitle({ title, lead }: { title: string; lead?: React.ReactNode }) {
  return (
    <header className="mb-6">
      <h2 className="text-xl font-medium tracking-tight">{title}</h2>
      {lead && <p className="mt-1.5 text-sm text-pretty text-muted-foreground">{lead}</p>}
    </header>
  );
}

function LoadingCard() {
  return (
    <Card>
      <div aria-busy className="space-y-3">
        <Skeleton className="h-6 w-40 bg-skeleton" />
        <Skeleton className="h-4 w-64 bg-skeleton" />
        <Skeleton className="mt-6 h-11 w-full rounded-full bg-skeleton" />
      </div>
    </Card>
  );
}

function Steps({ steps, current }: { steps: string[]; current: number }) {
  const id = useId();
  return (
    <ol className="mb-6 flex items-center gap-1 text-xs" aria-label="Progress">
      {steps.map((s, i) => (
        <li
          key={s}
          aria-current={i === current ? "step" : undefined}
          className={cn(
            "relative rounded-full px-3 py-1.5 transition-colors duration-200",
            i === current ? "text-foreground" : i < current ? "text-muted-foreground" : "text-faint-foreground",
          )}
        >
          {i === current && (
            <motion.span
              layoutId={`${id}-step`}
              className="absolute inset-0 rounded-full bg-surface-3"
              transition={{ type: "spring", bounce: 0, duration: 0.35 }}
            />
          )}
          <span className="relative">
            <span className="tabular mr-1.5 font-mono">{i + 1}</span>
            {s}
          </span>
        </li>
      ))}
    </ol>
  );
}

function BackLink({ onClick, children = "Back" }: { onClick: () => void; children?: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-5 inline-flex items-center gap-1.5 rounded-md text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <ArrowLeft size={14} weight="light" />
      {children}
    </button>
  );
}

// ---------- no key ----------

function Choice({ onCreate, onRestore }: { onCreate: () => void; onRestore: () => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <ChoiceButton
        icon={<Plus size={22} weight="light" />}
        title="Create a new key"
        body="12 words, generated in this browser. Takes a minute."
        onClick={onCreate}
        primary
      />
      <ChoiceButton
        icon={<Key size={22} weight="light" />}
        title="Restore from 12 words"
        body="Already have a key? Bring it to this device."
        onClick={onRestore}
      />
    </div>
  );
}

function ChoiceButton({
  icon,
  title,
  body,
  onClick,
  primary,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative flex flex-col items-start gap-6 overflow-hidden rounded-2xl border p-5 text-left transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:min-h-48",
        primary ? "border-zec/30 hover:border-zec/60" : "border-border hover:border-border-strong",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute -top-10 -right-10 size-32 rounded-full blur-3xl transition-opacity duration-300",
          primary ? "bg-zec/15 opacity-60 group-hover:opacity-100" : "bg-white/5 opacity-0 group-hover:opacity-100",
        )}
      />
      <span className={cn("relative", primary ? "text-zec" : "text-muted-foreground")}>{icon}</span>
      <span className="relative mt-auto">
        <span className="flex items-center gap-1.5 font-medium">
          {title}
          <ArrowRight size={14} weight="light" className="transition-transform duration-200 group-hover:translate-x-0.5" />
        </span>
        <span className="mt-1 block text-sm text-muted-foreground">{body}</span>
      </span>
    </button>
  );
}

// ---------- create ----------

function CreateFlow({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const [mnemonic] = useState(newMnemonic);
  const words = mnemonic.split(" ");
  const [step, setStep] = useState(0);
  const [seen, setSeen] = useState(false);
  const [ack, setAck] = useState(false);

  return (
    <Card>
      <BackLink onClick={step === 0 ? onCancel : () => setStep(step - 1)}>{step === 0 ? "Cancel" : "Back"}</BackLink>
      <Steps steps={["Write down", "Confirm", "Protect"]} current={step} />

      {step === 0 && (
        <>
          <CardTitle
            title="Your recovery phrase"
            lead="These 12 words are your account. Write them on paper, in order. No screenshots, no cloud notes."
          />
          <PhraseGrid words={words} onReveal={() => setSeen(true)} />
          <Notice className="mt-6">
            Anyone with these words controls your balance. Unzeen can&apos;t recover them. Don&apos;t import them into a
            wallet.
          </Notice>
          <label className="mt-5 flex cursor-pointer items-start gap-3 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              disabled={!seen}
              className="mt-0.5 size-4 shrink-0 accent-(--zec) disabled:opacity-40"
            />
            I wrote down all 12 words, in order, offline.
          </label>
          <Button
            size="lg"
            className="mt-5 h-11 w-full rounded-full text-sm"
            disabled={!seen || !ack}
            onClick={() => setStep(1)}
          >
            Continue
            <ArrowRight weight="light" />
          </Button>
        </>
      )}

      {step === 1 && (
        <>
          <CardTitle title="Confirm your backup" lead="Put the right words in place, from what you wrote down." />
          <ConfirmWords words={words} onConfirmed={() => setStep(2)} />
        </>
      )}

      {step === 2 && (
        <>
          <CardTitle
            title="Protect it on this device"
            lead="The phrase is stored here only encrypted with this password. Nothing is sent to Unzeen."
          />
          <NewPasswordForm
            submitLabel="Encrypt and save"
            onSubmit={async (pw) => {
              const vault = await encryptMnemonic(mnemonic, pw, getNetwork());
              const kp = await keypairFromMnemonic(mnemonic, vault.network);
              storeAndUnlock(vault, kp.secretKey);
              toast("Anon key created");
              onDone();
            }}
          />
        </>
      )}
    </Card>
  );
}

// ---------- restore ----------

function RestoreFlow({
  replacing,
  onCancel,
  onDone,
}: {
  replacing: boolean;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const step = mnemonic ? 1 : 0;

  return (
    <Card>
      <BackLink onClick={step === 0 ? onCancel : () => setMnemonic(null)}>{step === 0 ? "Cancel" : "Back"}</BackLink>
      <Steps steps={["Enter words", "Protect"]} current={step} />
      {step === 0 ? (
        <>
          <CardTitle title="Restore your anon key" lead="Type your 12 words. They are checked here, not on a server." />
          {replacing && (
            <Notice className="mb-5">
              This replaces the key saved in this browser. Make sure you have its 12 words first.
            </Notice>
          )}
          <RestoreForm onPhrase={setMnemonic} />
        </>
      ) : (
        <>
          <CardTitle
            title="Protect it on this device"
            lead="Pick a password for this browser. It can differ from the one you used elsewhere."
          />
          <NewPasswordForm
            submitLabel="Encrypt and save"
            onSubmit={async (pw) => {
              const vault = await encryptMnemonic(mnemonic!, pw, getNetwork());
              const kp = await keypairFromMnemonic(mnemonic!, vault.network);
              storeAndUnlock(vault, kp.secretKey);
              toast("Anon key restored");
              onDone();
            }}
          />
        </>
      )}
    </Card>
  );
}

// ---------- locked ----------

function UnlockCard({ pubkey, onRestore }: { pubkey: string; onRestore: () => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card>
      <div className="mb-6 flex items-start gap-4">
        <Silhouette />
        <div className="min-w-0">
          <h2 className="text-xl font-medium tracking-tight">Unlock your anon key</h2>
          <p className="mt-1 font-mono text-xs text-faint-foreground">{shortAddr(pubkey, 6, 6)}</p>
        </div>
      </div>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const vault = getVault();
          if (!vault || !pw) return;
          setBusy(true);
          setError(null);
          try {
            const { keypair, upgraded } = await decryptVault(vault, pw);
            if (upgraded) {
              // v0.3 derives a separate key per network: same phrase and password, new anon ID.
              storeAndUnlock(upgraded, keypair.secretKey);
              toast("Anon key upgraded", { description: "Keys are now separate per network, so your anon ID changed." });
            } else unlock(vault.network, keypair.pubkey, keypair.secretKey);
          } catch (err) {
            setError(err instanceof WrongPasswordError ? "Wrong password." : "Could not unlock. Try again.");
            setBusy(false);
          }
        }}
      >
        <Field id="unlock-password" label="Password" error={error}>
          <Input
            id="unlock-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={pw}
            onChange={(e) => {
              setPw(e.target.value);
              setError(null);
            }}
            aria-invalid={!!error}
            disabled={busy}
          />
        </Field>
        <Button type="submit" size="lg" className="h-11 w-full rounded-full text-sm" disabled={busy || !pw}>
          {busy ? <CircleNotch className="animate-spin" /> : <LockKeyOpen weight="light" />}
          {busy ? "Unlocking…" : "Unlock"}
        </Button>
      </form>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-4 text-sm">
        <button
          type="button"
          onClick={onRestore}
          className="rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          Forgot password? Restore from 12 words
        </button>
        <ForgetButton />
      </div>
    </Card>
  );
}

// ---------- unlocked ----------

function UnlockedCard({ pubkey, network }: { pubkey: string; network: Network }) {
  const [showPhrase, setShowPhrase] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pubkey);
      toast("Anon ID copied");
    } catch {
      toast.error("Clipboard unavailable");
    }
  };

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex items-start gap-4">
          <Silhouette lit />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-xs text-zec">
              <ShieldCheck size={14} weight="duotone" />
              Unlocked in this tab · {networkConfig(network).label}
            </p>
            <h2 className="mt-1 text-xl font-medium tracking-tight">Your anon key</h2>
            <button
              type="button"
              onClick={copy}
              aria-label="Copy anon ID"
              className="mt-1 inline-flex max-w-full items-center gap-1.5 rounded-md font-mono text-xs text-faint-foreground transition-colors hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <span className="truncate">{shortAddr(pubkey, 8, 8)}</span>
              <Copy size={12} weight="light" className="shrink-0" />
            </button>
          </div>
        </div>
        <p className="mt-5 text-sm text-pretty text-muted-foreground">
          It signs your actions in this browser. Unzeen sees signatures, never the key. Reloading the page locks it
          again.
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <Button asChild size="lg" className="h-11 flex-1 rounded-full text-sm">
            <Link href="/portfolio">
              Go to portfolio
              <ArrowRight weight="light" />
            </Link>
          </Button>
          <Button variant="outline" size="lg" className="h-11 flex-1 rounded-full text-sm" onClick={() => lock()}>
            <LockKey weight="light" />
            Lock
          </Button>
        </div>
      </Card>

      <Card>
        {showPhrase ? (
          <RevealPhrase onClose={() => setShowPhrase(false)} />
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium">Recovery phrase</h3>
              <p className="mt-0.5 text-sm text-muted-foreground">Needs your password again.</p>
            </div>
            <Button variant="outline" className="h-10 rounded-full px-4" onClick={() => setShowPhrase(true)}>
              Show phrase
            </Button>
          </div>
        )}
      </Card>

      <div className="flex justify-end px-1">
        <ForgetButton />
      </div>
    </div>
  );
}

function RevealPhrase({ onClose }: { onClose: () => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [words, setWords] = useState<string[] | null>(null);

  if (words)
    return (
      <>
        <CardTitle title="Recovery phrase" />
        <PhraseGrid words={words} />
        <Button variant="outline" className="mt-5 h-10 w-full rounded-full" onClick={onClose}>
          Done
        </Button>
      </>
    );

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const vault = getVault();
        if (!vault) return;
        setBusy(true);
        setError(null);
        try {
          const { mnemonic } = await decryptVault(vault, pw);
          setWords(mnemonic.split(" "));
        } catch (err) {
          setError(err instanceof WrongPasswordError ? "Wrong password." : "Could not decrypt. Try again.");
        } finally {
          setBusy(false);
          setPw("");
        }
      }}
    >
      <CardTitle title="Show recovery phrase" lead="Make sure no one is looking at your screen." />
      <Field id="reveal-password" label="Password" error={error}>
        <Input
          id="reveal-password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          aria-invalid={!!error}
          disabled={busy}
        />
      </Field>
      <div className="flex gap-2">
        <Button type="button" variant="ghost" className="h-10 flex-1 rounded-full" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" className="h-10 flex-1 rounded-full" disabled={busy || !pw}>
          {busy && <CircleNotch className="animate-spin" />}
          Continue
        </Button>
      </div>
    </form>
  );
}

function ForgetButton() {
  const [confirm, setConfirm] = useState(false);
  if (!confirm)
    return (
      <button
        type="button"
        onClick={() => setConfirm(true)}
        className="inline-flex items-center gap-1.5 rounded-md text-sm text-faint-foreground transition-colors hover:text-sell focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Trash size={14} weight="light" />
        Remove from this device
      </button>
    );
  return (
    <span role="group" aria-label="Confirm removal" className="inline-flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">Only your 12 words can bring it back.</span>
      <Button
        variant="destructive"
        size="sm"
        className="rounded-full px-3"
        onClick={() => {
          forgetDevice();
          toast("Key removed from this device");
        }}
      >
        Remove
      </Button>
      <Button variant="ghost" size="sm" className="rounded-full px-3" onClick={() => setConfirm(false)}>
        Keep
      </Button>
    </span>
  );
}

// ---------- bits ----------

function Notice({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("flex gap-2.5 rounded-lg border border-zec/20 bg-zec-soft px-3.5 py-3 text-sm text-pretty text-muted-foreground", className)}>
      <Warning size={16} weight="duotone" className="mt-0.5 shrink-0 text-zec" />
      <span>{children}</span>
    </p>
  );
}

/** No avatar: a blurred presence. Lit = unlocked. */
function Silhouette({ lit }: { lit?: boolean }) {
  return (
    <span aria-hidden className="relative grid size-12 shrink-0 place-items-center">
      <span className={cn("absolute inset-0 rounded-full blur-md transition-colors duration-500", lit ? "bg-zec/30" : "bg-white/10")} />
      <span className="relative size-6 rounded-full bg-[radial-gradient(circle_at_50%_35%,#3a3a42,#0b0b0d_70%)] ring-1 ring-white/10" />
    </span>
  );
}
