# UX states matrix (web/)

Frontend, 2026-10-13. Legend: **H** = was already there, **N** = added now, **P** = partial (see notes), **–** = does not apply.

Shared building blocks (new): `ErrorState` (title by error code, the same English text as everywhere, Retry with a countdown on 429, an action link for `locked` / `unauthorized` / `insufficient_balance`), `StaleNote` ("Updated Xs ago"), `ConnectionBanner` (offline / API down / slow network, one for the whole app, under the network banner), `EmptyState art` (owner illustration `/illustrations/empty.webp`, falls back to the silhouette), auto-lock toast ("Your key locked itself" + Unlock). Connection state comes from the API client itself (`lib/connectivity.ts`): two transport failures or 5xx in a row = down, any answer clears it; a request running > 5 s = slow; `navigator.onLine` = offline.

Columns: **Load** loading / skeleton · **Empty** first visit, no data · **Err** error codes with text and action · **Off** API down / offline · **Stale** socket or poll fell behind · **429** · **Key** no key / locked / auto-locked · **Net** wrong network / pool mismatch · **Flag** feature off · **Flow** signed → queued → sent → done / failed / expired, cancel · **Part** partial data, 202 pending · **Long** long operations · **Ovf** long texts, huge / tiny numbers · **RM** reduced motion · **Slow** slow network.

| Screen / component | Load | Empty | Err | Off | Stale | 429 | Key | Net | Flag | Flow | Part | Long | Ovf | RM | Slow |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Global header / banners | – | – | – | **N** banner | – | – | **N** auto-lock toast | H network banner | – | – | – | – | – | H | **N** banner |
| Home: live feed | H | **N** art | **N** ErrorState + Retry | **N** | **N** "Reconnecting · updated Xs ago" | **N** | – | H refetch on switch | – | – | – | – | H compact numbers | H | **N** |
| Home: hot tokens | H | H | P (empty list) | **N** | – | – | – | H | – | – | – | – | H | H | **N** |
| Home: hero eclipse | – | – | – | – | – | – | – | – | – | – | – | – | – | **N** poster still | **N** poster/video tier |
| `/tokens` (new) | **N** | **N** art (no tokens / no match + Reset) | **N** | **N** | – (auto refresh 20 s) | **N** | – | **N** refetch | **N** Discovery only with flag | – | **N** "—" when a field is missing | – | **N** truncate, compact | H | **N** |
| Token: header, chart, stats | H | – | **N** ErrorState | **N** | – | **N** | – | H | – | – | H 202 "Analyzing" | H | H | H | **N** |
| Token: trades | H | **N** art | **N** + Retry | **N** | **N** | **N** | – | H | H Whales/Dev off without full feed | – | – | – | H | H | **N** |
| Token: safety panel | H | – | H | **N** | – | – | – | H | H fields behind flags | – | H "Not available yet" / pending | – | H | H | **N** |
| Token: trade panel | H | H no balance | H ErrorNote per code | **N** | – | H | H key prompt | H | H createEnabled | H ActionStatus | – | H Max privacy 5–15 min | H | H | **N** |
| Token: orders | H | H | H | **N** | – | H | H | H | H unsupported reason | H open → triggered → filled / cancel | – | H | H | H | **N** |
| Token: chat (new) | **N** skeleton | **N** art | **N** codes incl. `chat_not_eligible` "Hold at least … to post", `chat_text_invalid`, `not_creator`, `chat_muted` | **N** | **N** "Updated Xs ago" | **N** | **N** read-only + Unlock | **N** per-network state | **N** tab hidden without `features.chat` | **N** queued → published, delete / hide queued, slow note | **N** hidden / removed placeholders | **N** batches, slow 2–5 min | **N** `<bdi>`, pre-line, wrap anywhere, 280 chars | H | **N** |
| Position card | H | H | – | – | – | – | H Peek | – | – | – | H expired fills note | – | H | H | – |
| Portfolio: balance, holdings | H | H | P banner | **N** | **N** "Updated Xs ago" next to the error | **N** | H key gate | H | – | H | – | – | H | H | **N** |
| Top up / QR | H | – | H + Try again | **N** | – | – | H | H chain id check | – | H waiting → seen → confirming (K) → credited | – | H K confirmations | H long UA wraps | H | **N** |
| Withdraw | H | – | H | **N** | – | H | H | H | – | H | – | H delays shown | H | H | **N** |
| Creator cabinet | H | **N** art | **N** ErrorState | **N** | – | **N** | H | H | – | H claim | H holders null | – | H | H | **N** |
| Launch | H | – | H + Try again | **N** | – | H | H | H | H createEnabled / fair-launch flag | H | – | – | H name/ticker limits | H | **N** |
| Fair launch | H | H | **N** ErrorState | **N** | – | H | H | H | H compiled out / flag | H sealed → closed → revealing → launched | H "<5" | H window, round, reveal + sealed-mark | H | H | **N** |
| Verify | H | **N** art | H | **N** | – | H | H | H | – | H anchor pending | H attestation pending | H proof check | H | H | **N** |
| Stats | H | **N** art | **N** ErrorState | **N** | H "Updated daily" | **N** | – | H | – | – | H "<5" | – | H | H | **N** |
| Key | H | H | H wrong password | – | – | – | H | H per network | – | – | – | H PBKDF2 progress | H | H | – |
| Docs (new) | – static | – | – | – | – | – | – | – | **N** fair-launch section only with build + flag | – | – | – | **N** tables scroll | H | – |
| 404 | – | H | – | – | – | – | – | – | – | – | – | – | – | H | – |

Notes
- **429**: every screen that maps errors through `errorText` shows "Too many requests. Try again in Ns." when the server sends Retry-After; `ErrorState` disables Retry for those N seconds.
- **Expired session**: the key auto-locks after 30 min (in memory only). Signed polls stop; the toast offers Unlock; the trade panel and chat fall back to their key prompts.
- **Polling never speeds up** in any error state (privacy rule N-2): Retry buttons fetch once, then the fixed rhythm continues.
- **Dev chaos**: `NEXT_PUBLIC_MOCK_CHAOS=1` (mock builds only) adds a "Chaos" switch bottom-left: server error (500), rate limited (429, Retry-After 12), offline, slow network (+6.5 s), session expired (locks the key, signed calls 401). Compiled out otherwise; `pnpm build:public` fails if the marker `uz-chaos` is in any chunk.
