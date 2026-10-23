# Submission form: Description

Form field "Description", max 2000 characters. ASCII only, so bytes = characters. Paste only the text between the `---8<---` lines.

- Version A: without fair-launch (any draft saved before 28.10).
- Version B: with fair-launch (paste on 28.10, when the repo opens and the feature is on).

Placeholders: `Demo: TODO` (demo URL) and `Devnet demo keys: TODO` (3-5 keys, 12 words each, about 75-80 characters per key). Re-count with `wc -c` after filling them in.

## Version A (no fair-launch)

---8<---
WHAT IT DOES
Private trading for launchpads, paid with shielded ZEC. Top up once from ZODL (ZIP-321 QR, signed memo), then buy, sell and launch on pump.fun, Meteora DBC, Jupiter (Solana) and Pons (Robinhood Chain) from your ZEC balance. Requests are signed by an anon key that never leaves your browser. Pool vaults execute: the feed says "unzeen bought 1.2M $PEPE", never who. Also: shielded payouts, token withdrawals to fresh addresses, off-chain limit/TP/SL, anonymous launches with enforced creator rules, Verify.

WHY IT DOES NOT LEAK
- Every trade is signed by a public pool vault; nothing on chain links it to a deposit or anon key. Fresh creator per launch.
- One shielded top-up, then no Zcash tx per action. The scanner fetches every shielded tx of each block.
- Delayed (default) batches every 30-60 s in random order. Now (1-3 s) looks the same on chain but not on the network: use Tor/VPN or Delayed.
- Withdrawals always delayed, rounded, with a gas drop.
- No IP logs, padded requests, RPC only server-side, lookups batched with decoys, amounts wiped after 24 h, encrypted disk.
- Viewing key never published. Verify: Merkle-sum proof of liabilities checked in-browser, signed vaults, anchored roots.
Limits (README): custodial operator; ZEC reserve attested, not proven; lightwalletd sees payout broadcasts; small anonymity set.

REAL / MOCK
Devnet: real Zcash testnet + Solana devnet, full flow tested live, fixed ZEC/SOL rate. Mainnet: real ZEC, Solana, Robinhood Chain, tiny amounts, unaudited. Mock: in-browser dev API only.
Demo: TODO
Devnet demo keys: TODO
---8<---

Count: **1580** characters with the placeholders. Room left: about 420 characters for the URL and keys (3 keys fit comfortably, 5 keys only with a short URL).

## Version B (with fair-launch)

<!-- FAIR-LAUNCH:BEGIN -->
---8<---
WHAT IT DOES
Private trading for launchpads, paid with shielded ZEC. Top up once from ZODL (ZIP-321 QR, signed memo), then buy, sell and launch on pump.fun, Meteora DBC, Jupiter (Solana) and Pons (Robinhood Chain) from your ZEC balance. Requests are signed by an anon key that never leaves your browser. Pool vaults execute: the feed says "unzeen bought 1.2M $PEPE", never who. Sealed-bid fair launch: bids drand-timelocked in the browser, commitment root anchored on chain, then one atomic create+buy at one price for all. Also: shielded payouts, off-chain limit/TP/SL, Verify.

WHY IT DOES NOT LEAK
- Every trade is signed by a public pool vault; nothing on chain links it to a deposit or anon key. Fresh creator per launch.
- One shielded top-up, then no Zcash tx per action. The scanner fetches every shielded tx of each block.
- Delayed (default) batches every 30-60 s in random order. Now (1-3 s) looks the same on chain but not on the network: use Tor/VPN or Delayed.
- Withdrawals always delayed, rounded, with a gas drop.
- No IP logs, padded requests, RPC only server-side, lookups batched with decoys, amounts wiped after 24 h, encrypted disk.
- Viewing key never published. Verify: Merkle-sum proof of liabilities checked in-browser, signed vaults, anchored roots.
Limits (README): custodial operator, sees bid denominations; ZEC reserve attested, not proven; lightwalletd sees payout broadcasts; small anonymity set.

REAL / MOCK
Devnet: real Zcash testnet + Solana devnet, full flow tested live, fixed ZEC/SOL rate. Mainnet: real ZEC, Solana, Robinhood Chain, tiny amounts, unaudited. Mock: in-browser dev API only.
Demo: TODO
Devnet demo keys: TODO
---8<---

Count: **1664** characters with the placeholders. Room left: about 335 characters (3-4 keys).
<!-- FAIR-LAUNCH:END -->
