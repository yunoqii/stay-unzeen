# Submission form: Description (draft)

Form field: Description, max 2000 characters. Placeholder: "What it does, why it does not leak, what is real and what is a mock. Judges read this first."

- **Version A**: without fair-launch. Use for any draft saved before 28.10.
- **Version B**: with fair-launch. Paste on 28.10, together with opening the repo.

Character counts (Unicode code points, measured with `python3 len()` on the text between the `---8<---` lines, trailing newline excluded): see the line under each version. The form limit may count differently (bytes vs characters). Both versions have a margin and are ASCII-only, so bytes = characters.

TODO(lead): fill in `<DEMO_URL>` (the URL adds length; the counts below already include the placeholder text `<DEMO_URL>`, 10 chars). Re-count after replacing.

## Version A (no fair-launch)

---8<---
WHAT IT DOES
Unzeen is a privacy layer for Solana launchpads paid with shielded ZEC. Top up once from any Zcash wallet (ZIP-321 QR, signed memo). Then buy, sell and launch on pump.fun and Meteora DBC (and anything Jupiter routes on mainnet) from your balance with requests signed by a browser-only anon key. Shared pool vaults execute the trades: the feed says "unzeen bought 1.2M $PEPE", never who. Also: shielded ZEC payouts, token withdrawals to fresh addresses, private limit/TP/SL kept off-chain, anonymous launches with enforced creator rules, Verify.

WHY IT DOES NOT LEAK
- On chain, every trade is signed by a public pool vault; nothing links it to a Zcash tx, deposit or anon key. Launches use a fresh creator per token.
- Deposit time is decoupled from trades: one shielded top-up, then actions with no Zcash tx.
- Delayed mode (default) batches actions every 30-60 s in random order. Now (1-3 s) has the same on-chain fee profile.
- Withdrawals always use delays and a gas drop; payouts are shielded with OVK discarded.
- No logs with IPs, padded requests, all RPC/Jupiter calls server-side, read and send providers split, token lookups batched with decoys, amounts wiped after 24 h, data on an encrypted volume.
- The viewing key is never published. Verify: Merkle-sum proof of liabilities checked in your browser, signed vaults, roots anchored on Solana.
Honest limits (README): the operator is trusted (custody, ledger); ZEC reserve is attested, not proven; network observers can time Now trades; small anonymity set while users are few.

WHAT IS REAL / MOCK
Real: Zcash testnet + Solana devnet (Devnet switch, pre-funded demo keys for judges) and Zcash + Solana mainnet; pump.fun, Meteora DBC, Jupiter (mainnet), 1Click rate, Verify. Mock/limits: fixed ZEC/SOL rate on devnet, manual pool SOL rebalancing, attested ZEC reserve, chat and whale/dev filters not built.
Demo: <DEMO_URL>
---8<---

Count: **1898** characters (ASCII). Room for a demo URL up to ~110 characters.

## Version B (with fair-launch)

---8<---
WHAT IT DOES
Unzeen is a privacy layer for Solana launchpads paid with shielded ZEC. Top up once from any Zcash wallet (ZIP-321 QR, signed memo). Then buy, sell and launch on pump.fun and Meteora DBC (and anything Jupiter routes on mainnet) from your balance with requests signed by a browser-only anon key. Pool vaults execute the trades: the feed says "unzeen bought 1.2M $PEPE", never who. Sealed-bid fair launch: bids are drand-timelocked in the browser, a commitment root is anchored on Solana before anyone can decrypt, then one atomic create+buy gives everyone the same price; no sniping at launch price. Also: shielded payouts, private limit/TP/SL kept off-chain, Verify.

WHY IT DOES NOT LEAK
- On chain, every trade is signed by a public pool vault; nothing links it to a Zcash tx, deposit or anon key. Fresh creator per launch.
- Deposit time is decoupled from trades: one shielded top-up, then actions with no Zcash tx.
- Delayed mode (default) batches every 30-60 s in random order. Now (1-3 s) has the same on-chain fee profile.
- Withdrawals always delayed with a gas drop; payouts shielded, OVK discarded.
- No IP logs, padded requests, all RPC/Jupiter calls server-side, read/send providers split, lookups batched with decoys, amounts wiped after 24 h, encrypted volume.
- Viewing key never published. Verify: Merkle-sum proof of liabilities checked in-browser, signed vaults, roots anchored on Solana.
Honest limits (README): operator is trusted (custody, ledger, sees bid denominations); ZEC reserve attested, not proven; network observers can time Now trades; small anonymity set.

WHAT IS REAL / MOCK
Real: Zcash testnet + Solana devnet (Devnet switch, pre-funded demo keys for judges) and Zcash + Solana mainnet; pump.fun, Meteora DBC, Jupiter (mainnet), drand, 1Click rate, Verify. Mock/limits: fixed ZEC/SOL rate on devnet, manual SOL rebalancing, attested ZEC reserve, chat and whale/dev filters not built.
Demo: <DEMO_URL>
---8<---

Count: **1948** characters (ASCII). Room for a demo URL up to ~60 characters; if longer, drop "(and anything Jupiter routes on mainnet)" (-41).

## Notes for the lead
- Facts behind every line: README.draft.md (threat model, real vs mock). If any README line changes, change it here too.
- TODO(lead): "Zcash + Solana mainnet" is listed as real. Keep it only if the mainnet run is done before submission (STATUS: mainnet init/sync not verified live).
- TODO(lead): "manual pool SOL rebalancing": no 1Click rebalancing code in the repo at the time of writing. If an automated version lands, change the line.
- TODO(lead): where judges find the demo keys (a line in the form or only in the app/README).
- After submitting, do not save a draft again ("Saving a draft after submitting takes it back out of submitted").
