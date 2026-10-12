"use client";

import { useRef, useState } from "react";
import { ArrowRight } from "@phosphor-icons/react";
import { isValidMnemonic, isWord, normalizeMnemonic } from "@/lib/crypto/keys";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const N = 12;

/** 12 inputs. Pasting the whole phrase into any box fills all of them. */
export function RestoreForm({ onPhrase }: { onPhrase: (mnemonic: string) => void }) {
  const [words, setWords] = useState<string[]>(() => Array(N).fill(""));
  const [blurred, setBlurred] = useState<boolean[]>(() => Array(N).fill(false));
  const [checksumError, setChecksumError] = useState(false);
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  const setAt = (i: number, v: string) => {
    setChecksumError(false);
    const parts = normalizeMnemonic(v).split(" ").filter(Boolean);
    if (parts.length > 1) {
      // Pasted several words: spread from here.
      setWords((prev) => {
        const next = [...prev];
        parts.slice(0, N - i).forEach((p, k) => (next[i + k] = p));
        return next;
      });
      setBlurred((b) => b.map((x, k) => (k >= i && k < i + parts.length ? true : x)));
      refs.current[Math.min(N - 1, i + parts.length)]?.focus();
      return;
    }
    setWords((prev) => prev.map((w, k) => (k === i ? v.trim().toLowerCase() : w)));
  };

  const filled = words.every((w) => w.length > 0);
  const allKnown = words.every(isWord);

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        const m = words.join(" ");
        if (!isValidMnemonic(m)) {
          setChecksumError(true);
          return;
        }
        onPhrase(m);
      }}
    >
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {words.map((w, i) => {
          const invalid = blurred[i] && w.length > 0 && !isWord(w);
          return (
            <li key={i}>
              <label
                className={cn(
                  "flex items-center gap-2.5 rounded-lg border bg-surface-1 px-3 transition-colors duration-150 focus-within:border-ring",
                  invalid ? "border-sell/60" : "border-border",
                )}
              >
                <span className="tabular w-5 shrink-0 text-right font-mono text-[11px] text-faint-foreground">{i + 1}</span>
                <input
                  ref={(el) => {
                    refs.current[i] = el;
                  }}
                  value={w}
                  onChange={(e) => setAt(i, e.target.value)}
                  onBlur={() => setBlurred((b) => b.map((x, k) => (k === i ? true : x)))}
                  onKeyDown={(e) => {
                    if ((e.key === " " || e.key === "Enter") && w && i < N - 1) {
                      e.preventDefault();
                      refs.current[i + 1]?.focus();
                    } else if (e.key === "Backspace" && !w && i > 0) {
                      e.preventDefault();
                      refs.current[i - 1]?.focus();
                    }
                  }}
                  aria-label={`Word ${i + 1}`}
                  aria-invalid={invalid}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  inputMode="text"
                  enterKeyHint={i < N - 1 ? "next" : "done"}
                  className="h-11 w-full min-w-0 bg-transparent font-mono text-base text-foreground outline-none sm:text-[15px]"
                />
              </label>
            </li>
          );
        })}
      </ol>

      <p aria-live="polite" className="min-h-5 text-sm">
        {checksumError ? (
          <span className="text-sell">These 12 words are not a valid phrase. Check the order and spelling.</span>
        ) : words.some((w, i) => blurred[i] && w && !isWord(w)) ? (
          <span className="text-sell">Some words are not in the BIP-39 list.</span>
        ) : (
          <span className="text-faint-foreground">Tip: paste all 12 words into the first box.</span>
        )}
      </p>

      <Button type="submit" size="lg" className="h-11 w-full rounded-full text-sm" disabled={!filled || !allKnown}>
        Continue
        <ArrowRight weight="light" />
      </Button>
    </form>
  );
}
