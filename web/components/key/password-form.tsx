"use client";

import { useState } from "react";
import { CircleNotch, LockKey } from "@phosphor-icons/react";
import { MIN_PASSWORD_LENGTH } from "@/lib/crypto/vault";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Props {
  submitLabel: string;
  /** Throws to show an error. */
  onSubmit: (password: string) => Promise<void>;
}

/** New password with confirmation. Encrypts the phrase on this device only. */
export function NewPasswordForm({ submitLabel, onSubmit }: Props) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const tooShort = pw.length < MIN_PASSWORD_LENGTH;
  const mismatch = pw2.length > 0 && pw !== pw2;

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setTouched(true);
        if (tooShort || pw !== pw2) return;
        setBusy(true);
        setError(null);
        try {
          await onSubmit(pw);
        } catch {
          setError("Could not encrypt the key in this browser. Try again.");
          setBusy(false);
        }
      }}
    >
      <Field id="new-password" label="Password" hint={`At least ${MIN_PASSWORD_LENGTH} characters. It never leaves this device.`}>
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          aria-invalid={touched && tooShort}
          disabled={busy}
        />
      </Field>
      <Field id="new-password-2" label="Repeat password" error={(touched || pw2.length >= pw.length) && mismatch ? "Passwords don't match." : null}>
        <Input
          id="new-password-2"
          type="password"
          autoComplete="new-password"
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
          aria-invalid={mismatch}
          disabled={busy}
        />
      </Field>
      {error && (
        <p role="alert" className="text-sm text-sell">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" className="h-11 w-full rounded-full text-sm" disabled={busy || tooShort || pw !== pw2}>
        {busy ? <CircleNotch className="animate-spin" /> : <LockKey weight="light" />}
        {busy ? "Encrypting…" : submitLabel}
      </Button>
      <p className="text-center text-xs text-faint-foreground">
        Forgot it later? Restore from your 12 words and pick a new one.
      </p>
    </form>
  );
}

export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm text-muted-foreground">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-sell">{error}</p>
      ) : hint ? (
        <p className="text-xs text-faint-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
