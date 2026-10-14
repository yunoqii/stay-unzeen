// The pool attestation key, pinned in this build (docs/STATUS.md: one key for Verify roots and
// fair-launch memos). The browser compares operator.pubkey of every snapshot with it: a server that
// swaps the key cannot pass the check. Also published in the README.
//
// NEXT_PUBLIC_ATTESTATION_PUBKEY_DEVNET / _MAINNET (base58), _HOOD (0x address, v0.20 Robinhood Chain: the
// operator signs with EIP-191). In mock mode with no value the mock operator key is pinned, so the whole check
// runs end to end.

import type { Network } from "@/lib/network";

/** Public key of the in-browser mock operator: ed25519 seed = sha256("unzeen/mock/attestation-key"). TEST ONLY. */
export const MOCK_OPERATOR_PUBKEY = "FAnkQ1LzsJoRrGqQmdLD1w7QrMfy3DsGrYByHaeTzQ2E";

// NEXT_PUBLIC_* must be referenced literally so Next can inline them.
const PINNED: Record<Network, string> = {
  devnet: (process.env.NEXT_PUBLIC_ATTESTATION_PUBKEY_DEVNET ?? "").trim(),
  mainnet: (process.env.NEXT_PUBLIC_ATTESTATION_PUBKEY_MAINNET ?? "").trim(),
  hood: process.env.NEXT_PUBLIC_HOOD === "1" ? (process.env.NEXT_PUBLIC_ATTESTATION_PUBKEY_HOOD ?? "").trim() : "",
};

/**
 * TEST ONLY: attestation address of the recorded hood snapshot the mock serves (lib/verify/testdata/
 * hood-snapshot.json, from the adapters hood end-to-end run).
 */
const MOCK_HOOD_OPERATOR = process.env.NEXT_PUBLIC_HOOD === "1" ? "0x7c4DFd22C39cd4CaeBC4A8b0297075f519524330" : "";

/** Pinned operator key of a network, or null when this build has none. */
export function pinnedOperator(n: Network): string | null {
  if (PINNED[n]) return PINNED[n];
  if (process.env.NEXT_PUBLIC_API_MODE === "real") return null;
  return n === "hood" && MOCK_HOOD_OPERATOR ? MOCK_HOOD_OPERATOR : MOCK_OPERATOR_PUBKEY;
}
