"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { MagnifyingGlass, X } from "@phosphor-icons/react";
import { api } from "@/lib/api/client";
import type { Token } from "@/lib/api/types";
import { mintError, parseMint } from "@/lib/ca";
import { shortAddr } from "@/lib/format";
import { useNetwork } from "@/lib/network";
import { cn } from "@/lib/utils";

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * Search by contract address (CA). The address is validated here (base58, 32 bytes) and the browser
 * goes to /token/<mint>: no request per keystroke, nothing sent to third parties. Free text matches
 * tickers of the already public /api/tokens list, in the browser only.
 */
export function CaSearch() {
  const [open, setOpen] = useState(false);
  const network = useNetwork(); // the ticker list belongs to one network: reset on switch
  return (
    <>
      <div className="hidden lg:block">
        <SearchBox key={network} />
      </div>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search token by address"
        className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none lg:hidden"
      >
        <MagnifyingGlass size={16} weight="light" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="fixed inset-x-0 top-0 z-50 border-b border-border/60 bg-background/95 px-3 py-2.5 backdrop-blur-xl lg:hidden"
          >
            <div className="flex items-center gap-2">
              <SearchBox key={network} autoFocus onDone={() => setOpen(false)} className="flex-1" />
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close search"
                className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <X size={16} weight="light" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function SearchBox({ autoFocus, onDone, className }: { autoFocus?: boolean; onDone?: () => void; className?: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const loading = useRef(false);
  const id = useId();

  const go = (mint: string) => {
    setQ("");
    setError(null);
    setFocused(false);
    onDone?.();
    router.push(`/token/${mint}`);
  };

  // Public token list for ticker matches: fetched once on first focus, same request for everyone.
  const loadTokens = () => {
    if (tokens || loading.current) return;
    loading.current = true;
    api
      .getTokens()
      .then(setTokens)
      .catch(() => setTokens([]))
      .finally(() => (loading.current = false));
  };
  useEffect(() => {
    if (autoFocus) loadTokens();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const text = q.trim().replace(/^\$/, "").toLowerCase();
  const looksLikeAddress = q.trim().length >= 32 || /^https?:/i.test(q.trim());
  const matches =
    !text || looksLikeAddress || !tokens
      ? []
      : tokens.filter((t) => t.symbol.toLowerCase().startsWith(text) || t.name.toLowerCase().includes(text)).slice(0, 5);

  const submit = () => {
    const mint = parseMint(q);
    if (mint) return go(mint);
    const pick = matches[active] ?? matches[0];
    if (pick) return go(pick.mint);
    setError(mintError(q) ?? (q.trim() ? "No token with that ticker. Paste the contract address." : null));
  };

  const showList = focused && matches.length > 0;

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className={cn("relative", className)}
    >
      <label htmlFor={`${id}-q`} className="sr-only">
        Token address or ticker
      </label>
      <span
        className={cn(
          "flex h-9 items-center gap-2 rounded-full border bg-surface-1 px-3 transition-[border-color,width] duration-200 focus-within:border-ring lg:h-8 lg:w-56 lg:focus-within:w-80",
          error ? "border-destructive/60" : "border-border",
        )}
      >
        <MagnifyingGlass size={14} weight="light" className="shrink-0 text-faint-foreground" aria-hidden />
        <input
          id={`${id}-q`}
          autoFocus={autoFocus}
          value={q}
          placeholder="Paste token address"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={showList}
          aria-controls={`${id}-list`}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-err` : undefined}
          onFocus={() => {
            setFocused(true);
            loadTokens();
          }}
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          onChange={(e) => {
            setQ(e.target.value);
            setError(null);
            setActive(0);
          }}
          onPaste={(e) => {
            // A valid pasted address goes straight to the token page.
            const mint = parseMint(e.clipboardData.getData("text"));
            if (mint) {
              e.preventDefault();
              go(mint);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && matches.length) {
              e.preventDefault();
              setActive((a) => (a + 1) % matches.length);
            } else if (e.key === "ArrowUp" && matches.length) {
              e.preventDefault();
              setActive((a) => (a - 1 + matches.length) % matches.length);
            } else if (e.key === "Escape") {
              setQ("");
              setError(null);
              onDone?.();
            }
          }}
          className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:font-sans placeholder:text-faint-foreground"
        />
      </span>
      <AnimatePresence>
        {(showList || error) && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="absolute top-full right-0 left-0 z-50 mt-1.5 overflow-hidden rounded-xl border border-border bg-popover shadow-xl lg:w-80"
          >
            {error ? (
              <p id={`${id}-err`} role="alert" className="px-3 py-2.5 text-xs text-sell">
                {error}
              </p>
            ) : (
              <ul id={`${id}-list`} role="listbox" aria-label="Matching tokens">
                {matches.map((t, i) => (
                  <li key={t.mint} role="option" aria-selected={i === active}>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => go(t.mint)}
                      className={cn("flex w-full items-center gap-3 px-3 py-2 text-left text-sm", i === active ? "bg-surface-3" : "hover:bg-surface-2")}
                    >
                      <span className="font-medium">${t.symbol}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{t.name}</span>
                      <span className="font-mono text-[11px] text-faint-foreground">{shortAddr(t.mint, 4, 4)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </form>
  );
}
