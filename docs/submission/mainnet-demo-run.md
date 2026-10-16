# Mainnet-прогон = демо для сабмита (внутренний план)

Дата: 2026-10-16. Автор: analyst. Ничего на mainnet не выполнялось. План сверен с кодом HEAD `9c493c5`, а также с `docs/RUNBOOK.md` §4–5, `docs/analysis/review-hood-final.md`, `docs/submission/{video-script.draft,checklist}.md`, `docs/STATUS.md`, `docs/API.md`, `.env.example`.

**Решения владельца, на которых построен план.** Вариант A: деньги входят только как ZEC. Пул сам ребалансит ZEC→SOL на vault и ZEC→ETH на hood через NEAR 1Click. Ключи аттестаций (Solana `verify`, hood `attest`) получают каплю SOL/ETH из внешнего кошелька владельца, никогда из vault. Fair-launch на mainnet не делаем.

**Курсы** на `GET /api/rates` 16.10 (source near-1click): ZEC $1223.93, SOL $106.06, ETH $2446.36, ZEC/SOL 11.54, ZEC/ETH 0.5003. Перед прогоном пересчитать по `curl -s http://127.0.0.1:8080/api/rates`.

---

## 0. Бюджет

### 0.1 Главное, без чего вариант A не работает: «оборотный ZEC» пула
Перед отправкой лота ребаланс проверяет `spendable ≥ liabilities + lot + fee_margin` (`core/scanner/src/rebalance.rs:642-650`). Liabilities — это сумма `available + held` всех балансов. Если в пул пришёл только депозит пользователя, `spendable == liabilities`, и ребаланс падает с `reserve_short`. Поэтому пулу нужен свой ZEC, не зачисленный никому. Его отправляют **на UA пула без memo** (или с пустым memo): нота становится `frozen` (`core/ledger/src/decide.rs`, `MemoInput::NonText`) и в `balances` не попадает. Это оборотный капитал пула, связи с пользователем нет: перевод shielded.

### 0.2 Таблица (≈USD по курсам выше)
| Шаг | ZEC | SOL / ETH | ≈USD | Вернётся / сгорит |
|---|---|---|---|---|
| **Solana: оборотный ZEC** (без memo → UA пула Solana) | 0.040 | — | 49 | Остаётся в пуле. Можно вернуть после 22.11 командой `send` |
| из них лот ребаланса ZEC→SOL | 0.035 | → ≈0.40 SOL на адрес ребаланса, затем `fund_vaults` ≈0.39 SOL на 2 vault (keep 0.01) | 43 | SOL остаётся на vault. Спред 1Click смотреть в `rebalance quote` (не подтверждено, ориентир ≤1 %) |
| **Solana: депозит пользователя** (ZIP-321 QR с memo) | 0.030 | — | 37 | ≈0.008 ZEC вернётся выводом на шаге S12 |
| траты пользователя на Solana (покупки 0.003+0.003+0.002+0.002+0.002, 2 create по 0.001 + `CREATE_FEE` 0.001, Now-fee, стоимость выводов) | ≈0.022 | vault тратит ≈0.21 SOL, часть возвращается продажами | — | ZEC пользователя переходит пулу, SOL уходит в токены и rent |
| **Сгорит на Solana** | — | rent двух запусков ≈0.06–0.07, комиссии сети и tip ≈0.005, комиссии кривых ≈0.003 → **≈0.08 SOL** | ≈9 | безвозвратно |
| Капля на ключ `verify` (Solana) **из внешнего кошелька** | — | 0.01 SOL | 1 | тратится на якоря memo (≈0.00001 за штуку) |
| **Hood: оборотный ZEC** (без memo → UA **hood-пула**, это другой UA) | 0.065 | — | 80 | остаётся в пуле |
| из них лот ZEC→ETH | 0.060 | → ≈0.030 ETH: keep 0.022 на funder, `fund_vaults` 0.008 на 2 vault | 73 | ETH остаётся у пула (funder, vault, creator → обратно на адрес ребаланса) |
| **Hood: депозит пользователя** | 0.010 | — | 12 | ≈0.004 ZEC вернётся выводом (H8) |
| **Сгорит на hood** | — | `launchFee` 0.0005 ETH, газ (центы), комиссии кривой → **≈0.001 ETH** | ≈3 | безвозвратно |
| Капля на ключ `attest` hood **из внешнего кошелька** | — | 0.001 ETH (порог предупреждения 0.0002) | 2.5 | на якорь Verify v3 |
| Комиссии Zcash (4 отправки из ZODL, tx ребаланса ×2, выплаты ×2) | ≈0.001 | — | 1.2 | сгорит |
| **Риск по токенам** (мемкоины на руках/в пуле ≈0.15 SOL + 0.002 ETH) | — | — | ≈21 | может обнулиться |

**Итог (с фиксом funder'а, см. GAP-7):** владелец отправляет из ZODL **0.145 ZEC ≈ $178** (четыре перевода), из внешнего кошелька **0.01 SOL + 0.001 ETH ≈ $3.5**. Безвозвратно сгорит ≈ $15–20. Ещё до ≈$21 под риском цены мемкоинов. Сразу вернётся ≈0.012 ZEC. Остальное (≈0.04 ZEC, ≈0.2 SOL, ≈0.025 ETH) остаётся рабочим капиталом пула на период судейства и выводится оператором после 23.11.
**Без фикса GAP-7:** funder пополняется до 0.05 ETH, лот hood растёт до 0.13 ZEC. Итог **0.215 ZEC ≈ $263**.

### 0.3 Куда и что переводит владелец (адреса печатают команды, здесь их нет)
| # | Откуда → куда | Сумма | Команда, печатающая адрес |
|---|---|---|---|
| 1 | ZODL → UA пула **Solana-mainnet**, **без memo** | 0.040 ZEC | `set -a; . ~/.unzeen/main.env; set +a; ./core/target/release/unzeen-scanner address` (или `curl -s 127.0.0.1:8081/api/pool`) |
| 2 | ZODL → UA пула Solana-mainnet, **QR с memo** с `/pay` | 0.030 ZEC | экран `/pay` (Mainnet) |
| 3 | ZODL → UA **hood-пула**, без memo | 0.065 ZEC | `set -a; . ~/.unzeen/hood.env; set +a; ./core/target/release/unzeen-scanner address` (свои `UNZEEN_DATA_DIR`/`KEYS_DIR`, см. GAP-9) |
| 4 | ZODL → UA hood-пула, QR с memo | 0.010 ZEC | `/pay` в режиме Robinhood |
| 5 | Внешний SOL-кошелёк → ключ `verify` | 0.01 SOL | `cd adapters && pnpm keys:attest` (строка `verify`; `fair` **не пополнять**, `rebal` пополняет 1Click) |
| 6 | Внешний ETH-кошелёк (сеть 4663) → ключ `attest` hood | 0.001 ETH | `HOOD_NETWORK=mainnet pnpm evm:keys 2` (строка `attest`) |
| 7 | — (адрес ребаланса Solana → в env сканера) | — | `pnpm keys:attest` → `rebal` → `UNZEEN_REBALANCE_SOL_ADDRESS` |
| 8 | — (адрес ребаланса hood → в env hood-сканера) | — | `pnpm evm:keys 2` → `rebalance-0` → `UNZEEN_REBALANCE_ETH_ADDRESS` |
| 9 | — refund t-адрес 1Click | — | **GAP-2**: у пула нет t-адреса. Временно — прозрачный адрес **отдельного операторского** аккаунта ZODL, не личного |

Переводы 1 и 3 (оборотный ZEC) сделать за 1+ час до 2 и 4 и не на камеру.

---

## 1. Пре-флайт

### 1.1 Где запускаем — решить до всего (вопрос Q1)
Рекомендация: **сразу на VPS**. Mainnet-ключи пула, созданные на Mac, потом придётся переносить, а при перегенерации теряется история Verify и SOL на vault. Bags по решению 13.10 регистрируется только на VPS. Метаданным запусков нужен публичный HTTPS (GAP-5). Ещё на VPS Helius/Shyft/1Click/lightwalletd видят IP сервера, а не домашний. Если прогон локальный: **Bags пропускаем**, нужен `PINATA_JWT`, все запросы пула идут через VPN.

### 1.2 Две отдельные БД
- Solana-mainnet: `infra/pg-mainnet.sh up` → `127.0.0.1:55433`. После первого старта сканера или API: `infra/pg-mainnet.sh roles`.
- Hood-mainnet: **GAP-10**, скрипта нет. `POSTGRES_PORT=55434 docker compose -p unzeen-hood -f infra/docker-compose.yml --env-file .env up -d postgres`. Роли — как в RUNBOOK 1.4, но через `-p unzeen-hood`.
- Проверка: `unzeen-scanner serve`/`unzeen-api serve` на чужой БД должны падать с «refusing to start: this database belongs to …». Это и есть проверка, что БД не перепутаны.

### 1.3 Env: два файла вне репо, 0600 — `~/.unzeen/main.env` и `~/.unzeen/hood.env`
В каждом mainnet-терминале выполнять `set -a; . ~/.unzeen/<x>.env; set +a`. Значения не печатать, `env` на экране не открывать.

**main.env (Solana-mainnet), что меняется против devnet:**
| Группа | Переменные |
|---|---|
| Сеть | `UNZEEN_NETWORK=main`, `UNZEEN_SOLANA_CLUSTER=mainnet-beta`, `SOLANA_CLUSTER=mainnet-beta`, `UNZEEN_ALLOW_MAINNET=yes` |
| Гарды | `UNZEEN_ALLOW_MAINNET_SEND=1` (сканер), `UNZEEN_ALLOW_MAINNET_ACTIONS=1` (API), `UNZEEN_ALLOW_MAINNET_REBALANCE=1` (сканер, только на прогон). `UNZEEN_DEV_PRINT` **не задавать** |
| Убрать | `DEVNET_ZEC_SOL_RATE` (с ним API на mainnet не стартует) |
| БД | `DATABASE_URL`, `DATABASE_URL_RELAYER`, `DATABASE_URL_INDEXER` → порт 55433 |
| Ключи | `UNZEEN_SEED_KEY_FILE` (отдельная age-identity для mainnet), `SOLANA_KEYS_AGE_KEY_FILE` (свой mainnet-файл), `UNZEEN_BIRTHDAY` (высота перед init) |
| Zcash | `LIGHTWALLETD_URL` (zec.rocks по умолчанию), `LIGHTWALLETD_SEND_URL` (другой оператор, RUNBOOK 1.4a), `UNZEEN_MAX_PAYOUT_ZAT=5000000` |
| RPC | `SOLANA_RPC_URL_MAINNET` (Helius, отправка), `SOLANA_READ_RPC_URL_MAINNET` (Shyft), `SOLANA_INDEX_RPC_URL_MAINNET` (Helius) |
| API | `API_BIND=127.0.0.1:8081`, `API_CORS_ORIGINS` (origin веба), `UNZEEN_VENUES=pumpfun,jupiter,raydium-launchlab` (+`bags` только на VPS, +`meteora-dbc` только после GAP-3), `UNZEEN_CREATE_ENABLED=1`, `UNZEEN_FAIR_LAUNCH=0`, `ONECLICK_URL`/`ONECLICK_JWT` |
| Метаданные | `PINATA_JWT` **или** `UNZEEN_METADATA_BASE_URL=https://<публичный домен API>/media` (GAP-5) |
| Ребаланс | `UNZEEN_REBALANCE_SOL_ADDRESS`, `UNZEEN_REBALANCE_REFUND_TADDR`, `UNZEEN_REBALANCE_LOT_ZAT=3500000`, `UNZEEN_REBALANCE_MAX_LOT_ZAT=5000000`, `UNZEEN_REBALANCE_MIN_FREE_LAMPORTS=50000000` (чтобы автотриггер не срабатывал сам), `UNZEEN_REBALANCE_MAX_PER_DAY=1`, `UNZEEN_REBALANCE_FUND_DELAY_MIN_SECS=60`/`_MAX_SECS=180` (задержка уровня пула, не пользователя) |
| Комиссии создателя | `FEE_SWEEP_STORE=postgres`, `MIN_CLAIM_ZAT=1000` (на прогон: иначе claim недостижим при нашем объёме), `UNZEEN_CREATOR_LOCK_SECS` **не трогать** (24 ч — это правило из видео) |
| Сценарии/чат | `UNZEEN_SCENARIOS=1` + `UNZEEN_SCENARIO_KEY_FILE=~/.unzeen/main/scenario.key`. Чат по желанию: `UNZEEN_CHAT=1` + `UNZEEN_CHAT_KEY_FILE=~/.unzeen/main/chat.key`. Два **разных** 32-байтных ключа (RUNBOOK 0.3) |
| Verify | `UNZEEN_VERIFY_DAILY=1` |
| Jupiter | `JUPITER_API_KEY` (необязателен) |
| Не трогать на mainnet | `UNZEEN_CONFIRMATIONS_JITTER` (это защита по таймингу), `RELAYER_NEW_MINT_RESERVE_LAMPORTS` (по умолчанию 0.1 SOL), `RELAYER_STATE` (один режим у всех скриптов) |

**hood.env (поверх main.env-подобного набора):** `UNZEEN_CHAIN=hood`, `UNZEEN_NETWORK=main`, `UNZEEN_VENUES=pons`, `UNZEEN_DATA_DIR`/`UNZEEN_KEYS_DIR=~/.unzeen/hood-main/{data,keys}` (**обязательно**, GAP-9), свой `UNZEEN_SEED_KEY_FILE`, `DATABASE_URL*` → 55434, `API_BIND=127.0.0.1:8082`, `UNZEEN_REBALANCE_ETH_ADDRESS`, `UNZEEN_REBALANCE_REFUND_TADDR`, `UNZEEN_REBALANCE_LOT_ZAT=6000000`, `UNZEEN_REBALANCE_KEEP_LAMPORTS=22000000000000000` (wei, 0.022 ETH остаётся на адресе ребаланса под funder), `UNZEEN_REBALANCE_MIN_FREE_LAMPORTS=1000000000000000` (review-hood п.13), `UNZEEN_ALLOW_MAINNET_REBALANCE=1`, `UNZEEN_ALLOW_MAINNET_SEND=1`, `UNZEEN_ALLOW_MAINNET_ACTIONS=1`. Для adapters: `UNZEEN_HOOD=on`, `HOOD_NETWORK=mainnet`, `UNZEEN_ALLOW_HOOD_MAINNET=yes`, `HOOD_RPC_URL_MAINNET` (платный), `HOOD_SEND_RPC_URL_MAINNET` (другой провайдер), `HOOD_KEYS_AGE_KEY_FILE`, `HOOD_VAULTS=2`, `HOOD_FUNDERS=1`, `HOOD_FEE_SWEEP=1`, `HOOD_MAX_FEE_WEI`, `HOOD_RPC_MAX_RPS`.

**web/.env.local (сборка для съёмки):** `NEXT_PUBLIC_API_MODE=real`, `NEXT_PUBLIC_API_URL_MAINNET`, `NEXT_PUBLIC_WS_URL_MAINNET`, `NEXT_PUBLIC_ATTESTATION_PUBKEY_MAINNET` (= `verify`), `NEXT_PUBLIC_HOOD=1`, `NEXT_PUBLIC_API_URL_HOOD`, `NEXT_PUBLIC_WS_URL_HOOD`, `NEXT_PUBLIC_ATTESTATION_PUBKEY_HOOD` (= hood `attest`), `NEXT_PUBLIC_FAIR_LAUNCH_BUILD` **пустой**. Для сцены fair-launch Cut B — отдельная devnet-сборка (см. §3).

### 1.4 Ключи (делает владелец; на экран выводятся только адреса)
1. `cargo build --release` (core), `pnpm install` (adapters, web).
2. Zcash Solana-пул: `unzeen-scanner seed-keygen --out ~/.unzeen/seed-main.agekey` → `unzeen-scanner init` (main.env) → печатается UA.
3. Zcash hood-пул: то же с hood.env (свой agekey, свой каталог).
4. Solana: `pnpm keys:encrypt` (mainnet age-файл) → `pnpm keys:gen 2` → `pnpm keys:attest`. Права: каталоги 0700, файлы 0600, age-identity лежат вне каталога ключей.
5. Hood: `HOOD_NETWORK=mainnet pnpm evm:keys 2` (сид `evm-seed.txt.age` 0600).
6. Ключи сценариев и чата: `cd ~/.unzeen/main && umask 077 && for f in chat.key scenario.key; do [ -f $f ] || openssl rand -hex 32 > $f; done`.
7. Бэкап age-identity и сидов на офлайн-носитель (без облака).

### 1.5 Площадки
- **pump.fun, Jupiter** — готовы.
- **Raydium LaunchLab** — на mainnet есть только сторонние платформы `bonk`/`stonk` (`adapters/src/launchlab.ts:91-96`). Своя платформа «Unzeen» на mainnet — **GAP-4**: `launchlab:platform` на mainnet только описывает tx. На прогоне запускаем с `platform: "bonk"`. У bonk creator fee 0, так что claim по этому токену не будет.
- **Meteora DBC — GAP-3**: `meteora:config` работает только на devnet (`adapters/scripts/meteora-config.ts:38`), `METEORA_DBC_CONFIG_MAINNET` пуст, нет решения, откуда пополнять partner-ключ на mainnet. Пока GAP не закрыт, Meteora на mainnet не делаем (в `UNZEEN_VENUES` её нет).
- **Bags** — только на VPS: `pnpm bags:auth --register` (владелец) → `BAGS_API_KEY` в `.env` → `pnpm bags:fund --count 1`. Источник SOL для Bags-funder — Q4. **Если прогон локальный, Bags пропускаем.**

### 1.6 Read-only проверки перед первой тратой (может делать агент)
- `unzeen-scanner lwd-info --url <LIGHTWALLETD_SEND_URL>` → `chain: main`.
- `unzeen-scanner rebalance quote` (main.env и hood.env) → котировка есть, `reference` доступен, отклонение < 300 bps. **Стоп**, если котировки hood ETH нет.
- `pnpm keys:attest` → балансы, `verify` ≥ 0.001 после шага 5 из таблицы 0.3.
- Hood: старт `relayer:hood` сам проверяет `verifyDeployment()` (хеши кода Pons) и роль.
- Hood-предусловия review-hood-final п.1, 2, 4, 5 закрыты коммитами `7074a82`, `679cbc4`, `f02a29a`, п.3 — `f2f56fa`/`f6f7676`. **Перед прогоном analyst перепроверяет это короткой сверкой** (Q5).

---

## 2. Шаги прогона

Обозначения: **О** — владелец руками (все mainnet-траты), **А** — агент по команде лида (read-only, браузер, проверки). Explorer: Solscan, Blockscout `robinhoodchain.blockscout.com`, Zcash — любой mainnet-explorer. Explorer'ы открывать только через VPN.

Терминалы Solana-mainnet (все с `main.env`): T1 `unzeen-scanner serve --payouts --rebalance`, T2 `unzeen-api serve`, T3 `pnpm relayer:run`, T4 `pnpm intel:run`, T5 web `pnpm dev --port 3100`. В логах T1–T4 не должно быть адресов, txid и сумм. Если они там есть — **стоп** (аудит логов).

### Solana
| # | Действие (кто) | Ожидание | Проверка | Стоп-условие |
|---|---|---|---|---|
| S0 | Старт T1–T5 (О) | API: `network=main cluster=mainnet-beta`. Релейер: `network=mainnet-beta, running with 2 vault(s)`, `pool_sol_inventory` пишется | `curl -s 127.0.0.1:8081/api/pool` → `chainId "0101"`, `features.fairLaunch` нет | «refusing to start», предупреждение «Solana keys are NOT encrypted», `fair-launch` в `features` |
| S1 | Оборотный ZEC 0.040 без memo (О, ZODL) | Через K=3 + джиттер (≈4–8 мин) — `ledger-stats`: +1 frozen | `unzeen-scanner wallet-balance` → spendable ≥ 0.04 | нота зачислена кому-то (`credited`) |
| S2 | `unzeen-scanner rebalance plan --force --now` (О) | T1: `planned → quoted → sent`, затем 1Click SUCCESS → задание `fund_vaults` | `rebalance status`. Solscan адреса `rebal`: приход SOL, затем одна tx на 2 vault | `reserve_short` (S1 не дошёл), `quote_*`, `recipient_is_vault`, 1Click `REFUNDED` (→ §4.2), > 60 мин без SUCCESS |
| S3 | `pnpm keys:attest`, `/verify` (А) | vault ≈0.19 SOL каждый, `verify` ≈0.01 | Solscan vault | vault < 0.1 SOL: новый mint не закрепится (`RELAYER_NEW_MINT_RESERVE_LAMPORTS`) |
| S4 | `/key` → новый одноразовый anon-ключ (О, **снимаем**) | «Key saved» | — | — |
| S5 | `/pay` 0.030 ZEC → ZODL сканирует QR (О, **снимаем**) | Баланс 0.030 через ≈4–8 мин | `/portfolio` | memo истёк, `frozen: bad_signature` (подпись не под 0101) |
| S6 | Пауза ≥ 10 мин. Создание pump.fun T2 (`/launch`): initial buy минимальный из `launchRules`, ≈0.001 ZEC (О, **снимаем**) | Delayed-эпоха → одна v0-tx create+buy со свежего creator | Solscan: подписанты vault + свежий creator, URI метаданных `https://…`/ipfs | URI `http://127.0.0.1` (GAP-5), `422 creator_cap`, `failed` |
| S7 | T1 = активный чужой pump.fun-токен (поиск по CA): Buy 0.003 ZEC, **Delayed**, затем Buy 0.003 Now (О, **снимаем**) | `queued → sent → executed`. В ленте «unzeen bought …» | Solscan: signer = vault | `pool_liquidity`, `minOut=0` → 400 |
| S8 | Delayed Buy 0.003 ZEC по T2 (объём для creator fee) (О) | executed | лента T2 | — |
| S9 | Sell 50 % T1, Delayed (О, **снимаем**) | ZEC вернулся на баланс | лента sell | `failed (slippage)` дважды подряд |
| S10 | Ордер `limit_buy` 0.002 ZEC по T2, trigger на 5 % выше текущей цены (О, **снимаем панель**) | через 1–3 мин ордер исполнен как обычный buy | ордер пропал из открытых | T4 не пишет тики > 180 с |
| S11 | Jupiter: graduated-токен по CA → дождаться страницы с ценой (202 → 200) → Buy 0.002 ZEC, venue jupiter (О) | executed | Solscan: маршрут Jupiter, signer vault | нет цены/котировки (`minOut` не задать) → пропустить шаг |
| S12a | LaunchLab create, `platform: bonk`, initial buy минимальный (О, B-roll) | одна tx запуска | Solscan: программа LaunchLab, платформа bonk | `venue_unavailable` (pins платформы изменились) → пропустить |
| S12b | (только при закрытом GAP-3) Meteora DBC create | — | — | — |
| S12c | (только на VPS) Bags create | первая покупка отдельной tx (ожидаемо) | — | — |
| S13 | Сценарий: buy 0.002 ZEC T2 → пауза ≈5 мин → sell 100 % этой покупки (О, B-roll) | оба шага executed | `/portfolio` → Scenarios | `bad_venue`, шаг `skipped` |
| S14 | Withdraw T2 (только докупленные, не залоченные токены), **smart, 2 части** на 2 свежих адреса (О, **снимаем**) | задержка 30–300 с на часть. На каждом адресе токены + 0.002 SOL газа, суммы округлены до 3 значащих цифр | Solscan обоих адресов | `423 creator_locked` (задели initial buy), `400` (пыль) |
| S15 | Withdraw ZEC: остаток минус 0.0001 → свежий UA ZODL (О, **снимаем**) | задержка 60–600 с + K. T1: `payouts sent=1`, затем `confirmed=1` | ZODL видит приход | `ALERT payouts above UNZEEN_MAX_PAYOUT_ZAT` → `payout approve <id>` |
| S16 | `FEE_SWEEP_STORE=postgres pnpm fees:sweep --dry-run`, затем `--min-lamports 50000` (О) | `collected pumpfun/… N lamports` | `/creator` → `claimable` > 0 на ближайшей эпохе | claimable < `MIN_CLAIM_ZAT` → нужен ещё объём по T2 |
| S17 | `/creator` → Claim (О, B-roll) | `claimable` → `zecBalance` мгновенно | — | `422 below_minimum` |
| S18 | `unzeen-api verify-snapshot --allow-mainnet` (О) | заморозка ≤ 120 с → `operator` → `anchor` | `/verify`: «pinned», «Anchored», нет красных строк; **Check my balance** — зелёный | `reserve_stale`/`assets_timeout`/`busy` (RUNBOOK §3), нет `anchor` → пополнить `verify` |
| S19 | (опционально) `unzeen-api stats-snapshot --include-today --allow-mainnet` (О) | `/stats` | — | — |

Ключ для съёмки один: в S4 создаём, в S15 выводим остаток. После S15 этот ключ больше не используем.

### Robinhood Chain (hood)
Терминалы с `hood.env`: H-T1 scanner `serve --payouts --rebalance`, H-T2 api, H-T3 `pnpm relayer:hood`. Индексатора у hood нет: цены пишет релейер.

| # | Действие | Ожидание | Проверка | Стоп |
|---|---|---|---|---|
| H0 | Старт H-T1..T3 (О) | `hood launches reconciled`, `launch_curves(hood,pons)`, `pool_sol_inventory(hood)` | `curl 127.0.0.1:8082/api/pool` → `chainId "0111"` | `verifyDeployment` упал (хеши Pons), WARN `attest < 0.0002 ETH` после пополнения |
| H1 | Оборотный ZEC 0.065 без memo → UA hood-пула (О) | +1 frozen | `wallet-balance` (hood.env) | — |
| H2 | `rebalance plan --force --now` (hood.env) (О) | 1Click ZEC→ETH на `rebalance-0`, затем `fund_vaults` 0.008 ETH одной tx Multicall3 | Blockscout: доли по 0.001, на `rebalance-0` осталось ≈0.022 | `reserve_short`, `REFUNDED`, Multicall с `allowFailure` |
| H3 | **Перезапуск `relayer:hood`** (топап funder'а запускается при старте и затем раз в 1–3 ч, GAP-8) (О) | `rebalance-0 → funder-0` круглой суммой | Blockscout: tip 0, gasLimit 100000 | funder не пополнен (на rebalance меньше target + газ) |
| H4 | Ключ hood (в Robinhood-режиме это отдельный ключ: другая сеть) + `/pay` 0.010 ZEC (О, **снимаем коротко**) | баланс | — | подпись под 0101 → `frozen: bad_signature` |
| H5 | Create Pons (initial buy ≈0.002 ZEC ≈ 0.001 ETH) (О, **снимаем**) | funder → свежий creator `ceil 0.01`, `launchAndBuy`, токены на vault | Blockscout | `insufficient_sol` (funder пуст), задание висит в `sent` > 10 мин |
| H6 | Buy 0.002 ZEC по Pons-токену (Delayed), затем Sell 50 % (О, **снимаем buy**) | `lamports_in % 1e14 == 0`, `minOut > 0`, лента | Blockscout: signer vault | `stale_price`, двойная tx с одного nonce (→ стоп всего hood) |
| H7 | Withdraw токена (не залоченные) → свежий EOA (О) | капля 0.00005 ETH с того же vault + transfer | Blockscout | контрактный адрес → 400 (ожидаемо) |
| H8 | Withdraw ZEC → ZODL (О) | `confirmed=1` | ZODL | — |
| H9 | Verify v3: `unzeen-api verify-snapshot --allow-mainnet` (hood.env) (О) | EIP-191 оператор, EIP-712 vault, якорь на hood | `/verify` (Robinhood): зелёный, «pinned» | красный оператор → `NEXT_PUBLIC_ATTESTATION_PUBKEY_HOOD` |
| H10 | Аудит логов H-T1..T3 (А) | нет `0x`, хешей, сумм | grep | есть — стоп и фикс |

**После всего:** `UNZEEN_ALLOW_MAINNET_REBALANCE` снять (или `MAX_PER_DAY=0`). Mainnet-инстансы оставить живыми: это демо-URL до 22.11. Остатки пула не выводить.

---

## 3. Видео (Cut B) — что снимать

| Сцена script | Шаг | Что в кадре | Доказательство |
|---|---|---|---|
| 0:00–0:20 лента | после S9/S13 | главная, «unzeen bought/sold …» по T1/T2 | — |
| 0:20–0:32 `/key` | S4 | только hold-to-reveal с размытыми словами | — |
| 0:32–0:50 Top up | S5 | QR (крупно не держать), телефон с ZODL **без баланса и адресов владельца**, ускоренное ожидание | Zcash-explorer: tx непрозрачна (опциональная вставка split-screen) |
| 0:50–1:05 trade | S7 | панель безопасности, переключатель Delayed → Now, тост Executed, строка в ленте | — |
| 1:05–1:15 explorer | S7 | Solscan tx: **Signer/Fee payer = vault**, подпись «signer = pool vault, not the user» | тот же signature, что у строки ленты |
| 1:15–1:30 A/B | S6 (A) / devnet (B) | A: `/launch` → бейдж «dev anonymous, rules enforced». B: fair-launch **записан на devnet**, в шапке видно «Devnet». Говорить «on devnet», чтобы не противоречить «recorded on mainnet» | — |
| 1:30–1:42 withdraw | S14, S15 | smart на 2 адреса (задержка, капля газа), ZEC на shielded | Solscan свежего адреса: пришло с vault |
| 1:42–1:54 Verify | S18 | «Operator signature ✓», «Anchored on Solana», «committed ≥ your balance» | Solscan memo-tx якоря (signer = ключ `verify`) |
| B-roll / README | S10, S11, S12a, S13, S17, H5–H9 | ордер, Jupiter, LaunchLab, сценарий, claim, Robinhood + Verify v3 | Предложение: 5–8 с «Robinhood Chain too» вместо строки про safety panel (решает лид, Q6) |

**Не показывать:**
- сид и 12 слов, пароль, `.env`, `~/.unzeen/*.env`, `printenv`, URL RPC (ключ в query), `ONECLICK_JWT`, `PINATA_JWT`, `BAGS_API_KEY`, `~/.unzeen/*`, терминалы и `psql`;
- **оборотные переводы S1/H1** и вообще всё про ребаланс (1Click deposit address, refund t-адрес, `rebalance status`) — это операционка, к тому же видна сумма лота;
- **внешний кошелёк владельца** и его tx → `verify`/`attest`. На Solscan ключа `verify` история пополнения в один клик: страницу аккаунта ключа не открывать, только tx якоря;
- ключ `fair`, слова drand/sealed/tlock/commitment — в Cut A и во всём, что публикуется до 28.10;
- ZODL: баланс, свои адреса, историю;
- на одном кадре депозит и сразу покупку той же суммы (в S5 0.030, покупки по 0.002–0.003 после паузы).

**UA пула** публичен (`/api/pool`, QR), показывать можно. Memo в QR содержит anon pubkey одноразового ключа — допустимо, раз ключ после съёмки не используется. Адреса vault публичны через Verify, их показ безвреден.

---

## 4. Откат и разбор

### 4.1 `needs_review` (hood: tx легла, результат не разобран)
Признак — в логе API `ALERT: relayer jobs in needs_review`. Пользователь видит `sent`, hold держится, ZEC **не** возвращать. Разбор:
1. Перезапустить `relayer:hood`: он повторно разберёт receipt.
2. Если не помогло — owner-psql hood-БД: `SELECT id, op, status, signature FROM relayer_jobs WHERE status='needs_review'`, tx — в Blockscout.
3. Средства потрачены → `confirmed` с `out_*` из tx. Не потрачены → `failed`. **GAP-11**: операторской команды нет, только ручной SQL по RELAYER.md:171. На время прогона дальнейшие hood-действия остановить.

### 4.2 Refund 1Click на t-адрес
- Признак: `rebalance status` → `refunded`/`attention`. Закрыть: `rebalance close <id> --status refunded`.
- ZEC приходит **прозрачно** на refund-адрес. Сейчас это операторский аккаунт ZODL (GAP-2). Там нажать **Shield** (t→z, сумма видна публично, адресат нет), затем отправить shielded **без memo** на UA пула. Средства снова станут оборотными, повторить S2/H2.
- В ZODL не смешивать этот аккаунт с личными тратами. t-адрес не переиспользовать для второго лота.

### 4.3 Застрявший ETH на creator (hood)
После упавшего или частично прошедшего запуска на creator остаётся до ≈0.0085 ETH пула. Перезапустить `relayer:hood` → строка `launches reconciled … refunded=N`: остаток уходит на `rebalance-0`. Комиссии из escrow, ещё не переведённые на vault, лежат в `fees-owed.json` и доезжают следующим проходом сборщика. В `creator_fee_sweeps` такой остаток попадать не должен (review п.2). Если попал — **стоп** и баг backend.

### 4.4 Прочее
- `pool_liquidity` на Solana: vault пуст → второй лот (`rebalance plan --force --now`, `MAX_PER_DAY` на время поднять до 2).
- Выплата выше капа → `payout list-held` / `payout approve <id>`.
- Аварийная остановка: `UNZEEN_ALLOW_MAINNET_ACTIONS=0` + рестарт API. Балансы пользователей не трогаются, выводы доступны после включения.

---

## 5. Время

| Блок | Мин | Кто |
|---|---|---|
| Сборка, 2 БД, роли, env-файлы | 40–60 | А готовит команды, О запускает |
| Ключи (Zcash ×2, Solana, EVM), бэкап | 20–30 | О |
| Read-only проверки 1.6 | 10 | А |
| Пополнение `verify`/`attest` из внешнего кошелька | 10 | О |
| S1 + K подтверждений | 10 | О |
| S2 ребаланс SOL (1Click + fund delay) | 20–60 (не подтверждено, зависит от 1Click) | О, А следит |
| H1 + H2 ребаланс ETH (параллельно с S2) | 20–60 | О |
| H3 рестарт и топап funder | 5–10 | О |
| S4–S5 ключ и депозит | 10–15 | О (запись) |
| S6 create pump.fun | 5 | О |
| S7–S9 buy/sell | 10–15 | О (запись) |
| S10 ордер | 5–10 | О |
| S11 Jupiter | 5–10 | О |
| S12a LaunchLab | 5 | О |
| S13 сценарий | 10–15 | О |
| S14 smart withdraw | 10 | О (запись) |
| S15 withdraw ZEC | 15–20 | О (запись) |
| S16–S17 sweep/claim | 10 | О |
| S18 Verify | 5–10 | О (запись) |
| H4–H9 hood | 45–60 | О |
| Аудит логов, снятие флагов | 15 | А |
| **Итого** | **≈5–7 ч** | Лучше в два захода: день 1 — пре-флайт, оборотный ZEC, ребалансы (ожидание). День 2 — S4–S18 и hood под запись |

Срок: не позже 24.10 (чек-лист: видео к 27.10, перепрогон devnet до 26.10).

---

## GAP (что сделать до прогона)
| # | Sev | Что | Где | Кому |
|---|---|---|---|---|
| 1 | **critical (процесс)** | Ребаланс требует ZEC пула сверх обязательств. Без оборотного перевода без memo вариант A не стартует (`reserve_short`) | `core/scanner/src/rebalance.rs:642-650` | учтено в плане (S1/H1). Лиду — подтвердить подход. Analyst/backend: проверить, что frozen-депозит без memo не ломает Verify и алерты |
| 2 | high | Нет t-адреса пула для refund 1Click: UA только Orchard/Ironwood (`wallet.rs:104`), нет `address --transparent` и `shield` | `core/scanner` | backend (≈0.5 дня) или временно операторский ZODL (§4.2) |
| 3 | high | Meteora DBC mainnet: config не создан, скрипт только для devnet, нет источника пополнения partner | `adapters/scripts/meteora-config.ts:38`, `.env.example:98` | backend + решение лида; иначе Meteora на mainnet не показываем |
| 4 | medium | LaunchLab «Unzeen» на mainnet не создан (describe-only) | `adapters/scripts/launchlab-platform.ts` | на прогоне — `bonk` |
| 5 | high (локально) | URI метаданных навсегда в цепочке: нужен `PINATA_JWT` или публичный HTTPS | `adapters/src/metadata.ts:203-207` | владелец (Pinata) или VPS |
| 6 | medium | Bags только на VPS | STATUS 13.10 | при локальном прогоне пропуск |
| 7 | medium | Цель funder на hood зашита: 0.05 ETH, low 0.02 (`adapters/src/evm/funders.ts:49-51`), env нет → лот hood ×2 | adapters | backend: `HOOD_FUNDER_TARGET_WEI`/`_LOW_WEI` (≈15 мин) |
| 8 | low | Топап funder только при старте и раз в 1–3 ч | `evm/relayer/runtime.ts:129` | в плане — рестарт (H3) |
| 9 | **high** | Каталог кошелька по умолчанию `~/.unzeen/<net>/` один для Solana-mainnet и hood-mainnet (`core/scanner/src/config.rs:138-148`) → риск открыть чужой wallet.sqlite | core | в плане — явные `UNZEEN_DATA_DIR`/`KEYS_DIR`. Лучше, чтобы backend добавил chain в путь по умолчанию |
| 10 | low | `pg-mainnet.sh` поднимает только одну доп. БД | `infra/` | команда в 1.2 или параметр скрипта |
| 11 | medium | `needs_review` разбирается только ручным SQL | core | operator-команда `jobs resolve` (backend) |
| 12 | medium | RUNBOOK печатает только pubkey адреса вывода → секрет теряется вместе с токенами | RUNBOOK A.6 | на прогоне `solana-keygen new -o ~/.unzeen/demo-withdraw/wN.json` (0600). Hood — новый EOA в кошельке владельца |

## Открытые вопросы лиду
1. **Q1.** Прогон на VPS (рекомендую) или локально? От этого зависят Bags, метаданные и перенос ключей.
2. **Q2.** Подтвердить «оборотный ZEC без memo» как штатный способ капитализации пула и описать его в README (модель доверия: пул держит свой ZEC сверх обязательств).
3. **Q3.** Закрываем GAP-2/3/7 (backend ≈1 день) до прогона или идём с обходами: операторский ZODL, без Meteora, лот hood ×2?
4. **Q4.** Чем пополняются partner-ключ (Meteora) и Bags-funder на mainnet? Правило «внешний кошелёк» сейчас разрешено только для ключей аттестаций.
5. **Q5.** Нужна ли короткая повторная сверка analyst по hood-фиксам (`7074a82`, `679cbc4`, `f02a29a`, `f2f56fa`) перед тратой ETH? Рекомендую: да, ≈30 мин.
6. **Q6.** Вставка Robinhood в 2-минутное видео (5–8 с) — да или только в README?
7. **Q7.** Внешний кошелёк владельца, которым пополняются `verify`/`attest`, публично связывается с оператором пула (не с пользователями). Устраивает ли это, или нужен отдельный свежий кошелёк?
