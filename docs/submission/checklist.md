# Submission checklist (ZECATHON, deadline 28.10.2026 23:59 UTC)

Owner of each item: L = lead, O = owner (human), B = backend, F = frontend, A = analyst. Source: STATUS.md "План сдачи", hackathon-rules.md, review-*.md, infra/README.md.

Rules recap: one submission, one track (Private Markets); all code written in the window (Sep 28 – Oct 28); libraries fine, products not; repo public by the deadline ("a private repo at the deadline is not judged"); working demo URL **and** 2-minute video are both required; Description ≤ 2000 chars; "Leaks are disqualifying".

## T−7 days (by 21.10)

- [ ] **L/O** Decide: does fair-launch go public on 28.10 at 20:00 UTC (when the repo opens) or only after 23:59 UTC? CLAUDE.md says "do not publish fair-launch details until the deadline", but the repo has to be public before the deadline, and `docs/analysis/fair-launch.md`, `review-fair-launch.md`, `review-day8.md`, the code and the git history already contain them. TODO(lead): accept that opening the repo = publishing (recommended: open at 20:00 UTC as planned, the 4 h gap is acceptable), or open closer to the deadline with less safety margin.
- [ ] **O** VPS for the demo, paid through **22.11** (judging ends Nov 22, winners Nov 23).
- [ ] **B/O** Data on an **encrypted volume** (LUKS/gocryptfs) with manual unlock: `UNZEEN_HOME` (wallet.sqlite, Postgres data, vault/creator keys). The age key of the seed outside the data volume (systemd `LoadCredential` or `/etc/unzeen`). Provider **snapshots and backups OFF**.
- [ ] **B** Server hardening (review-day2 H9, infra/README.md): TLS on the host, `access_log off` (or no `$remote_addr`/`$request_uri`), `error_log warn` without IPs, no Cloudflare proxy / CDN, `X-Forwarded-For` never logged, per-client limits in the proxy (in memory), `NEXT_TELEMETRY_DISABLED=1`, no Vercel/analytics, Docker log rotation, journald rotation, no log backups. One origin per network, API at the root, WS upgrade for `/ws/feed`.
- [ ] **B** Two backends on the VPS: `devnet` (Zcash testnet + Solana devnet) and `mainnet`. Each with its own Postgres DB, relayer role (`infra/relayer-role.sql`), indexer role (`infra/indexer-role.sql`), re-run after the last migration (0014).
- [ ] **B** Vault/creator keys and the pool seed encrypted with age on mainnet (STATUS risks: plaintext keys/seed) and stored on the encrypted volume.
- [ ] **B** `.env` on the server: `UNZEEN_FAIR_LAUNCH=0` until 28.10; `UNZEEN_ALLOW_MAINNET_SEND` / `UNZEEN_ALLOW_MAINNET_ACTIONS` / `UNZEEN_ALLOW_MAINNET=yes` only on the mainnet instance; `UNZEEN_MAX_PAYOUT_ZAT` cap kept; `UNZEEN_VERIFY_DAILY` and `UNZEEN_STATS_DAILY` on; `API_CORS_ORIGINS` = the public web origin; generated `POSTGRES_PASSWORD`.
- [ ] **B** RPC split in `.env`: Shyft for reads (`SOLANA_READ_RPC_URL_*`), Helius for sends/priority fee (`SOLANA_RPC_URL_*`, Sender), Helius for top-10 (`SOLANA_INDEX_RPC_URL_MAINNET`). Shyft never in the send path, Helius never in the read path.
- [ ] **B** pump-sdk 4.0.0 / DBC SDK 1.5.13: re-run devnet e2e 2 days before the deadline (by 26.10) in case of a program upgrade (STATUS risk).
- [ ] **L** Re-read the rules inside the account (hackathon-rules.md: data.js has a "PLACEHOLDER SPLIT" note).

## T−5 days (by 23.10): monitoring and demo keys

- [ ] **B** Monitoring with alerts to the owner (no IPs, no request data in the monitor):
  - uptime of web, `/api/pool` per network, WS feed;
  - **encrypted volume locked after a reboot** → demo down until the owner unlocks (alert immediately);
  - lightwalletd reachability and scanner lag (testnet has no working fallback: `testnet.zec.rocks` only);
  - balances: pool TAZ (testnet), pool ZEC (mainnet), SOL on devnet vaults and mainnet vaults, SOL on the attestation keys (Verify and fair-launch), demo keys;
  - relayer job backlog / failed jobs; daily Verify snapshot produced and anchored; daily stats produced.
- [ ] **O/B** Collect TAZ in advance (faucet ~0.125 TAZ/day) for the pool and the demo keys.
- [ ] **B/F** **3–5 pre-funded demo anon keys on Devnet** for judges (owner's decision). Each with TAZ balance and enough devnet SOL on vaults for buys/withdrawals. TODO(lead): how judges get them (12 words in the form description? in README? a "Use demo key" button?). They are throwaway keys on testnet funds, so publishing them is acceptable, but: a judge using a shared demo key sees the other judges' trades on it. Mention it.
- [ ] **B** Fund the **Verify attestation key** from an external source, **not from a vault** (STATUS risk: attestation keys empty on devnet → anchors not written). Same for the fair-launch key before 28.10.
- [ ] **F** `PINNED_OPERATOR`: set `NEXT_PUBLIC_ATTESTATION_PUBKEY_DEVNET` and `_MAINNET` in the production web build. Without them `/verify` in real mode shows "unpinned" (`web/lib/verify/pinned.ts`). Pin the **Verify** key (two keys exist: Verify and fair-launch, F14/E19). Publish the same pubkeys in README.
- [ ] **A** Full privacy audit pass on the deployed instances (days 13–14 plan): logs, response sizes, third-party requests from the browser (DevTools → Network on every page: only our origin), CSP.

## T−3 days (by 25.10): code and repo

- [ ] **L** `LICENSE` (MIT) at the repo root. Not present now; Cargo workspace already says `license = "MIT"`. Add `"license": "MIT"` to `adapters/package.json` and `web/package.json` too (optional).
- [ ] **L** README.md from `docs/submission/README.draft.md`, English only, all `TODO(lead):` resolved, fair-launch blocks **removed** until 28.10 (markers `<!-- FAIR-LAUNCH: publish on 28.10 -->`).
- [ ] **L** All user-facing text in English (UI, README, video, description). Internal docs in `docs/` are Russian. TODO(lead): leave them (they show the process) or move `docs/sessions/`, `docs/analysis/` out before opening? They also contain fair-launch details (see the first item).
- [ ] **A/L** **Secrets scan of the full history**, all branches, before the repo opens:
  - `gitleaks detect --log-opts="--all"` (whole history), plus `gitleaks detect --no-git` on the working tree;
  - grep the history for mnemonics, `uview`/`uivk`/`zxview` (viewing keys), `secret-extended-key`, JWTs (`eyJ`), `api_key=`, `api-key=`, `AGE-SECRET-KEY-`, base58 64-byte Solana secret keys / JSON key arrays: `git log -p --all | grep -E -i "AGE-SECRET-KEY|eyJ[a-zA-Z0-9_-]{10,}|api[_-]key=|uview|uivk|mnemonic|\[[0-9]{1,3}(,[0-9]{1,3}){63}\]"`;
  - check that `.env`, `keys/`, `*.sqlite`, `design-refs/`, recordings stay ignored (`.gitignore`) and were never committed (`git log --all --diff-filter=A --name-only | grep -E "\.env$|\.sqlite|/keys/|design-refs"`);
  - if anything is found: **rotate the secret first**, then rewrite history (filter-repo) and force-push before opening.
- [ ] **L** Screenshots and docs for personal data: `docs/screenshots/`, `docs/sessions/`, design files. TODO(lead): check for e-mails, real addresses, the owner's shielded address, the 12 words of any real key (`docs/screenshots/2026-10-12/03-key.png` is tracked: check it shows no real words).
- [ ] **L** `design-refs/` (third-party design references) is ignored: make sure no third-party assets are in tracked files (license).
- [ ] **B/F** All tests green: `cargo test` (core, with Postgres), `pnpm test` + `pnpm typecheck` (adapters), `pnpm test` + `pnpm lint` (web). Record the numbers for README if wanted.
- [ ] **A** Final review: no open critical/high in review-day8 (E1–E4 fixed and verified), STATUS risks either closed or written into README.

## T−1 day (by 27.10): build and video

- [ ] **F** Public web build with **`pnpm build:public`** (= `test:bundle:strict`: fails if fair-launch code is in the bundle), `NEXT_PUBLIC_FAIR_LAUNCH_BUILD` empty, `NEXT_PUBLIC_MOCK_FAIR_LAUNCH` empty, `NEXT_PUBLIC_API_MODE=real`, API/WS URLs per network, pinned attestation keys. Server: `UNZEEN_FAIR_LAUNCH=0`.
- [ ] **L** Check the deployed site in an incognito window: no "fair", "sealed", "tlock", "drand" in pages or JS chunks (`curl` the chunks and grep); `/api/launches` behaves like a server without the feature (review-fair-launch F1).
- [ ] **L** End-to-end run on both networks: top up → buy → feed → sell → withdraw tokens → withdraw ZEC → Verify (no red rows) → stats.
- [ ] **O/L** Video recorded per `video-script.draft.md` (mainnet), Cut A. Uploaded unlisted, link checked in incognito. ≤ 2:00.
- [ ] **L** Description (`description.draft.md`) Version A pasted into the form draft with the demo URL, count re-checked ≤ 2000.
- [ ] **O** Submission account ready; shielded ZODL address for the prize (prizes are paid in ZEC to the address given at submission).

## 28.10 (deadline 23:59 UTC)

- [ ] **by 18:00 UTC, B/F** Turn fair-launch on: server `UNZEEN_FAIR_LAUNCH=1` (only if the F-items for enabling are done: F2, F5, F6/F7, F15, F8/F10 per review-fair-launch.md); web rebuilt with `NEXT_PUBLIC_FAIR_LAUNCH_BUILD=1`; `/launch` fair-launch works on Devnet. Smoke test one fair launch on devnet.
- [ ] **by 19:00 UTC, L** README: restore the fair-launch blocks, remove the markers. Description Version B. Cut B of the video if made.
- [ ] **by 20:00 UTC, L/O** **Make the repo public** (github.com/yunoqii/stay-unzeen). Check in an incognito window: repo, README, LICENSE visible; the commit history visible.
- [ ] **L** Fill the form: project name (≤ 64), track **Private Markets**, Description (≤ 2000), repo URL, demo URL, video URL, checkbox "The repository will be public by the deadline". **SUBMIT.**
- [ ] **L** After submitting: **do not save a draft again** ("Saving a draft after submitting takes it back out of submitted until you SUBMIT again"). If an edit is needed, edit and SUBMIT again before 23:59 UTC.
- [ ] **L** Screenshot of the submitted state.

## 29.10 – 22.11 (judging)

- [ ] **O/B** Demo alive the whole period: monitoring alerts handled, volume unlocked after any reboot, balances topped up (TAZ, devnet SOL, demo keys, attestation keys).
- [ ] **B** Daily Verify snapshots and anchors keep coming (judges may check history).
- [ ] **L** No pushes that break the demo; if fixes are needed, keep them small and documented (the window rule is about the build period; TODO(lead): confirm whether post-deadline commits are acceptable or should wait until after Nov 23).
