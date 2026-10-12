// drand quicknet, the only network fair-launch bids are sealed to (docs/API.md v0.6, analysis §1).
// The browser never talks to drand: rounds and times are computed locally from these constants.

import type { FairLaunchParams } from "@/lib/api/types";

export const QUICKNET = {
  chainHash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  publicKey:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  genesis: 1692803367,
  period: 3,
  scheme: "bls-unchained-g1-rfc9380",
} as const satisfies FairLaunchParams["drand"];

type Drand = Pick<FairLaunchParams["drand"], "genesis" | "period">;

/** Round current at `ms` (unix ms): R(t) = floor((t - genesis) / period) + 1. */
export function roundAt(ms: number, d: Drand = QUICKNET): number {
  return Math.floor((ms / 1000 - d.genesis) / d.period) + 1;
}

/** Time of round R, unix ms: t(R) = genesis + (R - 1) * period. */
export function roundTimeMs(round: number, d: Drand = QUICKNET): number {
  return (d.genesis + (round - 1) * d.period) * 1000;
}

/** The pool must announce exactly quicknet; anything else is refused before a single byte is encrypted. */
export function assertQuicknet(d: FairLaunchParams["drand"] | undefined): void {
  if (
    !d ||
    d.chainHash.toLowerCase() !== QUICKNET.chainHash ||
    d.publicKey.toLowerCase() !== QUICKNET.publicKey ||
    d.genesis !== QUICKNET.genesis ||
    d.period !== QUICKNET.period ||
    d.scheme !== QUICKNET.scheme
  )
    throw new Error("drand parameters of the pool do not match quicknet");
}
