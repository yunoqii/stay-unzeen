"use client";

import { useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ImageSquare, X } from "@phosphor-icons/react";
import { Input } from "@/components/ui/input";
import { IMAGE_MAX_BYTES, IMAGE_TYPES, NAME_MAX, normalizeSymbol, SYMBOL_MAX, type MetaErrors, type MetaInput } from "@/lib/launch";
import { cn } from "@/lib/utils";

const EASE = [0.16, 1, 0.3, 1] as const;

/** Read a picked file as a data URL, refusing other types and anything over the body limit. */
function readImage(file: File): Promise<string> {
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) return Promise.reject(new Error("Use a PNG, JPEG or WebP image."));
  // base64 grows ~4/3; refuse early instead of reading a huge file into memory.
  if (file.size > (IMAGE_MAX_BYTES * 3) / 4) return Promise.reject(new Error("Image is over 512 KB. Use a smaller one."));
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result ?? "");
      if (url.length > IMAGE_MAX_BYTES) reject(new Error("Image is over 512 KB. Use a smaller one."));
      else resolve(url);
    };
    r.onerror = () => reject(new Error("Could not read this file."));
    r.readAsDataURL(file);
  });
}

/**
 * Name, ticker and image of a new token. The image never leaves the browser except inside the signed
 * launch request to our backend (which strips metadata and re-encodes it).
 */
export function TokenMetaFields({
  value,
  onChange,
  errors,
  showErrors,
  disabled,
}: {
  value: MetaInput;
  onChange: (v: MetaInput) => void;
  errors: MetaErrors;
  /** Errors appear after the first submit attempt or once a field was touched. */
  showErrors: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const file = useRef<HTMLInputElement>(null);
  const [touched, setTouched] = useState<Partial<Record<keyof MetaInput, boolean>>>({});
  const [imageError, setImageError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const err = (k: keyof MetaInput) => (showErrors || touched[k] ? errors[k] : undefined);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setImageError(null);
    try {
      onChange({ ...value, image: await readImage(f) });
    } catch (e) {
      setImageError(e instanceof Error ? e.message : "Could not read this file.");
    }
  };

  const imgErr = imageError ?? err("image");

  return (
    <div className="grid gap-5 sm:grid-cols-[128px_minmax(0,1fr)]">
      <div>
        <span id={`${id}-img-l`} className="mb-2 block text-xs text-muted-foreground">
          Image <span className="text-faint-foreground">· optional</span>
        </span>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            void pick(e.dataTransfer.files[0]);
          }}
          className={cn(
            "group relative aspect-square w-32 overflow-hidden rounded-2xl border border-dashed transition-colors duration-150",
            drag ? "border-zec/70 bg-zec/[0.06]" : imgErr ? "border-destructive/60" : "border-border-strong hover:border-zec/50",
          )}
        >
          <AnimatePresence initial={false} mode="popLayout">
            {value.image ? (
              <motion.img
                key={value.image.slice(-24)}
                src={value.image}
                alt="Token image preview"
                initial={{ opacity: 0, filter: "blur(12px)", scale: 1.04 }}
                animate={{ opacity: 1, filter: "blur(0px)", scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.35, ease: EASE }}
                className="absolute inset-0 size-full object-cover"
              />
            ) : (
              <motion.span key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 grid place-items-center text-faint-foreground">
                <span className="grid place-items-center gap-1.5 text-center text-[11px]">
                  <ImageSquare size={24} weight="thin" aria-hidden className="transition-colors group-hover:text-zec" />
                  PNG, JPEG, WebP
                  <br />
                  up to 512 KB
                </span>
              </motion.span>
            )}
          </AnimatePresence>
          <button
            type="button"
            disabled={disabled}
            onClick={() => file.current?.click()}
            aria-labelledby={`${id}-img-l`}
            aria-describedby={imgErr ? `${id}-img-e` : undefined}
            className="absolute inset-0 rounded-2xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <span className="sr-only">{value.image ? "Replace image" : "Choose image"}</span>
          </button>
          {value.image && !disabled && (
            <button
              type="button"
              onClick={() => {
                onChange({ ...value, image: null });
                setImageError(null);
                if (file.current) file.current.value = "";
              }}
              aria-label="Remove image"
              className="absolute top-1.5 right-1.5 grid size-7 place-items-center rounded-full bg-background/80 text-muted-foreground backdrop-blur hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <X size={12} weight="bold" aria-hidden />
            </button>
          )}
        </div>
        <input
          ref={file}
          type="file"
          accept={IMAGE_TYPES.join(",")}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => void pick(e.target.files?.[0])}
        />
        {imgErr && (
          <p id={`${id}-img-e`} className="mt-2 w-32 text-[11px] text-sell">
            {imgErr}
          </p>
        )}
      </div>

      <div className="space-y-4">
        <div>
          <div className="mb-2 flex items-baseline justify-between text-xs">
            <label htmlFor={`${id}-name`} className="text-muted-foreground">
              Name
            </label>
            <span className="tabular text-faint-foreground">
              {[...value.name].length}/{NAME_MAX}
            </span>
          </div>
          <Input
            id={`${id}-name`}
            value={value.name}
            disabled={disabled}
            maxLength={NAME_MAX * 2}
            autoComplete="off"
            spellCheck={false}
            placeholder="Never Zeen"
            aria-invalid={!!err("name")}
            aria-describedby={err("name") ? `${id}-name-e` : undefined}
            onBlur={() => setTouched((t) => ({ ...t, name: true }))}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
            className="h-12 rounded-xl text-base"
          />
          {err("name") && (
            <p id={`${id}-name-e`} className="mt-1.5 text-xs text-sell">
              {err("name")}
            </p>
          )}
        </div>
        <div>
          <div className="mb-2 flex items-baseline justify-between text-xs">
            <label htmlFor={`${id}-sym`} className="text-muted-foreground">
              Ticker
            </label>
            <span className="tabular text-faint-foreground">
              {value.symbol.length}/{SYMBOL_MAX}
            </span>
          </div>
          <div className="relative">
            <span aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-mono text-faint-foreground">
              $
            </span>
            <Input
              id={`${id}-sym`}
              value={value.symbol}
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="characters"
              placeholder="ZEEN"
              aria-invalid={!!err("symbol")}
              aria-describedby={`${id}-sym-h`}
              onBlur={() => setTouched((t) => ({ ...t, symbol: true }))}
              onChange={(e) => onChange({ ...value, symbol: normalizeSymbol(e.target.value) })}
              className="h-12 rounded-xl pl-7 font-mono text-base tracking-wide uppercase"
            />
          </div>
          <p id={`${id}-sym-h`} className={cn("mt-1.5 text-xs", err("symbol") ? "text-sell" : "text-faint-foreground")}>
            {err("symbol") ?? "Letters and digits, up to 10."}
          </p>
        </div>
      </div>
    </div>
  );
}
