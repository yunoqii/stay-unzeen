# Demo video script (draft, 2:00)

Recorded on **mainnet** (owner's decision): Zcash mainnet + Solana mainnet, small amounts from the team's own funds. Desktop only. English voice-over. Target length 1:55–2:00 (the form says "Two minutes").

Two cuts:
- **Cut A (public before 28.10):** no fair-launch. Scene 7 uses variant A.
- **Cut B (final, 28.10):** scene 7 uses variant B (fair-launch). Upload Cut B only on 28.10, or keep it unlisted/private until the deadline. TODO(lead): decide which cut goes into the form, and when.

## Before recording (safety and privacy)

- Use a **fresh, one-time anon key** for the recording. The deposit QR contains the memo with the anon pubkey, and the video is public (review-day2 L7). Never show the 12 words on screen: on `/key`, record only the hold-to-reveal animation with blurred words, or skip it.
- No `.env`, terminal history, RPC URLs with API keys, vault key files or the `~/.unzeen` directory on screen.
- Browser: clean profile, no extensions or bookmarks bar, notifications off.
- Pay the deposit **from a shielded balance** (ZODL), never from an exchange or a t-address: the video would teach the wrong habit.
- Before recording: fund the Verify attestation key (from an external source, not from a vault) so the snapshot is signed and anchored; check that `/verify` shows no red rows (review-day8 E1–E3, "demo robustness" package E2/E7/E8/E9/E14/E16).
- Pick a token with some activity so the "unzeen bought" line is not the only trade on the chart.
- Record with execution mode **Now** for the trade scenes (timing), and say on screen that the default is Delayed. Show the Delayed toggle once.
- Explorer: Solscan (mainnet). Opening explorers reveals the recorder's IP to them: use a VPN while recording.
- TODO(lead): mainnet amounts (STATUS: ~0.1–0.2 ZEC, ~0.3 SOL budget). Mainnet payout cap is 0.05 ZEC per payout.

## Script

| Time | On screen | Voice-over |
|---|---|---|
| 0:00–0:08 | Logo + slogan "Launch anywhere. Stay unzeen." over the home page hero, live feed scrolling. | "Every trade on a Solana launchpad shows your wallet. Unzeen fixes that with Zcash." |
| 0:08–0:20 | Home page: live feed lines "unzeen bought …", "unzeen sold …". Cursor hovers one line. | "This is Unzeen. You pay with shielded ZEC, and the pool's vaults trade on pump.fun and Meteora for you. The feed says 'unzeen bought'. It never says who." |
| 0:20–0:32 | `/key`: "Create key", 12-word card with words blurred, then "Key saved in this browser". Header shows **Mainnet**. | "Your account is a 12-word anon key, made and encrypted in your browser. No email, no Solana wallet." |
| 0:32–0:50 | Portfolio → Top up: ZIP-321 QR. Cut to the phone: ZODL scans and sends 0.05 ZEC (shielded). Back on the site: balance goes from 0 to 0.05 ZEC (speed up the wait, caption "3 confirmations, sped up"). | "You top up once. ZODL pays the QR: a shielded transaction with a signed memo. Nobody on the Zcash chain can see who paid, how much, or that it was Unzeen. After three confirmations, it's your balance." |
| 0:50–1:05 | Token page: chart, safety panel (authorities revoked, top-10). Buy 0.01 ZEC preset, mode toggle visible (show Delayed, then switch to Now). Toast "Executed". The trade appears in the token's feed as "unzeen bought …". | "Now trade from the balance. Buying takes no Zcash transaction at all: it's a request signed by your key. Delayed mode batches everyone's trades in random order. Now executes in seconds and looks identical on chain." |
| 1:05–1:15 | Click the trade → Solscan: signer is a pool vault address. Caption: "signer = pool vault, not the user". | "On Solana, the signer is a shared pool vault. No link to your Zcash payment, your deposit or your key." |
| 1:15–1:30 | **Variant A:** `/launch`: name, symbol, image, initial buy, rules card ("24 h lock, 5 % cap, rules apply to the launching key"). Submit. New token page with badge "Unzeen launch: dev anonymous, rules enforced". | "Launching works the same way. A fresh pool address creates the token, and the pool enforces the creator rules. The dev stays anonymous." |
| 1:15–1:30 | **Variant B (Cut B only, 28.10):** `/launch` → fair launch: bid with a denomination, "sealed until round R" ring, window closes, commitment root with "Anchored on Solana", reveal, one transaction, same price for everyone. | "Or run a sealed-bid fair launch. Bids are time-locked with drand in the browser. The set is committed on Solana before anyone can decrypt it. Then one atomic create-and-buy: same price for everyone, no snipers at the launch price." |
| 1:30–1:42 | Portfolio → Withdraw: tokens to a new address (gas drop and delay shown), ZEC to a shielded address (delay shown). | "Withdraw tokens to a fresh address, or cash out to any shielded Zcash address. Withdrawals are always delayed and batched." |
| 1:42–1:54 | `/verify`: snapshot header with "Operator signature ✓" and "Anchored on Solana", solvency table (tokens proven, ZEC "attested"), "Verify my balance" → Merkle path animation → "committed ≥ your balance". | "And you don't have to trust us blindly. Verify proves your balance is in the pool's liabilities, in your browser, without a viewing key. The ZEC reserve is attested, and we say so." |
| 1:54–2:00 | Slogan + repo URL + "Private Markets · ZECATHON 2026". | "Unzeen. Launch anywhere. Stay unzeen." |

Voice-over word count: ~260 words at ~140 words per minute ≈ 1:50 of speech. TODO(lead): time it on the first take; if it runs long, cut the safety-panel line and the ZEC-withdraw half of 1:30–1:42 first.

## Optional 10-second insert ("what the observer sees")

hackathon-rules.md suggests showing what an observer sees. If time allows, replace 1:05–1:15 with a split screen: left, the Zcash explorer showing the deposit as an opaque shielded transaction; right, Solscan showing the pool vault as signer. VO: "Zcash explorer: an opaque shielded transaction. Solana: a pool vault. Nothing connects them."

## Checks after recording

- Freeze-frame every second where the QR, the anon key, the portfolio or a terminal is visible: no secrets, no reusable key.
- Cut A: no word "drand", "sealed", "timelock", "fair launch" or "commitment" in audio, captions or UI (for example the `/launch` page must not show a fair-launch tab). TODO(lead): confirm the public build hides it (`pnpm build:public`).
- Upload to YouTube or Loom as **unlisted**; check the link in an incognito window.
