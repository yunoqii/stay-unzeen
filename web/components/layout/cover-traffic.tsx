"use client";

import { useEffect } from "react";
import { randomBytes } from "@noble/hashes/utils.js";
import { api } from "@/lib/api/client";
import { getSigner } from "@/lib/crypto/session";
import { signerFromSecret, type Signer } from "@/lib/crypto/sign";
import { coverEnabled, nextCoverDelay } from "@/lib/cover";
import { usePool } from "@/hooks/use-pool";

// Without an unlocked key the noop is signed by a throwaway key that lives in this tab's memory only,
// so visitors who never trade look the same on the wire as those who do.
let throwaway: Signer | null = null;
const coverSigner = (): Signer => getSigner() ?? (throwaway ??= signerFromSecret(randomBytes(32)));

/** R8 cover traffic (lib/cover.ts). Renders nothing. */
export function CoverTraffic() {
  const { pool } = usePool();
  const on = coverEnabled(pool?.features?.noop);

  useEffect(() => {
    if (!on) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (document.visibilityState === "visible") void api.postAction(coverSigner(), { op: "noop" }).catch(() => {});
      timer = setTimeout(tick, nextCoverDelay());
    };
    timer = setTimeout(tick, nextCoverDelay());
    return () => clearTimeout(timer);
  }, [on]);

  return null;
}
