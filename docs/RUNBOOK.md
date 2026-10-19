# Unzeen — ранбук сквозного прогона (внутренний)

Для человека, который поднимает стенд впервые. Сверено с кодом 13.10.2026, обновлено после коммита core 8fa54c0 (`core/scanner/src/main.rs`, `core/api/src/{main,config,lib}.rs`, `adapters/scripts/*.ts`, `adapters/src/{config,env,relayer/runtime}.ts`, `web/{next.config.ts,lib/network.ts,lib/media.ts}`, `infra/*`). Где для прогона чего-то не хватает в коде, стоит пометка **GAP:**.

Правило для всего документа: значения секретов (пароли, RPC-URL с ключами, сиды, anon-ключи) в терминал не печатать, на экран не выводить, в чат не вставлять.

---

## 0. Предусловия

### 0.1 Инструменты
- Docker (compose v2), Rust stable (`cargo`), Node ≥ 20, `pnpm` 10.
- Опционально: `solana` CLI (только чтобы сгенерировать адрес и посмотреть балансы; без него есть замены ниже), `zingo-cli` ветки `dev` (testnet), если не платить с dev-кошелька.
- Занятые порты на этой машине (чужие контейнеры): 3000, 5173, 5433, 5442, 54329, 6379. Наши: Postgres **55432**, API **8080** (mainnet — **8081**), web **3100**, media:serve **8787** (не нужен, см. 1.9).

### 0.2 Где лежат ключи и состояние (вне репо)
| Путь | Что | Кто читает |
|---|---|---|
| `~/.unzeen/seed.agekey` | age-ключ к сиду Zcash-кошелька пула (`UNZEEN_SEED_KEY_FILE`) | scanner |
| `~/.unzeen/test/{data,keys}` | кошелёк пула **testnet**: `data/wallet.sqlite`, `data/network`, `keys/pool.mnemonic.age` | scanner |
| `~/.unzeen/dev-user/{data,keys}` | отдельный testnet-кошелёк «пользователя» для оплаты Top up из CLI | scanner с `UNZEEN_DATA_DIR`/`UNZEEN_KEYS_DIR` |
| `~/.unzeen/solana-devnet.agekey` | age-ключ к Solana-ключам devnet (`SOLANA_KEYS_AGE_KEY_FILE`) | relayer, fees, keys:* |
| `~/.unzeen/devnet/solana/` | `vault-{0,1,2}.json.age`, `creator-master.hex.age` (из него выводятся creator-, partner- и **оба ключа аттестаций**), `creator-pubkeys.json`, `creator-counter.json`, `alt-*.json`, `mint-vaults.json`, `fee-sweeps.json` (файловый режим) | relayer; indexer читает только `creator-pubkeys.json` |
| `~/.unzeen/devnet/media/` | картинки и JSON-метаданные токенов (`<sha40>.<ext>`) | relayer пишет, API отдаёт `/media/*` |
| `~/.unzeen/main/…`, `~/.unzeen/mainnet-beta/…` | то же для mainnet (создаются при первом `init` / `keys:gen` с mainnet-окружением) | — |
| `~/.unzeen/hood-main/{data,keys}`, `~/.unzeen/hood-test/…` | кошелёк Zcash **hood-пула** (`UNZEEN_CHAIN=hood`): каталог по умолчанию свой, не общий с Solana-пулом (GAP-9) | scanner hood |
| `data/chain`, `data/serve.lock` | метка инстанса (`solana`/`hood`) и замок `serve`. Кошелёк с чужой меткой не открывается; второй `serve` на том же кошельке не стартует. Testnet-кошельки без метки принимаются и помечаются при первом открытии, mainnet без метки — отказ. Для dev-user, который платит в оба пула: `echo any > ~/.unzeen/dev-user/data/chain` (только testnet) | scanner |

dev-user, скорее всего, зашифрован тем же `~/.unzeen/seed.agekey` (создан в ту же минуту, что и `test`). Если `send` с dev-user не расшифрует сид — см. открытые вопросы.

### 0.3 Что должно быть в корневом `.env` (только имена)
Все Rust-бинарники грузят `.env` из текущего каталога или родителей (dotenvy), скрипты `adapters/` — `<repo>/.env` и `adapters/.env`. **Реальное окружение всегда важнее файла** — этим пользуемся для mainnet (раздел 4).

Уже есть в текущем `.env`: `UNZEEN_NETWORK`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`, `DATABASE_URL`, `UNZEEN_SEED_KEY_FILE`, `UNZEEN_SOLANA_CLUSTER`, `UNZEEN_CONFIRMATIONS`, `MIN_DEPOSIT_ZAT`, `MIN_ACTION_ZAT`, `SOLANA_RPC_URL_DEVNET`, `SOLANA_RPC_URL_MAINNET`, `DATABASE_URL_RELAYER`, `SOLANA_KEYS_AGE_KEY_FILE`, `SHYFT_API_KEY`, `SOLANA_READ_RPC_URL_MAINNET`, `SOLANA_READ_RPC_URL_DEVNET`, `DATABASE_URL_INDEXER`, `SOLANA_INDEX_RPC_URL_MAINNET`, `SOLANA_INDEX_RPC_URL_DEVNET`.

**Нужно добавить для devnet-прогона** (не секреты, значения можно писать в файл):
| Имя | Значение для прогона | Без него |
|---|---|---|
| `API_CORS_ORIGINS` | `http://localhost:3100,http://127.0.0.1:3100` | CORS-слоя нет → preflight `OPTIONS` = **405**, браузер не делает ни одного подписанного запроса |
| `UNZEEN_VENUES` | `pumpfun,meteora-dbc` | по умолчанию в коде только `pumpfun` → Meteora `503 venue_unavailable` |
| `UNZEEN_CREATE_ENABLED` | `1` | `create` и `fl_create` → `503` |
| `UNZEEN_FAIR_LAUNCH` | `1` **только локально** | `/api/launches*` → 404, `fl_*` → 400 |
| `DEVNET_ZEC_SOL_RATE` | `11.5` (см. 0.4 про экономию SOL) | на devnet идёт живая котировка 1Click; при её сбое все действия `503` |
| `UNZEEN_METADATA_BASE_URL` | `http://127.0.0.1:8080/media` — ровно origin API + `/media` | relayer: «no metadata store», все `create` падают |
| `FEE_SWEEP_STORE` | `postgres` | сборы пишутся в `fee-sweeps.json`, core их не видит → создатель никогда не получит `claimable` |
| `UNZEEN_CREATOR_LOCK_SECS` | `300` на время прогона (по умолчанию 86400) | продажа токенов первой покупки создателя → `423 creator_locked` сутки. **Фактический конец лока** = начало часа (`now + lockSecs`) + 1 ч, то есть от `lockSecs` до `lockSecs + 1 ч`. С 300 с лок длится от 5 до 65 мин (прогон 15.10: create в 16:23, лок до 17:00) |
| `UNZEEN_CHAT=1` + `UNZEEN_CHAT_KEY_FILE` | `~/.unzeen/devnet/chat.key` | чата нет (`features.chat` отсутствует) |
| `UNZEEN_SCENARIOS=1` + `UNZEEN_SCENARIO_KEY_FILE` | `~/.unzeen/devnet/scenario.key` | сценариев нет; с флагом и без ключа API не стартует |

Ключи чата и сценариев — **два разных** файла по 32 байта hex, режим 0600, вне репо и `.env`. Одинаковый ключ в обоих → API не стартует. Создать один раз (значения не печатаются):
```bash
cd ~/.unzeen/devnet && umask 077 && for f in chat.key scenario.key; do [ -f $f ] || openssl rand -hex 32 > $f; done
```
Созданы 15.10.

Релейер: `RELAYER_NEW_MINT_RESERVE_LAMPORTS` — сколько SOL vault должен иметь **сверх** нужд самой задачи, чтобы на него закрепили новый mint (create, fair_create, первая покупка mint без закрепления, D4). По умолчанию 0.25 SOL на devnet и 0.1 SOL на mainnet, `0` — выключено. Если ни у одного vault столько нет, берётся самый богатый подходящий vault. Причина (прогон 15.10): DBC-токен закрепился за vault-1 с 0.04 SOL, и все покупки по нему падали с `pool_liquidity`.

Полезно на время прогона (необязательно): `UNZEEN_CONFIRMATIONS_JITTER=0` (зачисление ровно через K блоков, testnet ≈ 75 с/блок); `WITHDRAW_TOKEN_DELAY_MIN_SECS=10`, `WITHDRAW_TOKEN_DELAY_MAX_SECS=30`, `ZEC_PAYOUT_DELAY_MIN_SECS=10`, `ZEC_PAYOUT_DELAY_MAX_SECS=30` (диапазон в коде не проверяется). `UNZEEN_CONFIRMATIONS` читают и scanner, и API: значение должно быть одно.

`RELAYER_STATE` не трогать (сейчас `file`): `relayer:run`, `fees:sweep`, `keys:creators-pub` должны работать в одном режиме.

Web: свой файл `web/.env.local` (см. 1.10).

### 0.4 Балансы
| Что | Сколько (devnet-прогон A–G) | Откуда |
|---|---|---|
| TAZ на dev-user (или в zingo) | ≥ 0.1 TAZ (фаусет Valar 0.125/сутки). Ключей для D нужно 2–3, каждому ≥ 0.002 | фаусет Valar → dev-user UA (`unzeen-scanner address` с dev-user каталогами) |
| TAZ в кошельке пула | приходит с депозитами; нужен для Withdraw ZEC | — |
| devnet SOL на vault | суммарно ≥ 1–2 SOL. Покупка 0.01 TAZ при курсе 11.5 = 0.115 SOL; создание токена ~0.03–0.08 SOL сверху; вывод токенов 0.002 SOL на адрес | https://faucet.solana.com на адреса из `pnpm keys:gen 3` |
| Ключ аттестаций **Verify** | ≥ 0.01 SOL | **только внешний источник (фаусет), не с vault** (публичная связь vault → подписант) |
| Ключ аттестаций **fair-launch** | ≥ 0.01 SOL | так же |
| DBC partner | ~0.02 SOL, уже создан 12.10 (`meteora:config` пополнил его с vault — допустимо только на devnet) | — |

Экономия devnet SOL: курс `DEVNET_ZEC_SOL_RATE` можно временно понизить (например `2`): те же TAZ дадут в 5–6 раз меньшие покупки. Цена — неправдоподобные суммы в UI.

Адреса vault и ключей аттестаций (печатаются только публичные ключи):
```bash
cd ~/Desktop/stay-unzeen/adapters
pnpm keys:gen 3            # существующие vault-0..2 не перезаписываются, печатает адреса + ссылки на explorer
pnpm keys:attest           # публичные ключи аттестаций verify / fair + их баланс SOL (секреты не печатаются; GAP закрыт)
```
Ключи аттестаций пополнять только из внешнего кошелька/фаусета, **никогда с vault** (RELAYER v5).
Ключ `verify` = `operator.pubkey` снимков Verify → его же положить в `NEXT_PUBLIC_ATTESTATION_PUBKEY_DEVNET`. Ключ `fair` нигде публично не показывать до 28.10.

---

## 1. Devnet-стенд локально (каждый сервис — свой терминал)

Везде `R=~/Desktop/stay-unzeen`. Все Rust-команды — **из корня репо** (чтобы подхватился `.env`).

### 1.1 Сборка (один раз и после каждого `git pull`)
```bash
cd $R/core && cargo build --release        # unzeen-scanner + unzeen-api; миграции вшиваются при сборке
cd $R/adapters && pnpm install
cd $R/web && pnpm install
```
Release-бинари `unzeen-scanner` и `unzeen-api` пересобраны 13.10 (миграции до 0017, `rebalance`, `wallet-balance`, `--include-today`, `--allow-mainnet`). После любого `git pull` в `core/` — снова `cargo build --release` (миграции вшиваются при сборке).

### 1.2 Терминал 1 — Postgres
```bash
cd $R
docker compose -f infra/docker-compose.yml --env-file .env up -d postgres
docker compose -f infra/docker-compose.yml --env-file .env ps        # healthy, 127.0.0.1:55432
```
Контейнер `unzeen-postgres-1` уже может быть запущен — это нормально.

### 1.3 Миграции
Отдельной команды нет: их применяет первый стартовавший `unzeen-scanner serve` или `unzeen-api serve` (advisory lock, безопасно параллельно). Проверка после старта 1.5/1.6:
```bash
cd $R
docker compose -f infra/docker-compose.yml --env-file .env exec -T postgres \
  psql -U unzeen -d unzeen -c 'SELECT version, name FROM schema_migrations ORDER BY 1'
```
Ожидается 1…33 (на 15.10 последняя — `0033_actions_key_seq`). Руками ничего не накатывать.
**После первого старта новых бинарей (миграции 0015/0017) обязательно перезапустить `infra/relayer-role.sql` (1.4)** — иначе у релейера нет прав на `bundle_legs` и `pool_sol_inventory`.

**Защита от смешения сетей (GAP закрыт):** сканер пишет в `pool_meta` `network`, `solana_cluster`, `pool_ua`. `unzeen-scanner serve`, `unzeen-api serve`, ручные `verify-snapshot`/`stats-snapshot` и `rebalance` **отказываются стартовать** на БД другой сети («refusing to start: this database belongs to …»); сканер — и на БД другого кошелька пула (`UNZEEN_ALLOW_POOL_UA_CHANGE=1` только после осознанного re-init). Для mainnet — отдельная БД (раздел 4.1).

### 1.4 Роли relayer / indexer (после миграций; повторять после каждой новой миграции)
Пароли берутся из `DATABASE_URL_RELAYER` / `DATABASE_URL_INDEXER` в `.env` и не печатаются:
```bash
cd $R
pw() { (cd adapters && node -e 'const {parseEnv}=require("node:util");const e=parseEnv(require("fs").readFileSync("../.env","utf8"));process.stdout.write(decodeURIComponent(new URL(e[process.argv[1]]).password))' "$1"); }
RPW=$(pw DATABASE_URL_RELAYER)
docker compose -f infra/docker-compose.yml --env-file .env exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U unzeen -d unzeen -v pw="'$RPW'" < infra/relayer-role.sql
IPW=$(pw DATABASE_URL_INDEXER)
docker compose -f infra/docker-compose.yml --env-file .env exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U unzeen -d unzeen -v pw="'$IPW'" < infra/indexer-role.sql
unset RPW IPW
```
Пароль задаётся только при **создании** роли; если роль уже есть с другим паролем — `ALTER ROLE unzeen_relayer PASSWORD '…'` вручную.

### 1.4a Выплаты ZEC больше капа и отдельный lightwalletd для отправки (аудит A2/A8)
- **Кап mainnet:** `UNZEEN_MAX_PAYOUT_ZAT` (по умолчанию 100000000 = 1 ZEC). Выплата больше капа не задерживает очередь, в логах сканера `ALERT: payouts above UNZEEN_MAX_PAYOUT_ZAT wait for `payout approve`` (только число). Разбор:
  ```bash
  ./core/target/release/unzeen-scanner payout list-held     # id, сумма, возраст; получателей нет
  ./core/target/release/unzeen-scanner payout approve <id>  # уходит со следующим проходом выплат
  ```
  Нужен `DATABASE_URL` (как у сканера). Отклонить нельзя: при подозрении — не одобрять и разбираться (у пользователя `queued`).
- **`LIGHTWALLETD_SEND_URL`** (mainnet): выплаты и ребаланс вещаются через lightwalletd **другого оператора**, сканирование остаётся на zec.rocks. Тогда zec.rocks не видит, какие tx — пула, и не может связать отправку выплаты с IP кошелька, который её потом скачивает. Проверено 13.10 (`unzeen-scanner lwd-info --url …`, только `GetLightdInfo`): `https://lwdv3.zecwallet.co:443` (Hetzner, ECC LightWalletD v0.5.3) и `https://zcash.mysideoftheweb.com:9067` (домашний оператор, v0.5.4). Оба отдали `chain: main`, ту же высоту и ветку консенсуса `37a5165b`, что zec.rocks (Fly.io). Если сервер отправки недоступен, выплаты ждут: на zec.rocks отправка не переключается.
  ```bash
  UNZEEN_NETWORK=main ./core/target/release/unzeen-scanner lwd-info --url https://lwdv3.zecwallet.co:443
  ```

### 1.5 Терминал 2 — сканер (депозиты + выплаты ZEC)
```bash
cd $R
./core/target/release/unzeen-scanner address            # UA пула testnet (utest1…)
./core/target/release/unzeen-scanner serve --payouts    # или UNZEEN_PAYOUTS=1
```
Баланс кошелька пула (spendable / pending, без адресов, можно и на mainnet): `./core/target/release/unzeen-scanner wallet-balance` (GAP закрыт).

**Авторебаланс ZEC→SOL (NEAR Intents 1Click, RELAYER v7)** — флаг `--rebalance` (или `UNZEEN_REBALANCE=1`). На testnet/devnet всегда **dry-run**: по расписанию журналируется котировка с mainnet-параметрами, ничего не отправляется. Живые отправки — только main + mainnet-beta + `UNZEEN_ALLOW_MAINNET_REBALANCE=1` + `UNZEEN_REBALANCE_SOL_ADDRESS` + `UNZEEN_REBALANCE_REFUND_TADDR` (раздел 4). Триггер требует снимок SOL от релейера (`pool_sol_inventory`, релейер v7); пока его нет — `rebalance check` покажет `no inventory`, SOL на vault пополняем вручную.
```bash
B=./core/target/release/unzeen-scanner
$B rebalance quote        # read-only dry-котировка лота (mainnet-параметры) + сверка с ценой /v0/tokens
$B rebalance check        # инвентарь SOL, свободный SOL, порог, кулдаун, решение триггера
$B rebalance status       # журнал ребалансов (данных пользователей там нет)
$B rebalance plan [--force] [--now]   # оператор: запланировать вручную (исполняет serve --rebalance)
$B rebalance close <id> --status failed|done|refunded   # закрыть запись в attention
```

Ожидается: строки `scan pass` каждые ~20 с (tip, scanned, cover_txs, notes, changes) — без txid и memo. `--payouts` нужен для сценария Withdraw ZEC; без `UNZEEN_SEED_KEY_FILE` упадёт на старте («payouts need the pool seed key»). Сканер же публикует UA пула в `pool_meta` (без этого `GET /api/pool` = 503 «pool address not published yet»).

### 1.6 Терминал 3 — API
```bash
cd $R
API_CORS_ORIGINS=http://localhost:3100,http://127.0.0.1:3100 \
UNZEEN_VENUES=pumpfun,meteora-dbc UNZEEN_CREATE_ENABLED=1 UNZEEN_FAIR_LAUNCH=1 DEVNET_ZEC_SOL_RATE=11.5 \
./core/target/release/unzeen-api serve
```
(Переменные можно держать в `.env`; в командной строке — чтобы явно видеть флаги прогона.)
Ожидается строка `unzeen-api starting network=test cluster=devnet chain_id=0202 rate=fixed epoch_s=30..60 venues=pumpfun,meteora-dbc bind=127.0.0.1:8080`.
```bash
curl -s 127.0.0.1:8080/api/pool | head -c 600; echo     # address, chainId "0202", rate, features.fairLaunch, launchRules
curl -si -X OPTIONS 127.0.0.1:8080/api/portfolio -H 'Origin: http://localhost:3100' \
  -H 'Access-Control-Request-Method: GET' | head -5        # 200 + access-control-allow-origin, НЕ 405
```

### 1.7 Терминал 4 — релейер
```bash
cd $R/adapters
pnpm relayer:run            # DATABASE_URL_RELAYER + SOLANA_KEYS_AGE_KEY_FILE из .env
```
Ожидаемые строки: `[relayer] … network=devnet`, `running with 3 vault(s), fee source rpc, send via …`. Предупреждения, которые нужно разобрать:
- `DATABASE_URL_RELAYER is not set: devnet fallback…` → роль не настроена (1.4);
- `this DB role can read relayer_jobs.action_id` → подключились не той ролью;
- `launch_curves … missing or not writable` → fair-launch недоступен (перезапустить 1.4);
- `Verify attestation key balance < 0.001 SOL` / `fair-launch attestation key …` → пополнить ключ из фаусета (0.4);
- `no metadata store` → нет `UNZEEN_METADATA_BASE_URL`;
- `SOLANA_READ_RPC_URL_DEVNET not set` → снимок Verify читает с основного RPC (не критично).
Для сборщика комиссий внутри релейера: `RELAYER_FEE_SWEEP=1 pnpm relayer:run` (расписание 6–12 ч — для прогона используем разовый `fees:sweep`, 2.F).

### 1.8 Терминал 5 — индексатор (цены для ордеров, safety, холдеры)
```bash
cd $R/adapters
pnpm intel:run              # DATABASE_URL_INDEXER, чтение через SOLANA_READ_RPC_URL_DEVNET (Shyft)
# смоук без БД: pnpm intel:run --once --memory
```
Ожидается `tick #N batch=8 warm=… saved=… errors=0 …ms next=45..75s`. Без него: ордера не срабатывают (цены нет), страница неизвестного mint вечно `202`.

### 1.9 media:serve — не нужен
`pnpm media:serve` отдаёт ту же папку на `127.0.0.1:8787`, но фронт показывает картинки **только** с origin API (`web/lib/media.ts` + CSP `img-src`), поэтому картинки с 8787 превратятся в глиф. API сам отдаёт `/media/<sha40>.<ext>` из `~/.unzeen/devnet/media`. Держим `UNZEEN_METADATA_BASE_URL=http://127.0.0.1:8080/media`. Токены, созданные раньше с базой 8787, будут без картинки — это ожидаемо.

### 1.10 Терминал 6 — web в real-режиме
`web/.env.local`:
```
NEXT_PUBLIC_API_MODE=real
NEXT_PUBLIC_API_URL_DEVNET=http://127.0.0.1:8080
NEXT_PUBLIC_FAIR_LAUNCH_BUILD=1
NEXT_PUBLIC_ATTESTATION_PUBKEY_DEVNET=<pubkey "verify" из 0.4>
```
```bash
cd $R/web && pnpm dev --port 3100
```
Открыть `http://localhost:3100`. Host в `NEXT_PUBLIC_API_URL_DEVNET` и в `UNZEEN_METADATA_BASE_URL` должен совпадать буквально (`127.0.0.1` ≠ `localhost` для CSP и `safeImageSrc`). `NEXT_PUBLIC_*` вшиваются при старте — после правки перезапустить `pnpm dev`. `NEXT_PUBLIC_API_URL_MAINNET` пустой → переключатель Mainnet в шапке будет ходить на сам Next и ломаться: на devnet-прогоне его не трогать.

### 1.11 CLI-инструменты для проверки без браузера
```bash
cd $R
B=./core/target/release/unzeen-scanner
A=./core/target/release/unzeen-api
$B anon-key --out ~/.unzeen/dev-user/cli-anon.key          # печатает anon pubkey
$B memo-deposit --anon-key ~/.unzeen/dev-user/cli-anon.key # подписанный memo unz1 (24 ч → --expiry-mins)
$B balance <anon_pubkey_b58>                               # баланс в реестре (dev only)
$B ledger-stats                                            # депозиты по статусам
$A dev-request --anon-key ~/.unzeen/dev-user/cli-anon.key                    # GET /api/portfolio
$A dev-request --anon-key ~/.unzeen/dev-user/cli-anon.key --method POST --path /api/actions \
  --body '{"op":"buy","venue":"pumpfun","mint":"<mint>","zecIn":"200000","minOut":"1"}'
$B sign-request --anon-key … --method GET --path /api/portfolio   # печатает -H … для curl (тело должно совпадать байт в байт)
```
Очередь релейера (только devnet, владельческая роль):
```bash
docker compose -f infra/docker-compose.yml --env-file .env exec -T postgres psql -U unzeen -d unzeen -c \
 "SELECT id, op, venue, exec_mode, status, attempts, error_code, not_before FROM relayer_jobs ORDER BY id DESC LIMIT 10"
```

---

## 2. Сценарии

Общее: статус любого действия — `queued → sent → executed | failed` в UI (тост / Portfolio), подробности ошибки — `error_code` в `relayer_jobs`. Delayed/Max ждут границу эпохи (30–60 с / 5–15 мин), Now уходит сразу (+ `UNZEEN_NOW_FEE_ZAT` = 5000 зат).

### A. Ядро: ключ → Top up → Buy → лента → Sell → Withdraw
1. **Ключ.** `/key` → создать (BIP-39, пароль, подтверждение слов). Ключ хранится в `localStorage` этого origin и сети.
2. **Top up.** `/pay` → сумма (≥ `minDepositZat`, 0.001 TAZ). На экране QR ZIP-321 и строки Pool address / Amount / **Memo** с кнопками копирования. Memo живёт 24 ч.
   - **Оплата с dev-кошелька** (CLI-`send` на testnet ограничен **0.5 TAZ**, на mainnet — 0.05 ZEC; дефолтные 0.1 из UI проходят):
     ```bash
     cd $R
     export UNZEEN_DATA_DIR=~/.unzeen/dev-user/data UNZEEN_KEYS_DIR=~/.unzeen/dev-user/keys
     ./core/target/release/unzeen-scanner sync            # обязательно перед send (dev only, печатает ноты dev-user)
     ./core/target/release/unzeen-scanner send --to '<UA пула>' --amount-zat 2000000 --memo '<скопированный memo unz1…>'
     unset UNZEEN_DATA_DIR UNZEEN_KEYS_DIR                # ВАЖНО: иначе следующий scanner в этом терминале откроет dev-user
     ```
     Ожидается `sent txid=…`. Прувинг в release — секунды.
   - **Или zingo-cli (testnet, ветка dev)**: отправить на UA пула сумму с текстом memo (синтаксис `send` зависит от версии zingo — не проверено). Либо отсканировать QR кошельком, понимающим ZIP-321 на testnet.
   - Нажать «I've sent it».
3. **Ждать K подтверждений.** K = `UNZEEN_CONFIRMATIONS` (3) + джиттер 0..`UNZEEN_CONFIRMATIONS_JITTER` блоков, testnet ≈ 75 с/блок → 4–8 мин. В логе сканера `changes={"credited":1}`. Баланс в шапке / `/portfolio` растёт. CLI: `unzeen-scanner balance <anon_pubkey>` (pubkey из `memo-deposit`, для веб-ключа — из `/key`).
4. **Buy pump.fun devnet.** Найти токен пула на главной/по CA (`/token/<mint>`) — devnet-токены из прошлых e2e уже есть в ленте; иначе сначала сценарий B. Купить 0.005–0.01 TAZ:
   - **Delayed** — статус `queued` до границы эпохи (≤ 60 с), затем `sent` → `executed` за несколько секунд;
   - **Now** — `sent` за 1–3 с. Предупреждение UI про сетевую слежку должно быть видно.
   Ожидается: событие «unzeen bought …» в ленте (WS `/ws/feed`) и на странице токена, позиция в `/portfolio`, неистраченные лампорты вернулись в ZEC. Проверка в Solana: ссылка на explorer из ленты, подписант — vault (не пользователь).
5. **Sell** части позиции (Delayed). Ожидается `executed`, выручка в ZEC на балансе, событие sell в ленте.
6. **Withdraw токенов** (`/portfolio` → Withdraw → токен) на свежий адрес:
   ```bash
   cd $R/adapters && pnpm exec tsx -e 'console.log(require("@solana/web3.js").Keypair.generate().publicKey.toBase58())'
   # или: solana-keygen new --no-bip39-passphrase --silent -o /tmp/w.json && solana-keygen pubkey /tmp/w.json
   ```
   Задержка `WITHDRAW_TOKEN_DELAY_*` (по умолчанию 30–300 с). Ожидается: на адресе в explorer (`?cluster=devnet`) появились токены и капля SOL (газ); ZEC-комиссия списана. Проверить также `smart` (N адресов, неравные части).
7. **Withdraw ZEC** на UA dev-user:
   ```bash
   UNZEEN_DATA_DIR=~/.unzeen/dev-user/data UNZEEN_KEYS_DIR=~/.unzeen/dev-user/keys ./core/target/release/unzeen-scanner address
   ```
   В UI — сумма + этот UA. Нужен сканер с `--payouts` и TAZ в кошельке пула. Задержка `ZEC_PAYOUT_DELAY_*` (60–600 с), потом K подтверждений; в логе сканера строка `payouts sent=1 …`, затем `confirmed=1`. Статус `executed`. Проверка прихода: `sync` с dev-user каталогами (печатает новую ноту). Комиссия сети — `WITHDRAW_ZEC_FEE_ZAT` (0.00015).

### B. Launch токена (pump.fun и Meteora DBC)
Нужно: `UNZEEN_CREATE_ENABLED=1`, `UNZEEN_METADATA_BASE_URL`, для Meteora — `meteora-dbc` в `UNZEEN_VENUES` (config devnet `5MHT8F…` зашит по умолчанию в `adapters/src/meteora.ts`, `pnpm meteora:config` повторно не нужен).
1. `/launch` → площадка pump.fun → name (1–32), symbol (1–10 A–Z0–9), картинка png/jpeg/webp ≤ 512 КиБ, initial buy.
2. **Кап создателя 5 % саплая.** Релейер читает живой Global pump.fun devnet. На 15.10 там **виртуальные резервы 0.3 SOL** (а не 1 SOL), поэтому кап = 0.014 SOL (pump.fun) / 0.013 SOL (DBC) ≈ **0.0012 TAZ** при курсе 11.5. Больше → `422 creator_cap`.
   - Принимаемый диапазон `initialBuyZec` (API v0.24) — `GET /api/pool` → `launchRules.minInitialBuyZat` … `maxInitialBuyZatByVenue[venue]`, включительно, по текущему курсу. При 11.5 это примерно 0.0000874 … 0.00131 TAZ (pump.fun).
   - Минимум — один шаг 0.001 SOL, а не `minActionZat`: всё действие с комиссией запуска и так выше минимума. До v0.24 рабочее окно было ≈ 0.00105–0.00131 TAZ, а 0.001 TAZ давал `below_minimum`.
3. Hold = initial buy + `CREATE_FEE_ZAT` (0.001). Эпоха → релейер делает одну v0-tx create+buy со свежего creator-адреса.
4. Ожидается: в ленте `create` + `buy` с одной подписью, токен в `GET /api/tokens` с картинкой `http://127.0.0.1:8080/media/<sha>.jpg`, `/creator` показывает токен (позиция, лок, кап), `~/.unzeen/devnet/solana/creator-pubkeys.json` пополнился.
5. Продажа токенов первой покупки до конца лока → `423 creator_locked` (ожидаемо; поэтому на прогон `UNZEEN_CREATOR_LOCK_SECS=300`). Конец лока — `GET /api/creator` → `tokens[].lock.until` (начало часа + 1 ч, см. 0.3). Покупки создателя по своему токену сверх капа → `422 creator_cap`, в том числе `limit_buy` (ожидаемо).
6. Повторить с площадкой **Meteora DBC**. Кап считается по кривой DBC (свой `maxInitialBuyLamportsByVenue`). Ссылка explorer: tx `initialize_virtual_pool` + swap.

### C. Ордера (limit buy / stop-loss)
Условия: только pump.fun, только токены пула (есть в `GET /api/tokens`), на кривой; работающий `intel:run` (цена — с тика 45–75 с, ордер видит только тики **после** создания; тик старше 180 с ничего не исполняет). UI — панель ордеров на `/token/<mint>`.
- **Сработать сразу, без движения цены:**
  - `limit_buy` (`p ≤ trigger`): trigger **выше** текущей `priceSol` → срабатывает на первом тике, затем buy в ближайшую эпоху. ≈ 1–3 мин.
  - `take_profit` / `limit_sell` (`p ≥ trigger`): trigger **ниже** текущей цены.
  - `stop_loss` (`p ≤ trigger` на **2 тиках подряд**, slippage по умолчанию 15 %, сервер продаёт только если `p ≥ trigger·(1−slippage)`): trigger = цена × 1.05 → срабатывает через 2 тика (≈ 2–3 мин). Trigger сильно выше цены → ордер `failed (slippage)` — это тоже проверка.
- **Честно сдвинуть цену на devnet:** кривая devnet мелкая (1 SOL виртуальных резервов): покупка 0.1 SOL поднимает цену ~на 20 %. Второй ключ (другой origin, см. D) покупает 0.01 TAZ → цена растёт (срабатывают `take_profit`/`limit_sell` первого ключа); второй ключ продаёт → цена падает (срабатывает `stop_loss`). GAP: скрипта «купить/продать произвольный mint с внешнего кошелька» нет (`e2e:devnet` создаёт свои токены), поэтому двигаем цену только действиями пула.
- Ожидается: ордер `open` → пропадает из открытых, появляется обычное действие buy/sell (в ленте неотличимо от ручного). Лимиты: 10 открытых на ключ, 4 на ключ+mint.

### D. Fair-launch (только локально, `UNZEEN_FAIR_LAUNCH=1` + `NEXT_PUBLIC_FAIR_LAUNCH_BUILD=1`)
Перед стартом: релейер записал `launch_curves` (иначе `fl_create` → `503 launch curve … unknown`), ключ аттестаций **fair** пополнен (иначе запуск пройдёт без `attestation`).
**Несколько ключей:** один ключ на origin+сеть (`localStorage`). Три независимых ключа: `http://localhost:3100`, `http://127.0.0.1:3100` (оба уже в `API_CORS_ORIGINS`) и окно инкогнито (или другой профиль браузера). Каждому — свой Top up (≥ номинала заявки + запас).
1. Ключ 1: `/launch` → режим sealed → окно **120 с** (`UNZEEN_FL_WINDOWS_SECS` содержит 120), мета как в B. Hold = `CREATE_FEE_ZAT`. Запуск появляется в `GET /api/launches` на ближайшей границе эпохи Delayed (30–60 с).
2. Ключи 2 и 3 (и при желании 1): `/launch/<id>` → заявка с номиналом из сетки devnet 0.001/0.0025/0.005/0.01/0.025/0.05 TAZ и суммой ≤ номинала. Шифрование tlock — в браузере. Ошибки: `409 already_bid` (вторая заявка тем же ключом), `422 creator_cap` (создатель с крупным номиналом).
3. **Закрытие** (`closeAt`): статус `closed`, публикуется `commitment.root`; у владельца заявки — `proof` (проверка включения на странице). Сразу после — memo-tx `attest` с 64 hex корня от ключа fair → `commitment.attestation` (`solanaTx`, `slot`, `signer`, `beforeRound`, `matches: true`).
4. **Reveal** в `roundTime` раунда drand (≥ 30 с после закрытия): сервер проверяет BLS, расшифровывает, курс один на всех, режет пропорционально при `oversubscribed`, суммарно ≤ 25 % саплая (на devnet ≈ 0.3 SOL ≈ 0.026 TAZ).
5. **Исполнение**: одна атомарная `fair_create` (create+buy) в полосе now → `launched`. В ленте — обычные `create` + `buy` с одной подписью.
6. **Доли**: у каждого `fairBids[]` → `settled`, `tokenAmount`, `chargedZat ≤ amountZat`, `releasedZat`; токены в портфеле. `result.bids` публично — только число ≥ 5, иначе `"<5"` (при 2–3 заявках будет `"<5"`, это ожидаемо).
Отдельный смоук релейерной части без UI: `cd adapters && pnpm fair:devnet` (временная схема, владельческий `DATABASE_URL`, печатает адрес ключа fair и пропускает attest, если он не пополнен).

### E. Verify
Нужны одновременно: API, сканер (пишет резерв ZEC после начала заморозки), релейер (балансы vault на finalized-слоте + подпись `attest`), пополненный ключ **verify**.
```bash
cd $R && ./core/target/release/unzeen-api verify-snapshot     # печатает "snapshot #N requested"; на mainnet нужен --allow-mainnet
```
Заморозка ≤ 120 с: релейер не берёт торговые задания, сканер не шлёт выплаты. Затем:
```bash
curl -s 127.0.0.1:8080/api/verify | head -c 800; echo
```
Ожидается: `rootsDigest`, `operator` (pubkey = ключ verify, подпись) — сразу после подписи; `anchor` (memo-tx) — после подтверждения. В web `/verify`: проверка подписей «pinned» (если задан `NEXT_PUBLIC_ATTESTATION_PUBKEY_DEVNET`), кнопка **Check my balance** → подписанный `GET /api/verify/proof` (64 КиБ) → «committed ≥ your balance at takenAt». Баланс сравнивается на момент `takenAt`, а не текущий. Если снимок пропущен — причина в `verify_snapshots.status/…` (`busy`, `reserve_stale`, `assets_timeout`, `build_error`), повтор через 10 мин.

### F. Creator fees: fees:sweep → claim
1. Нужен токен, созданный пулом (B), и объём сделок по нему после запуска (комиссия самой launch-tx уходит пулу и вычитается из первых сборов).
2. ```bash
   cd $R/adapters
   FEE_SWEEP_STORE=postgres pnpm fees:sweep --dry-run          # claimable по каждой цели и порог
   FEE_SWEEP_STORE=postgres pnpm fees:sweep --min-lamports 100000   # реальный сбор (порог также ≥ 5× стоимости tx)
   ```
   Ожидается: `collected pumpfun/… <mint>: N lamports` + ссылки explorer (devnet печатает их), запись в `creator_fee_sweeps`.
3. API на ближайшей границе эпохи зачисляет сбор (`creator fee sweeps processed credited=…` в логе API). `/creator` → `claimable` по токену.
4. **Claim** → `claimable` переходит в `zecBalance` мгновенно, без tx в сети.
   - Сервер отказывает `422 below_minimum`, если `claimable` в ZEC < `MIN_CLAIM_ZAT` (API v0.11 `PoolInfo.minClaimZat`; по умолчанию 10 000 зат = 0.0001 ZEC ≈ 0.00115 SOL при курсе 11.5, не больше `MIN_ACTION_ZAT`). При комиссии создателя pump.fun ≤ 0.3 % это ~0.4 SOL объёма. Ещё ниже — `MIN_CLAIM_ZAT=1000` в `.env` и перезапуск API. GAP закрыт (отдельный порог).

### G. Stats
```bash
cd $R && ./core/target/release/unzeen-api stats-snapshot --include-today   # срез 00:00 UTC завтра: сегодняшний прогон виден
# без --include-today срез 00:00 UTC сегодня; на mainnet — только с --allow-mainnet
curl -s 127.0.0.1:8080/api/stats; echo
```
Ожидается `stats snapshot for <date> stored (cut-off 00:00 UTC tomorrow (today included))`, `/stats` показывает числа или `"<5"` (k-анонимность и округление те же). Без флага срез — 00:00 UTC сегодня (GAP закрыт).

---

## 3. Troubleshooting
| Симптом | Причина | Что делать |
|---|---|---|
| Браузер: CORS error, в Network `OPTIONS … 405` | `API_CORS_ORIGINS` пуст → CORS-слоя нет | задать оба origin web (1.6), перезапустить API |
| CORS error, preflight 200 без `access-control-allow-origin` | origin не в списке (`localhost` vs `127.0.0.1`, порт) | дописать точный origin |
| `503 venue_unavailable` «venue X is not enabled» | площадки нет в `UNZEEN_VENUES` (умолчание кода — только `pumpfun`) | `UNZEEN_VENUES=pumpfun,meteora-dbc` |
| «create is not available yet» / «launches are not available yet» | `UNZEEN_CREATE_ENABLED` ≠ 1 | включить, перезапустить API |
| «launch curve of this network unknown yet» (fl_create) | релейер не записал `launch_curves` | запустить релейер, проверить роль (1.4) |
| «ZEC/SOL rate unavailable» | нет `DEVNET_ZEC_SOL_RATE` и 1Click недоступен / котировка старше 120 с | задать фикс-курс на devnet |
| «jupiter is mainnet-only» | Jupiter на devnet | ожидаемо |
| «actions are disabled on this network» | mainnet без `UNZEEN_ALLOW_MAINNET_ACTIONS=1` | см. раздел 4 |
| Действие висит `queued`/повторы, `error_code=pool_liquidity` | у vault не хватает SOL (или токенов на закреплённом vault) — проблема пула, не пользователя; релейер ретраит | пополнить vault из фаусета (адреса — `pnpm keys:gen 3`) |
| `429` от Solana RPC в логе релейера / `loop error` | публичный devnet RPC или лимит Helius | `SOLANA_RPC_URL_DEVNET` = Helius; не гонять e2e-скрипты параллельно; `SOLANA_SEND_MIN_INTERVAL_MS` ≥ 1000 |
| `429` у индексатора (Shyft) | лимит Free | `INTEL_READ_RPS=3`; `INTEL_CURVE_MODE=poll` (WS у Shyft Free отклоняется) |
| `429 rate_limited` от нашего API | лимит на ключ 60/мин | подождать `Retry-After`; не держать много вкладок с одним ключом |
| Сканер: `scan pass failed`, backoff | testnet lightwalletd (единственный, фолбэков нет) | ждать; снизить `UNZEEN_COVER_RPS`; `unzeen-scanner probe` |
| Депозит не зачисляется | < K+джиттер подтверждений; сумма < `MIN_DEPOSIT_ZAT` (пыль); memo истёк (24 ч)/для другой сети; оплата не в Orchard | `ledger-stats`; на devnet `deposits` с каталогами пула покажет ноту и memo |
| Verify: снимок `skipped`, причина `reserve_stale` | сканер не сделал проход после начала заморозки (не запущен / завис на lightwalletd) | запустить `scanner serve`, повторить `verify-snapshot` |
| Verify: `assets_timeout` | релейер не записал балансы vault (не запущен, нет прав `verify_*`, RPC) | релейер + 1.4 |
| Verify: `busy` | задания в полёте дольше 90 с | дождаться, повтор через 10 мин |
| Verify: есть `operator`, нет `anchor`; fair: нет `attestation` | ключ аттестаций без SOL → `attest failed` (`pool_liquidity`) | пополнить из фаусета (не с vault!); Verify сам повторит attest раз в 10 мин (до 12 раз) |
| `/verify` «not pinned» | пустой `NEXT_PUBLIC_ATTESTATION_PUBKEY_DEVNET` | задать pubkey verify, перезапустить web |
| Картинки токенов — глифы | `UNZEEN_METADATA_BASE_URL` не на origin API (например 8787) | база = `NEXT_PUBLIC_API_URL_DEVNET` + `/media` |
| `GET /api/pool` 503 «pool address not published yet» | сканер `serve` ещё не стартовал | 1.5 |
| `GET /api/pool` 500, в логе API «pool_meta network differs» | в эту БД писал сканер другой сети | раздельные БД на сеть (раздел 4) |
| Ордер не срабатывает | не запущен `intel:run` / тик старше 180 с / mint не pump.fun или graduated | 1.8 |
| `423 creator_locked` | продажа/вывод токенов первой покупки создателя в течение лока | ожидаемо; на прогон `UNZEEN_CREATOR_LOCK_SECS=300` |
| `send`: «amount must be in 1..=50000000» (testnet) / «1..=5000000» (mainnet) | лимит CLI 0.5 TAZ / 0.05 ZEC | меньшая сумма |
| сканер/API: «refusing to start: this database belongs to …» | БД другой сети | раздельные БД (4.1, `infra/pg-mainnet.sh`) |

---

## 4. Mainnet-прогон (для видео)

Только с одобрения лида, только пыль. Перед стартом прочитать ещё раз.

### 4.1 Отдельная БД — обязательно
`balances`, `deposits`, `actions`, `pool_meta` (UA пула!) **не разделены по сети**. Mainnet-сканер в devnet-БД перезапишет `pool_ua` и зачислит реальные ZEC в тот же реестр. Поднять второй экземпляр Postgres отдельным compose-проектом (свой том, свой порт):
```bash
cd $R
infra/pg-mainnet.sh up       # отдельный compose-проект unzeen-main, свой том, 127.0.0.1:55433 (POSTGRES_PORT_MAINNET)
# первый старт mainnet-сканера/API применит миграции, затем:
infra/pg-mainnet.sh roles    # relayer-role.sql + indexer-role.sql на mainnet-инстанс (пароли из .env, не печатаются)
infra/pg-mainnet.sh psql     # psql владельца в mainnet-БД
```
и в mainnet-терминалах `DATABASE_URL`, `DATABASE_URL_RELAYER`, `DATABASE_URL_INDEXER` на порт 55433. Описано в `infra/README.md`; core сам откажется стартовать на БД другой сети (GAP закрыт).

**Hood-mainnet — третья БД (GAP-10):** тот же скрипт с `--hood` (проект `unzeen-hood`, 127.0.0.1:55434, `POSTGRES_PORT_HOOD`):
```bash
set -a; . ~/.unzeen/hood.env; set +a     # DATABASE_URL* -> :55434; пароли ролей берутся из окружения, затем из .env
infra/pg-mainnet.sh --hood up
# первый старт hood-сканера/API применит миграции, затем:
infra/pg-mainnet.sh --hood roles         # откажет, если экспортированные DATABASE_URL* смотрят не на 55434
infra/pg-mainnet.sh --hood psql
```
Скрипт отказывается работать с портом 55432 (devnet) и проверяет порты `DATABASE_URL*` перед `roles`. Проверка гардов без Docker: `bash infra/tests/pg-mainnet.test.sh`. Env-файл compose (`POSTGRES_PASSWORD`) — `UNZEEN_PG_ENV_FILE`, по умолчанию `.env`.

### 4.2 Флаги (в окружении mainnet-терминалов, поверх `.env`)
| Флаг | Процесс | Зачем |
|---|---|---|
| `UNZEEN_NETWORK=main` + `UNZEEN_SOLANA_CLUSTER=mainnet-beta` | scanner, API | только пара main+mainnet-beta (chainId 0101), иначе API не стартует |
| `SOLANA_CLUSTER=mainnet-beta` (или через `UNZEEN_SOLANA_CLUSTER`) + `UNZEEN_ALLOW_MAINNET=yes` | relayer, intel, fees, keys:* | без него adapters отказываются |
| `UNZEEN_ALLOW_MAINNET_SEND=1` | scanner (`send`, `serve --payouts`) | траты ZEC |
| `UNZEEN_ALLOW_MAINNET_ACTIONS=1` | API | иначе все `POST /api/actions` → 503 |
| `DEVNET_ZEC_SOL_RATE` — **убрать** | API | на mainnet-beta API с ним не стартует; курс — живая котировка 1Click (`ONECLICK_URL`, JWT необязателен) |
| `SOLANA_KEYS_AGE_KEY_FILE` (свой mainnet-файл), `DATABASE_URL_RELAYER` | relayer | обязательны, без них отказ |
| `API_BIND=127.0.0.1:8081`, `API_CORS_ORIGINS=…` | API | второй процесс API, свой origin |
| `UNZEEN_FAIR_LAUNCH=0` | API | см. 4.5 |
| `UNZEEN_VENUES=pumpfun,jupiter,raydium-launchlab` (+`meteora-dbc` после §6.3, +`bags` на VPS) | API | Meteora — только когда `METEORA_DBC_CONFIG_MAINNET` задан (§6.3), иначе релейер её на mainnet не обслуживает |
| `PINATA_JWT` **или** `UNZEEN_METADATA_BASE_URL=https://<публичный домен>/media` | API, relayer | GAP-5: с `UNZEEN_CREATE_ENABLED=1` на mainnet API без этого не стартует; релейер отказывает create до подписи |
| `UNZEEN_DEV_PRINT` — **не задавать** | все | dev-команды на mainnet отказывают — так и надо |
Web: `NEXT_PUBLIC_API_URL_MAINNET=http://127.0.0.1:8081`, `NEXT_PUBLIC_ATTESTATION_PUBKEY_MAINNET=<verify pubkey mainnet>`, перезапуск `pnpm dev`.

### 4.3 Лимиты сумм
- Депозит с ZODL: 0.02–0.05 ZEC. CLI `send` на mainnet режет на 0.05. Выплаты больше `UNZEEN_MAX_PAYOUT_ZAT` (0.05) встают на ручной просмотр.
- Buy 0.002–0.005 ZEC (≈ 0.02–0.06 SOL). Vault: суммарно ~0.3 SOL (бюджет STATUS). Каждая tx платит tip Helius Sender 5000 лампортов.
- Launch на mainnet: кап первой покупки по mainnet-кривой (30 SOL) больше devnet, но держать initial buy минимальным. Fair-launch на mainnet не делать (номиналы от 0.05 ZEC).
- Пополнение vault — из источника, не связанного с личностью владельца (не биржевой вывод на имя владельца): адреса vault публичны в Verify.

### 4.4 Порядок
1. Отдельная БД (4.1), `cargo build --release`.
2. `UNZEEN_NETWORK=main … unzeen-scanner init` (сид, UA пула mainnet), затем `serve --payouts`.
3. `UNZEEN_ALLOW_MAINNET=yes SOLANA_CLUSTER=mainnet-beta SOLANA_KEYS_AGE_KEY_FILE=<mainnet файл> pnpm keys:encrypt` (создаст age-файл), `pnpm keys:gen 2`, пополнить vault и ключ verify.
4. Роли (1.4 на mainnet-БД), API на 8081, relayer, intel.
5. Сценарий A целиком (Top up с ZODL по QR → Buy Now и Delayed → лента → Sell → Withdraw токенов → Withdraw ZEC в ZODL).
6. Launch pump.fun — нужен `PINATA_JWT` или `UNZEEN_METADATA_BASE_URL` на публичном HTTPS-домене: URI метаданных пишется в цепочку навсегда. Теперь это гард, а не правило (GAP-5): API на mainnet с `UNZEEN_CREATE_ENABLED=1` без этого не стартует («refusing to start: … not https / not public»), релейер при старте пишет WARN и все create падают `venue_unavailable` до подписи. Локальный прогон без публичного HTTPS — только с `PINATA_JWT`.
7. Verify/Stats на mainnet вручную — только явным флагом оператора: `unzeen-api verify-snapshot --allow-mainnet` (заморозка торговли ≤ 120 с), `unzeen-api stats-snapshot --include-today --allow-mainnet` (GAP закрыт).
7a. Авторебаланс на mainnet (по желанию, с одобрения лида): `UNZEEN_ALLOW_MAINNET_REBALANCE=1`, `UNZEEN_REBALANCE_SOL_ADDRESS=<rebalance-адрес релейера, не vault>`, `UNZEEN_REBALANCE_LOT_ZAT` ≤ `UNZEEN_REBALANCE_MAX_LOT_ZAT` (пыль на прогоне, минимум 1Click 132 000 зат), затем `scanner serve --rebalance` и `rebalance plan --force --now` для ручного запуска. Проверить сначала `rebalance quote` (строка `refund: pool wallet t-address`). `UNZEEN_REBALANCE_REFUND_TADDR` **не задавать**: refund идёт на собственный t-адрес кошелька пула, разбор — §6.1.
8. После съёмки: остановить API mainnet (или `UNZEEN_ALLOW_MAINNET_ACTIONS=0`), выплатить остатки, `unset` всех `ALLOW_MAINNET_*`.

### 4.5 Что НЕ показывать на экране
- `.env`, `web/.env.local`, любые `env`/`printenv`, URL RPC (Helius/Shyft — ключ в query), `ONECLICK_JWT`, `PINATA_JWT`.
- Сид-фразу на `/key` (hold-to-reveal не нажимать), пароль, `~/.unzeen/*` (age-ключи, `*.age`, `cli-anon.key`), вывод `memo-deposit`, `sign-request`, `dev-request`, `balance`, `deposits`, `sync`, `inspect-tx`, `address --show-ufvk`.
- Терминалы с логами — лучше вообще не показывать (логи чистые, но там пути и счётчики); `psql` по `relayer_jobs`/`actions`.
- До 28.10 23:59 UTC: fair-launch (tlock, sealed bids, ключ fair), упоминания Jito-бандла. Если видео публикуется (даже unlisted) до дедлайна — без сценария D.
- Связку «моё лицо/аккаунт ↔ конкретный депозит»: на одном кадре не показывать Top up из ZODL и сразу Buy с той же суммой — демонстрация сама нарушает то, что продукт защищает (лучше Delayed, разные суммы, пауза).

---

## 5. Robinhood Chain (hood, Pons V2)

Отдельный инстанс: своя БД, свой Zcash-сид пула, свой UA, `chainId 0111` (mainnet) / `0212` (testnet). Pons есть только на mainnet 4663, поэтому живой hood — это mainnet (только с разрешения лида).

### 5.1 Env (имена; значения только в `.env`, в git не попадают)
| Переменная | Что |
|---|---|
| `UNZEEN_HOOD=on` | включает EVM-часть adapters |
| `HOOD_NETWORK=mainnet` | `mainnet` (4663) / `testnet` (46630, Pons нет) |
| `HOOD_RPC_URL_MAINNET`, `HOOD_SEND_RPC_URL_MAINNET` | платный RPC для чтения + отдельный провайдер для отправки. Публичный RPC отдаёт 429 (Cloudflare) |
| `UNZEEN_ALLOW_HOOD_MAINNET=yes` | без него executor только читает и `relayer:hood` не стартует (mainnet-guard) |
| `HOOD_KEYS_DIR` | по умолчанию `$UNZEEN_HOME/hood-mainnet/evm` (каталог 0700) |
| `HOOD_KEYS_AGE_KEY_FILE` | age-identity вне каталога ключей, 0600. На mainnet обязателен |
| `DATABASE_URL_RELAYER` | роль `unzeen_relayer` **БД hood-инстанса** (после миграций перезапустить `infra/relayer-role.sql`) |
| `HOOD_VAULTS` (2), `HOOD_FUNDERS` (8), `HOOD_FEE_SWEEP=1` | число vault, число funder'ов в ротации, сбор комиссий создателя |
| `HOOD_FUNDER_TARGET_WEI` / `_LOW_WEI` / `_LOT_WEI` | GAP-7: цель / порог / лот пополнения funder'а, по умолчанию 0.02 / 0.011 / 0.005 ETH (`low < target`, `lot ≤ target`, иначе релейер не стартует) |
| `HOOD_CREATOR_FUND_STEP_WEI` / `HOOD_CREATOR_GAS_RESERVE_WEI` | шаг пополнения funder → creator (кратно ему, круглые суммы) и запас газа creator, по умолчанию 0.01 / 0.002 ETH. Запас < 5.6M gas × `maxFeePerGas` — релейер не стартует; WARN, если `HOOD_FUNDER_TARGET_WEI` не покрывает один create |
| `HOOD_FUNDER_POLL_SECS` | GAP-8: опрос адреса ребаланса на приход ETH, по умолчанию 300 с (30..3600) |
| `HOOD_MAX_FEE_WEI`, `HOOD_RPC_MAX_RPS` | минимум единого `maxFeePerGas` (0,2 gwei) и лимит запросов |

Core hood-инстанс: `UNZEEN_CHAIN=hood`, `UNZEEN_NETWORK=main`, `UNZEEN_VENUES=pons`, `UNZEEN_REBALANCE_ETH_ADDRESS` (= адрес ребаланса из `evm:keys`). `UNZEEN_ALLOW_MAINNET_REBALANCE` — только на время прогона. Кошелёк Zcash hood-пула по умолчанию в `~/.unzeen/hood-main/{data,keys}` (GAP-9); явные `UNZEEN_DATA_DIR`/`UNZEEN_KEYS_DIR` больше не обязательны, но если заданы и указывают на кошелёк Solana-пула, сканер откажет («belongs to the "solana" pool instance»). Свой `UNZEEN_SEED_KEY_FILE`. БД — §4.1 (`--hood`).

### 5.2 Ключи
1. `cd adapters && HOOD_NETWORK=mainnet pnpm evm:keys 2` — создаёт сид при первом запуске (24 слова, `evm-seed.txt.age`, 0600) и печатает **только адреса**: `vault-*`, `funder-0..7`, `rebalance-0`, `attest`. Если права на файл шире 0600, чтение сида будет отклонено.
2. Ветки BIP-44 coin 60: vault 0, creator 1, attest 2, rebalance 3, funder 4.
3. **Откуда ETH** (ни один перевод не с личного кошелька владельца):
   - **адрес ребаланса** — ZEC → ETH(hood) через NEAR 1Click (ручной лот или ребаланс сканера);
   - **vault** — задание `fund_vaults` (одна tx Multicall3 с адреса ребаланса);
   - **funder'ы** — их пополняет только адрес ребаланса (`FunderPool.topUp`): при старте, раз в 1–3 ч и **по приходу ETH** на адрес ребаланса (опрос раз в ~5 мин, GAP-8: рестарт релейера после ребаланса не нужен, в логе `hood funder top-up on arrival: sent=N`). Пороги — `HOOD_FUNDER_*` (5.1). С `UNZEEN_REBALANCE_KEEP_LAMPORTS=22000000000000000` на адресе ребаланса остаётся 0.022 ETH — хватает на одно пополнение funder'а до 0.02;
   - **ключ аттестаций hood** (`attest`) владелец **пополняет вручную из внешнего источника**: отдельный перевод, не с vault и не с адреса ребаланса. На старте релейер предупреждает, если на ключе < 0,0002 ETH.

### 5.3 Запуск
```
cd adapters
HOOD_NETWORK=mainnet UNZEEN_HOOD=on UNZEEN_ALLOW_HOOD_MAINNET=yes pnpm relayer:hood
```
При старте релейер:
- проверяет роль (`action_id` нечитаем), `mint_vaults` и хеши кода Pons;
- сверяет `launches reconciled`;
- пишет `launch_curves (hood,pons)`, затем повторяет раз в 10 мин (без этой строки create на hood отдаёт 503);
- пишет `pool_sol_inventory` раз в ~5 мин;
- раз в 1–2 мин обновляет цены токенов пула (graduated — через V4Quoter, «0» не пишет никогда);
- раз в 1–2 с опрашивает снимок Verify;
- если `HOOD_FEE_SWEEP=1`, запускает сбор комиссий создателей раз в 6–12 ч.

Состояние рядом с ключами (0600):
- `creator-counter.json` и `creator-addresses.json` (публичный список creator);
- `pending-launches.json` — если нет `relayer_launches`;
- `sent-at.json` — время отправки tx, пока core не добавит `relayer_jobs.sent_at`;
- `fees-owed.json` — комиссии, полученные из escrow, но ещё не переведённые на vault.

### 5.4 Проверки
- **Тесты без сети:** `pnpm test`.
- **Форк mainnet:** `pnpm test:fork` (нужен `anvil`).
- **Сквозной тест с core:** `HOOD_E2E=1 HOOD_E2E_LOG=/tmp/api.log npx vitest run test/evm/hood-e2e.test.ts` — временная БД, core API, anvil, Verify v3.
- **Чеклист живого прогона:** `docs/analysis/review-hood-final.md`.

## GAP — сводка
1. ~~Нет команды, печатающей публичные ключи аттестаций~~ — **закрыт**: `pnpm keys:attest`.
2. ~~Ledger не разделён по сети~~ — **закрыт частично**: таблицы общие, но core отказывается стартовать на БД другой сети/кошелька; отдельная mainnet-БД — `infra/pg-mainnet.sh`, `infra/README.md`.
3. ~~Авторебаланс не существует~~ — **закрыт в core**: `serve --rebalance`, `rebalance quote|check|status|plan|close` (dry-run вне mainnet). Остаток: релейер v7 (`pool_sol_inventory`, `fund_vaults`, `consolidate`).
4. ~~Сегодняшний прогон не виден в Stats~~ — **закрыт**: `stats-snapshot --include-today`.
5. ~~Нет ручных снимков на mainnet~~ — **закрыт**: `--allow-mainnet`.
6. `media:serve` (8787) бесполезен для фронта: картинки разрешены только с origin API; базу метаданных нужно ставить на API `/media`.
7. ~~Mainnet launch с локальной базой метаданных запишет `127.0.0.1` в URI~~ — **закрыт гардом** (16.10, GAP-5): API не стартует, релейер отказывает create. Публичный домен или Pinata по-прежнему нужны, чтобы create вообще работал.
8. ~~Meteora DBC на mainnet недоступна~~ — **закрыт** (16.10, GAP-3): `meteora:config` с mainnet-гардом (§6.3), конфиг создаётся один раз владельцем.
9. ~~Claim недостижим~~ — **закрыт**: отдельный `MIN_CLAIM_ZAT` (10 000 по умолчанию, `PoolInfo.minClaimZat`).
10. Нет скрипта торговли произвольным mint с внешнего кошелька → цену для ордеров двигаем только действиями второго ключа.
11. ~~Нет «спендабл-баланса»~~ — **закрыт**: `unzeen-scanner wallet-balance` (для dev-user — с `UNZEEN_DATA_DIR`/`UNZEEN_KEYS_DIR` dev-user).
12. ~~Устаревшие release-бинари~~ — **закрыт**: пересобраны 13.10 (после `git pull` — снова `cargo build --release`).
13. ~~`send` 0.05 против Top up 0.1~~ — **закрыт**: на testnet потолок 0.5 TAZ (mainnet 0.05).
14. Один ключ на origin в web: несколько участников fair-launch — только через разные origin/профили браузера.
15. В текущем `.env` нет `API_CORS_ORIGINS`, `UNZEEN_VENUES`, `UNZEEN_CREATE_ENABLED`, `DEVNET_ZEC_SOL_RATE`, `UNZEEN_METADATA_BASE_URL`, `FEE_SWEEP_STORE` — без них сценарии B, D, F и любые запросы из браузера не работают.
16. ~~Refund 1Click некуда принять~~ — **закрыт** (16.10, GAP-2): собственный t-адрес кошелька пула + `unzeen-scanner shield` (§6.1).
17. ~~Ручной SQL для `needs_review`~~ — **закрыт** (16.10, GAP-11): `unzeen-api review-job` (§6.2).

---

## 6. Операторские команды mainnet (GAP mainnet-прогона, 16.10)

Все — только у оператора, не на камеру. Логи этих команд и сервисов — только счётчики и суммы, без адресов и txid.

### 6.1 Refund 1Click → `shield` (GAP-2)
- У кошелька пула есть собственный прозрачный адрес: внешний P2PKH-receiver того же аккаунта (тот же сид). В UA пула (`/api/pool`, QR) его **нет**, в API и UI он не публикуется. Печатает только `unzeen-scanner address --transparent` (одна строка, адрес).
- `serve --rebalance` и `rebalance quote` на mainnet сами берут его как refund-адрес, если `UNZEEN_REBALANCE_REFUND_TADDR` пуст (`refund: pool wallet t-address`). Если env задан и указывает на чужой адрес — WARN «`shield` cannot recover refunds there».
- Признак refund: `rebalance status` → `refunded`/`attention`. Закрыть: `rebalance close <id> --status refunded`.
- Шилд (сканер `serve` должен работать — кошелёк синхронизирован):
```bash
set -a; . ~/.unzeen/main.env; set +a          # или hood.env: у hood-пула свой t-адрес
./core/target/release/unzeen-scanner shield --dry-run   # UTXO, подтверждения, комиссия ZIP-317, сумма в Ironwood
UNZEEN_ALLOW_MAINNET_SEND=1 ./core/target/release/unzeen-scanner shield
```
  Одна tx: все подтверждённые (K=`UNZEEN_CONFIRMATIONS`) UTXO refund-адреса → внутренний Ironwood-receiver пула, `OvkPolicy::Discard`. Это change-нота: в реестр депозитов она не попадает (ни `credited`, ни `frozen`), через K подтверждений — снова оборотный ZEC (`wallet-balance` → spendable). После этого повторить S2/H2.
- Запрос UTXO и отправка идут только через `LIGHTWALLETD_SEND_URL`, не через сервер сканирования: тот не узнаёт t-адрес пула. На mainnet без `LIGHTWALLETD_SEND_URL` команда отказывает (и `--dry-run` тоже). `--dry-run` ничего не пишет в wallet DB: комиссия — оценка ZIP-317 (5000 × (входы + 2)), совпадает с реальным предложением.
- **Если был refund — `shield` до снимка Verify.** Refund-UTXO и ZEC, зависший в 1Click, в reserve Verify не входят (там только shielded): снимок до шилда покажет меньший резерв. Сумма и t-адрес шилд-tx публичны (как любой t→z), адресат — нет.
- txid по умолчанию не печатается (`--show-txid`, если нужен). `--min-zat` (по умолчанию 20 000) — меньше не шилдит.
- Кошельки, созданные до 16.10 (локальный testnet-пул), прозрачного ключа не имеют: `address --transparent` отвечает «created before GAP-2». Mainnet-пулы (Solana и hood) создаются `init` этой сборкой — у них t-адрес есть. Обход для старого кошелька — только явный `UNZEEN_REBALANCE_REFUND_TADDR`.

### 6.2 `needs_review` → `unzeen-api review-job` (GAP-11)
```bash
./core/target/release/unzeen-api review-job                 # список: id, op, venue, сеть, суммы задания, возраст
./core/target/release/unzeen-api review-job 42 --show-signature   # одно задание + хеш tx для Blockscout/Solscan
./core/target/release/unzeen-api review-job 42 --reparse    # hood: отдать релейеру сейчас, он перечитает receipt из цепочки
./core/target/release/unzeen-api review-job 42 --confirm --out-token-amount N --out-lamports W [--out-mint M] [--slot B] --yes
./core/target/release/unzeen-api review-job 42 --fail --yes [--hash 0x…]  # только при REVERTED receipt; transfer — с --hash
```
- Порядок: сначала `--reparse` (суммы из цепочки, не руками). Если через ~1 мин задание снова `needs_review` — смотреть tx в explorer и делать `--confirm` с фактами (wei/лампорты, базовые единицы токена) или `--fail`.
- `--fail` (M1): только hood. Команда сама читает receipt записанной tx через `HOOD_RPC_URL_MAINNET` (иначе публичный RPC) и разрешает `failed` **только при status 0 (reverted)**. Успешная tx — отказ («funds moved»), receipt нет (pending/dropped) — отказ, `--reparse` и повторить позже. Для `transfer` ещё нужен `--hash` = хеш задания (сверка оператором, защита от двойной выплаты).
- `--confirm` проверяет суммы против задания: buy — потрачено ≤ `lamports_in` и токенов > 0; sell — продано ≤ `token_amount`; transfer — ровно `token_amount`; `fund_vaults` — `--out-lamports`. **create / fair_create руками не подтверждаются** (M2: релейер в той же транзакции пишет `tokens`, `mint_vaults`, `trades`, цену) — только `--reparse`. `attest` — тоже только `--reparse`/`--fail`. Пары с ZEC: `--out-quote-amount` + `--out-quote-mint` вместо `--out-lamports`.
- Меняет только задания в `needs_review` без `settled_at`. Если релейер успел разобрать сам — «left needs_review meanwhile», ничего не меняется. Дальше settler core закрывает действие за ~1 с.
- `--reparse` только для hood: Solana-релейер `needs_review` не пишет.

### 6.3 Meteora DBC и платформа LaunchLab «Unzeen» на mainnet (GAP-3, GAP-4; один раз на сеть, делает владелец)
1. `SOLANA_CLUSTER=mainnet-beta UNZEEN_ALLOW_MAINNET=yes pnpm meteora:config --simulate`, затем то же для `pnpm launchlab:platform --simulate`. Скрипты печатают адрес partner (он же fee claimer и admin платформы), сколько нужно и сколько не хватает. Ориентир: ≈0.008 SOL на конфиг и ≈0.0075 SOL на платформу, вместе ≈0.016 SOL.
2. Пополнить partner **из внешнего операторского кошелька**, как ключ `verify`. Никогда из vault и никогда с адреса ребаланса (публично связало бы торговые кошельки пула с fee claimer'ом). Скрипт на mainnet отказывает, пока денег не хватает.
3. `... UNZEEN_ALLOW_MAINNET_SETUP=yes pnpm meteora:config --send` и подтвердить, введя адрес partner (или `--confirm-mainnet <partner>`). Записать напечатанный `METEORA_DBC_CONFIG_MAINNET` в main.env, добавить `meteora-dbc` в `UNZEEN_VENUES`, перезапустить релейер и API.
4. То же для `pnpm launchlab:platform --send`. После перезапуска релейера WARN `LaunchLab platform unzeen switched off` пропадёт, create с `platform: "unzeen"` заработает (creator fee 0.30 %, у bonk 0). Пока платформы нет — create с `unzeen` получает `venue_unavailable` до подписи, запускать с `bonk`.
5. Снять `UNZEEN_ALLOW_MAINNET_SETUP`. Перед `--send` обязательно `--simulate` уже с пополненным partner.
6. `meteora:config` печатает адрес нового конфига **до** отправки и при каждом запуске ищет конфиги этого partner'а для той же quote: если конфиг уже есть (например, `--send` упал по таймауту, но tx легла), печатает `set METEORA_DBC_CONFIG_…=<он>` и ничего не создаёт. Второй конфиг — только с `--force-new`.

---

## 7. Деплой на VPS (18.10, `infra/deploy/`)

Один VPS, на нём всё (решение владельца: без Vercel и без Cloudflare-proxy): фронт (Next.js prod), Caddy (HTTPS), три инстанса бекенда — **devnet** (Zcash testnet + Solana devnet), **mainnet** (Zcash main + Solana mainnet-beta), **hood** (Zcash main + Robinhood Chain 4663). У каждого инстанса свой Postgres, своя docker-сеть, свой env-файл, свои ключи и свой каталог состояния на зашифрованном томе. Закрывает A3/A9 (`docs/analysis/final-audit.md`), N2, H9, E17, L-18.

Файлы:
| Файл | Что |
|---|---|
| `infra/deploy/compose.yml` | весь стек: `web`, `caddy`, `pg-/api-/scanner-/relayer-<inst>`, `intel-devnet`, `intel-mainnet`; профили `devnet`/`mainnet`/`hood`, `build` |
| `infra/deploy/Caddyfile` | прокси: хосты, без access-логов, фильтр логов, без сжатия на API, лимиты в памяти, срез `X-Forwarded-For` |
| `infra/deploy/docker/{core,adapters,web,caddy}.Dockerfile` | образы (core — release-сборка Rust; caddy — с `caddy-ratelimit`) |
| `infra/deploy/env/*.env.example` | шаблоны `/etc/unzeen/{stack,devnet,mainnet,hood,monitor}.env` без секретов |
| `infra/deploy/bin/bootstrap.sh` | первичная настройка Ubuntu 24.04 (идемпотентная) |
| `infra/deploy/bin/unzeen-vault-init`, `unzeen-unlock`, `unzeen-lock` | зашифрованный том LUKS2 |
| `infra/deploy/bin/unzeenctl` | всё операторское: deploy, keys, roles, psql, разовые команды scanner/api/adapters, check-proxy |
| `infra/deploy/bin/unzeen-monitor` + `systemd/unzeen-monitor.{service,timer}` | проверки раз в 5 мин, алерт в Telegram |
| `infra/deploy/bin/deploy.sh` | запускается на Mac: отправить HEAD на VPS и задеплоить |

Схема на VPS:
```
Internet :80/:443 ── caddy ──┬── web:3000                     (WEB_HOST)
                             ├── api-devnet:8080   ─┐ сеть devnet:  pg-devnet, scanner-, relayer-, intel-devnet
                             ├── api-mainnet:8080  ─┤ сеть mainnet: pg-mainnet, scanner-, relayer-, intel-mainnet
                             └── api-hood:8080     ─┘ сеть hood:    pg-hood, scanner-hood, relayer-hood
127.0.0.1: 8080/8081/8082 (API для оператора и монитора), 3100 (web). Postgres наружу не публикуется.
/srv/unzeen  (LUKS2 из /var/lib/unzeen/vault.img): <inst>/home (= UNZEEN_HOME), <inst>/pg (данные Postgres)
/etc/unzeen: stack.env, <inst>.env (0640 root:<admin>), monitor.env (0600), keys/<inst>/* (0600, uid 10001)
/opt/unzeen/releases/<sha>, /opt/unzeen/current -> текущий релиз
```

### 7.1 VPS: требования и провайдер
- **ОС:** Ubuntu 24.04 LTS, x86_64.
- **Ресурсы (сборка Rust прямо на VPS):** 8 vCPU / 16 GB RAM / ≥ 160 GB SSD. Release-сборка librustzcash + halo2 съедает 4–6 GB RAM и 15–30 мин при первом запуске. В работе стек занимает ~4–5 GB RAM: 3× Postgres, 3× scanner, 3× API, 3× relayer, 2× indexer, Next, Caddy. Диск: образы и кеш сборки ~20–25 GB, том 40 GB. Минимум — 4 vCPU / 8 GB, но тогда сборка идёт дольше, а своп нельзя (см. ниже).
- **Сборку можно вынести с VPS:** образы под x86_64 на Mac с Apple Silicon собираются через эмуляцию часами — не советую. Есть два варианта: (а) собирать на VPS (по умолчанию, `deploy.sh`); (б) взять ARM-VPS (Hetzner CAX), собрать образы локально на Mac под arm64 и залить через `docker save | ssh … docker load`. Вариант (б) в скриптах не реализован.
- **Провайдеры в EU** (цены ориентировочные, проверить при покупке):
  1. **Hetzner Cloud CX43** — 8 vCPU / 16 GB / 160 GB, ≈ €12/мес + IPv4 (Германия/Финляндия). Бэкапы — платная опция, по умолчанию **выключены**, снапшоты только вручную. Новым аккаунтам иногда нужна верификация личности. **Рекомендую.** Если нужно больше диска — CPX42 (320 GB, ≈ €25).
  2. **OVHcloud VPS** (тариф с 8 vCore / 24 GB) — Франция/Германия, автобэкап — платная опция (не включать).
  3. **netcup VPS 2000** (8 vCore / 16 GB / 512 GB, Германия) — дёшево, но бывает минимальный срок договора и медленнее панель; снапшоты только вручную.
- **При покупке (делает владелец):**
  - образ Ubuntu 24.04, **свой SSH-ключ** (публичный, лучше отдельный: `ssh-keygen -t ed25519 -f ~/.ssh/unzeen_vps`), пароль root не задавать;
  - **бэкапы и автоснапшоты провайдера НЕ включать** (N2: снапшот диска = копия контейнера тома, при утечке пароля — весь реестр);
  - без «managed firewall»/CDN провайдера (ufw ставит bootstrap); IPv6 по желанию;
  - запомнить IPv4 — нужен для DNS или sslip.io;
  - в README/модели доверия: провайдер VPS видит сетевые метаданные (кто и когда подключается).

### 7.2 Домен или sslip.io
Каждой сети нужен свой origin, API — в корне (подписанный request-target не должен меняться): `WEB_HOST`, `API_DEVNET_HOST`, `API_MAINNET_HOST`, `API_HOOD_HOST` в `/etc/unzeen/stack.env`.
- **Свой домен (рекомендую):** A-записи (и AAAA, если есть IPv6) `unzeen.<домен>`, `api-devnet.<домен>`, `api-mainnet.<домен>`, `api-hood.<домен>` → IP VPS. Режим DNS only, **без прокси регистратора/Cloudflare**. В whois — приватность регистратора. Caddy сам получит сертификаты Let's Encrypt (HTTP-01 на :80), e-mail для ACME не задаём.
- **Временно без домена — sslip.io:** `WEB_HOST=203-0-113-7.sslip.io`, `API_DEVNET_HOST=api-devnet.203-0-113-7.sslip.io` и т. д. (DNS sslip сам отвечает IP из имени). Минусы: IP VPS в каждом URL; лимиты Let's Encrypt на общий домен (если упрёмся — нужен свой домен); **нельзя для mainnet-launch**: URI метаданных (`https://api-mainnet…/media/…`) пишется в цепочку навсегда и умрёт вместе с IP. На mainnet с sslip — только `PINATA_JWT` (Pinata приоритетнее базы `/media`, `adapters/src/metadata.ts`). nip.io работает так же.
- Смена хостов = пересборка web (`NEXT_PUBLIC_*` вшиваются) + рестарт API (`API_CORS_ORIGINS`) — `unzeenctl deploy <sha>`.

### 7.3 Bootstrap (один раз, ~5 мин)
```bash
# на Mac
scp -i ~/.ssh/unzeen_vps -r infra/deploy root@<IP>:/root/unzeen-deploy
ssh -i ~/.ssh/unzeen_vps root@<IP> 'ADMIN_USER=unzeen bash /root/unzeen-deploy/bin/bootstrap.sh'   # фаза 1: root по ключу ещё можно
# ~/.ssh/config: Host unzeen-vps / HostName <IP> / User unzeen / IdentityFile ~/.ssh/unzeen_vps / IdentitiesOnly yes
ssh unzeen-vps 'sudo -n true && docker ps'     # проверить вход под unzeen в НОВОМ терминале
ssh unzeen-vps 'sudo DISABLE_ROOT_LOGIN=1 ADMIN_USER=unzeen bash /root/unzeen-deploy/bin/bootstrap.sh'   # фаза 2: root-вход выключен
```
Что делает: пользователь `unzeen` (sudo без пароля — у него нет пароля, вход только по ключу; группа docker) с ключами root; `sshd`: только ключ; в фазе 1 `PermitRootLogin prohibit-password` + `AllowUsers unzeen root`, в фазе 2 (`DISABLE_ROOT_LOGIN=1`) — `PermitRootLogin no`, `AllowUsers unzeen` (если ключей нет — шаг пропускается, чтобы не запереть); ufw: 22 (limit), 80, 443; unattended-upgrades только security и **без автоперезагрузки** (ребут запирает том); Docker CE + compose, `daemon.json`: ротация логов 10 MB × 3, `live-restore`; fail2ban на sshd; journald 200 MB / 7 дней; core dumps выключены; предупреждение, если включён своп на незашифрованном диске (лучше `swapoff -a` и убрать из fstab); каталоги `/etc/unzeen`, `/opt/unzeen`, точка монтирования `/srv/unzeen` с `chattr +i`; утилиты в `/usr/local/sbin`; таймер монитора. Повторный запуск безопасен: существующие env-файлы не перезаписывает.

Docker публикует порты в обход ufw. Поэтому в `compose.yml` наружу открыт только Caddy (80/443), всё остальное — на `127.0.0.1`.

### 7.4 Зашифрованный том (N2)
```bash
ssh -t unzeen-vps sudo unzeen-vault-init 40     # LUKS2-файл 40 GB, ext4, /srv/unzeen; пароль вводит владелец
scp unzeen-vps:/var/lib/unzeen/vault.luks-header ~/offline-backup/   # копия заголовка (бесполезна без пароля)
```
- Пароль тома — только у владельца (менеджер паролей), в чат и в файлы не попадает. Без него данные пула не восстановить.
- **После любой перезагрузки** том заперт: `ssh -t unzeen-vps sudo unzeen-unlock` (спросит пароль, смонтирует том, проверит маркер `.unzeen-volume`, поднимет стек). До этого web открывается, API всех сетей отвечают `503 unavailable`, а монитор шлёт «volume is LOCKED».
- Почему сервисы не стартуют на пустом диске: все bind-монтирования состояния — с `create_host_path: false`, а `/srv/unzeen` без тома immutable. Docker не может создать каталог, и контейнер не стартует. Postgres не выполнит initdb на незашифрованном корне, сканер не создаст новый кошелёк.
- `sudo unzeen-lock` — остановить бекенды и запереть том вручную.
- **age-идентичности вне тома** (решение N2): `/etc/unzeen/keys/<inst>/{seed,solana|hood-evm}.agekey`, 0600, uid 10001. В контейнер монтируются по одному файлу и только read-only, каждому сервису — только свой (scanner — seed, relayer — solana/hood-evm, API — chat/scenario). Systemd `LoadCredential` не используем: сервисы в docker, read-only bind одного файла даёт то же самое. Зашифрованные сиды (`*.age`) лежат на томе, их ключи — на корневом диске. Ни снапшот диска, ни копия тома по отдельности ничего не дают.
- Увеличить том: `unzeen-lock` → `truncate -s +20G /var/lib/unzeen/vault.img` → `cryptsetup open …` → `cryptsetup resize unzeen` → `resize2fs /dev/mapper/unzeen` → `unzeen-unlock`.

### 7.5 Env и ключи
1. Заполнить `/etc/unzeen/stack.env` (хосты, не секрет) и `/etc/unzeen/<inst>.env`: каждое `__SET__` — значение из `.env` с Mac или из `docs/submission/mainnet-demo-run.md` §1.3. Редактировать на VPS (`sudoedit /etc/unzeen/mainnet.env`), значения не печатать и не копировать через чат. Значения — без кавычек.
2. `sudo unzeenctl keys <inst>` для каждого инстанса: создаёт недостающие `pg-password`, `chat.key`, `scenario.key` (разные, 32 байта hex), age-идентичности; вписывает в env `DATABASE_URL`, `DATABASE_URL_RELAYER`, `DATABASE_URL_INDEXER` со случайными паролями (хост `pg-<inst>`). Ничего не печатает. Существующие файлы не трогает.
3. `sudo unzeenctl check-env` — нет ли незаполненных `__SET__`/`__GENERATE__`, все ли ключи на месте, нет ли `DEVNET_ZEC_SOL_RATE` на mainnet и `UNZEEN_DEV_PRINT`.
4. **Офлайн-бэкап** `/etc/unzeen/keys/*/*.agekey` и сидов: после `scanner init` / `keys:gen` / `evm:keys` — шифрованный носитель, не облако.

Что compose задаёт сам, поверх env-файла (в шаблонах этого нет): `UNZEEN_HOME=/data/home`, `API_BIND=0.0.0.0:8080`, `API_CORS_ORIGINS=https://$WEB_HOST`, `UNZEEN_METADATA_BASE_URL=https://<API-хост сети>/media` (https, GAP-5), пути `*_KEY_FILE`. Релейеру и индексатору — пустой `DATABASE_URL` (никогда не владельческая роль, RELAYER.md), индексатору ещё и пустой `DATABASE_URL_RELAYER`.

**A9 (лимиты):** за прокси все запросы приходят в core с одного адреса, поэтому `API_RL_IP_PER_SEC=1000`/`API_RL_IP_BURST=3000` в шаблонах. Лимит по клиенту держит Caddy: чтение 300 / 10 с, POST 30 / 10 с, WS 30 / мин, web 600 / 10 с — `RL_*` в `stack.env`. Лимит по anon-ключу в core (`API_RL_KEY_*`) остаётся. Счётчики Caddy — только в памяти: без distributed-режима, на диск ничего не пишется. Пользователи Tor делят лимит выходного узла.

### 7.6 Сборка и деплой
```bash
# на Mac, из корня репо, после коммита
infra/deploy/bin/deploy.sh unzeen-vps          # всё
infra/deploy/bin/deploy.sh unzeen-vps --web    # только web + caddy (сменились pubkey аттестаций / хосты в stack.env)
```
- Пробная сборка без коммита: `deploy.sh unzeen-vps --wip-build` — шлёт рабочее дерево (tracked + untracked, без ignored) как релиз `<sha>-wip` и только собирает образы (`unzeenctl build`), ничего не перезапускает. Деплоить `-wip` нельзя.
- Архив идёт сжатым (`gzip -9`): канал до VPS бывает ~20–25 KB/s, 10 MB исходников без сжатия — 7 мин.
- Сборка на маленьком VPS: `CARGO_BUILD_JOBS` в `stack.env` (≈1 GB RAM на job).
- `deploy.sh` отказывается работать, если в `core/ adapters/ web/ infra/` есть незакоммиченные изменения. Шлёт `git archive HEAD core adapters web infra`: без `.env`, `node_modules`, `docs/`, `CLAUDE.md`. На VPS это `/opt/unzeen/releases/<sha>`.
- `unzeenctl deploy <sha>` на VPS:
  1. `check-env`, том открыт;
  2. сборка образов `unzeen-{core,adapters,web,caddy}:<sha>`. Web — `pnpm build:public` с `NEXT_PUBLIC_API_MODE=real`, URL'ами API/WS трёх сетей, `NEXT_PUBLIC_HOOD=1`, pubkey аттестаций из `stack.env` и **пустым `NEXT_PUBLIC_FAIR_LAUNCH_BUILD`**: строгая проверка бандла падает, если в нём есть код fair-launch;
  3. по каждому инстансу: остановить relayer/scanner/intel → поднять pg → новый API. Он сам применяет миграции и проверяет схему по `schema-columns.txt`: если не сходится, API не станет healthy и деплой остановится с последними 30 строками лога. Затем сверка `max(schema_migrations.version)` с последним файлом `core/migrations/` релиза и переприменение `relayer-role.sql`/`indexer-role.sql`. Пароли ролей берутся из env и подаются через stdin psql, не через argv. Env — источник правды: `ALTER ROLE … PASSWORD` выполняется каждый раз;
  4. `current` → новый релиз, `up -d` остального, обновление `unzeen-*` в `/usr/local/sbin`;
  5. `check-proxy` (7.7).
- **Откат:** `sudo unzeenctl deploy <старый sha>` (релизы лежат в `/opt/unzeen/releases`, предыдущий — `/opt/unzeen/previous`). Миграции только вперёд: старый бинарь на новой схеме обычно работает (проверка схемы терпит лишние колонки), но если миграция что-то удаляла — откат только кодом вперёд.
- **28.10 после дедлайна (fair-launch):** в `stack.env` — `NEXT_PUBLIC_FAIR_LAUNCH_BUILD=1`, `WEB_BUILD_SCRIPT=build`, в `<inst>.env` — `UNZEEN_FAIR_LAUNCH=1` (только где нужно), затем `deploy.sh unzeen-vps`.
- Чистка: `docker image prune` (старые теги — `docker image ls 'unzeen-*'`).

Разовые операторские команды (RUNBOOK §4–6) на VPS — вместо `./core/target/release/…` и `pnpm …`:
```bash
sudo unzeenctl scanner mainnet address | wallet-balance | payout list-held | payout approve <id> | shield --dry-run | rebalance status
sudo unzeenctl api mainnet review-job | verify-snapshot --allow-mainnet | stats-snapshot --include-today --allow-mainnet
sudo unzeenctl tool mainnet keys:gen 2 | keys:attest | fees:sweep --dry-run
sudo ONEOFF_ENV="UNZEEN_ALLOW_MAINNET_SETUP=yes" unzeenctl tool mainnet meteora:config --send
sudo unzeenctl tool hood evm:keys 2
sudo unzeenctl psql mainnet ; sudo unzeenctl status ; sudo unzeenctl logs scanner-mainnet --since 30m
```
Это `docker run --rm` образа релиза с env инстанса, его томом и каталогом ключей (rw), в сети инстанса. `UNZEEN_DEV_PRINT` принудительно пуст. Флаги на один запуск — через `ONEOFF_ENV`: в env-файл их не пишем.

### 7.7 Прокси (Caddy): что гарантировано и как проверить
- **Access-логов нет совсем** (ни в одном сайте нет директивы `log`). Остальные логи — уровень ERROR, JSON-фильтр удаляет `remote_ip`, `client_ip`, порт, `uri`, заголовки, TLS-данные. Логгеры `http.stdlib` и `events` исключены: в первом адрес клиента зашит в текст сообщения, во втором — в `client_hello`. Проверено 18.10 локально на уровне DEBUG: 0 вхождений IP или пути.
- `X-Forwarded-For`, `X-Forwarded-Host/Proto`, `Forwarded`, `X-Real-IP` срезаются до upstream (проверено эхо-сервером: пусто).
- **Сжатия на API-хостах нет вообще** (`encode` только на web-хосте). Это строже, чем требует RELAYER.md: исключаем все пути, а не только паддированные. Ответ core `Cache-Control: no-transform` дополнительно защищает от посредников.
- CSP фронта ставит `next.config.ts`, Caddy его не трогает. На API-хостах — `default-src 'none'; frame-ancestors 'none'` (если core не прислал свой; у `/media` свой sandbox-CSP), HSTS, nosniff, `Referrer-Policy: no-referrer`, без `Server`/`Via`.
- WS `/ws/feed` проксируется на том же origin (проверено: 101). Если инстанс лежит — JSON `503 unavailable`; при превышении лимита — `429 rate_limited` + `Retry-After`.
- `/media/*` отдаёт core на origin своей сети (https) — это база метаданных токенов (GAP-5).
- Проверка после деплоя (на VPS, запросы идут через Caddy на 127.0.0.1 с настоящими именами):
  ```bash
  sudo unzeenctl check-proxy          # portfolio, actions (POST), actions/:id, verify/proof, creator, chat, feed: нет Content-Encoding
  # с Mac, снаружи:
  curl -sI -H 'Accept-Encoding: gzip, br' https://<API_MAINNET_HOST>/api/tokens/<mint>/chat | grep -i content-encoding   # пусто
  ```

### 7.8 Мониторинг (`unzeen-monitor`, таймер раз в 5 мин, root)
- Канал: Telegram-бот. `/etc/unzeen/monitor.env`: `TG_BOT_TOKEN`, `TG_CHAT_ID` (0600). Токен попадает в curl только через stdin-конфиг и в argv не виден. Можно добавить `ALERT_CMD` (свой скрипт, сообщение на stdin). Внешних SaaS нет. Проверка канала: `sudo unzeen-monitor --test`; что ушло бы прямо сейчас: `sudo unzeen-monitor --dry-run`.
- Проверки: **том заперт** (после ребута); диск ≥ 85 % (корень и том); caddy/web/каждый сервис инстанса не запущен; `GET 127.0.0.1:808x/api/pool` ≠ 200; строки `ALERT:` в логах api/scanner с прошлого прогона (needs_review, выплаты выше капа, refund 1Click, reorg …); нет `scan pass` сканера 15 мин; `relayer_jobs` в `needs_review`; выплаты ZEC в очереди > 30 мин сверх `not_before` (в том числе выше капа) и `sent` > 2 ч; самая свежая цена токена старше 15 мин (`stale_price` для buy/sell); снимок `pool_sol_inventory` старше 30 мин.
- Что в тексте: только имя проверки, сеть и счётчик (`mainnet: 1 relayer job(s) in needs_review`). Адресов, txid, сумм и ключей нет. Повтор неразрешённого алерта — раз в 6 ч, при исправлении приходит «resolved».
- Telegram узнаёт, что у этого сервера есть алерты (метаданные оператора, не пользователей). Если это не устраивает — только `ALERT_CMD` (например, локальный `msmtp`).

### 7.9 Перенос devnet-стенда с Mac (рекомендую, иначе нужен новый TAZ)
Фаусет даёт 0.125 TAZ в сутки. Свежий devnet-пул на VPS = пустой кошелёк и пустые vault. Перенос сохраняет кошелёк пула, vault с devnet-SOL, токены и историю:
1. На Mac **остановить все devnet-сервисы** (scanner, API, relayer, intel). Два сканера с одним кошельком = двойные выплаты: `serve.lock` локальный и про другой хост не знает.
2. `docker compose -f infra/docker-compose.yml --env-file .env exec -T postgres pg_dump -U unzeen -d unzeen -Fc > /tmp/devnet.dump` (файл содержит реестр — передать по scp и сразу удалить).
3. Состояние: `~/.unzeen/test/` и `~/.unzeen/devnet/` (`solana/`, `media/`) → `/srv/unzeen/devnet/home/{test,devnet}/` (`rsync -a` по ssh, затем `chown -R 10001:10001`). Ключи: `~/.unzeen/seed.agekey` → `/etc/unzeen/keys/devnet/seed.agekey`, `~/.unzeen/solana-devnet.agekey` → `…/solana.agekey`, `~/.unzeen/devnet/{chat,scenario}.key` → `…/{chat,scenario}.key` (0600, uid 10001). **До** `unzeenctl keys devnet`, чтобы не создались новые.
4. На VPS: `unzeenctl keys devnet` (создаст только pg-password и URL'ы БД) → поднять `pg-devnet` (`sudo unzeenctl deploy <sha>` его поднимет; либо сначала `docker compose … up -d pg-devnet`) → `pg_restore` в него → `deploy`.
5. Картинки старых devnet-токенов были с базой `http://127.0.0.1:8080/media` и на VPS станут глифами (как в 1.9) — ожидаемо.
6. После переноса devnet на Mac не запускать (или только с другой БД и другим кошельком).

### 7.10 Чеклист «день деплоя»
**Владелец (до):** купить VPS (7.1, без бэкапов/снапшотов, SSH-ключ), решить домен (7.2) и прописать DNS, создать Telegram-бота, подготовить пароль тома в менеджере паролей.

| # | Кто | Шаг | Проверка |
|---|---|---|---|
| 1 | лид/агент | закоммитить `infra/deploy/` (сейчас без коммита) | `git status` чистый |
| 2 | владелец | `scp` + `bootstrap.sh` (7.3), вход как `unzeen` в новом терминале | `ssh unzeen-vps sudo docker ps` |
| 3 | владелец | `ssh -t unzeen-vps sudo unzeen-vault-init 40`, заголовок LUKS — в офлайн-бэкап | `sudo unzeenctl status` → volume unlocked |
| 4 | владелец | `/etc/unzeen/stack.env` (хосты), `monitor.env` (бот) | `sudo unzeen-monitor --test` пришло |
| 5 | владелец | (если перенос devnet) 7.9 шаги 1–3 | файлы на месте, Mac-devnet остановлен |
| 6 | владелец | заполнить `__SET__` в `devnet.env`/`mainnet.env`/`hood.env` (RPC, ключи провайдеров, `UNZEEN_BIRTHDAY` = текущая высота mainnet) | — |
| 7 | агент по SSH | `sudo unzeenctl keys devnet`, `… keys mainnet`, `… keys hood`, затем `sudo unzeenctl check-env` (`UNZEEN_REBALANCE_*_ADDRESS` пустые и `UNZEEN_REBALANCE=0` до шага 10 — так в шаблоне) | check-env ok |
| 8 | агент | `deploy.sh unzeen-vps` (первая сборка 20–40 мин). Пока ключей mainnet/hood нет, можно временно `UNZEEN_INSTANCES=devnet` | `unzeenctl status`, `check-proxy` |
| 9 | владелец | mainnet: `sudo unzeenctl stop scanner-mainnet` → `sudo unzeenctl scanner mainnet init` (печатает UA) → `sudo unzeenctl start scanner-mainnet`. То же для hood (`scanner hood init`) | `/api/pool` mainnet/hood = 200 |
| 10 | владелец | Solana mainnet: `tool mainnet keys:gen 2` (age-идентичность уже создана `unzeenctl keys`) → `tool mainnet keys:attest` (адрес `rebal` → `UNZEEN_REBALANCE_SOL_ADDRESS` и `UNZEEN_REBALANCE=1`, `verify` → `NEXT_PUBLIC_ATTESTATION_PUBKEY_MAINNET`). Hood: `tool hood evm:keys 2` (`rebalance-0` → `UNZEEN_REBALANCE_ETH_ADDRESS` и `UNZEEN_REBALANCE=1`, `attest` → `NEXT_PUBLIC_ATTESTATION_PUBKEY_HOOD`). Devnet pubkey — `tool devnet keys:attest` | — |
| 11 | владелец | офлайн-бэкап `/etc/unzeen/keys/*` и сидов | — |
| 12 | агент | `deploy.sh unzeen-vps` (рестарт с адресами ребаланса, web с pubkey) | `/verify` «pinned» в трёх сетях |
| 13 | агент | снаружи: `curl -sI` без Content-Encoding (7.7), CSP в браузере без ошибок, WS-лента живая, переключатель сетей | — |
| 14 | агент | аудит логов: `sudo unzeenctl logs <svc> --since 1h \| grep -E '0x[0-9a-f]{40}\|[1-9A-HJ-NP-Za-km-z]{43,44}\|[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+'` по всем сервисам — пусто | — |
| 15 | владелец | пре-флайт mainnet-прогона (`docs/submission/mainnet-demo-run.md` §1.6) уже на VPS: команды из 7.6 вместо локальных | — |
| 16 | владелец | тест ребута: `sudo reboot` → алерт «LOCKED» в Telegram → `unzeen-unlock` → `status` | всё healthy |

**Агенты по SSH** делают шаги 7, 8, 12–14 и read-only проверки. Агентам не поручать: пароль тома, заполнение секретов, генерацию и бэкап ключей, `init`, любые mainnet-траты и флаги `UNZEEN_ALLOW_MAINNET_*`.

### 7.11 Фронт
Правок в `web/` не нужно: все URL'ы, WS, pubkey аттестаций, `NEXT_PUBLIC_HOOD`, `NEXT_PUBLIC_SITE_URL` и CSP (`connect-src`/`img-src` из `NEXT_PUBLIC_API_URL_*`) уже берутся из env сборки. Пожелание на потом (не блокер): `output: "standalone"` в `next.config.ts` уменьшит образ web (сейчас в рантайм копируется весь `node_modules`).

### 7.12 Риски и ограничения
- **Ребут = простой** до ручного `unzeen-unlock` (это решение N2). unattended-upgrades сами не перезагружают. Обновления ядра ставит владелец, в окно без судей.
- **Сборка на VPS** держит 4–6 GB RAM 15–30 мин. На 8 GB без свопа возможен OOM, поэтому берём 16 GB. Своп на незашифрованном диске — утечка памяти процессов, держим его выключенным.
- `caddy-ratelimit` собирается с последней версии плагина (`CADDY_RATELIMIT_VERSION=latest`). После первой удачной сборки зафиксировать версию в `caddy.Dockerfile`.
- `sslip.io` и mainnet-launch несовместимы без Pinata (7.2).
- Docker в группе `unzeen` = root-доступ. Ключ SSH владельца — фактически ключ от пула.
- Логи наших сервисов чистые по коду (аудиты day2–14), но `docker logs` хранит до 30 MB на контейнер. В шаге 14 аудит логов делаем после первого часа работы.
- Индексатор и API монтируют `home` инстанса на запись (индексатор читает `creator-pubkeys.json`). Сузить до read-only — после проверки, что intel ничего туда не пишет.

### 7.13 Текущий VPS (18.10)
- Contabo, `169.58.209.71`, Ubuntu 24.04.5 x86_64, 6 vCPU, 11 GiB RAM, 96 GB, свопа нет. Вход: `ssh -i ~/.ssh/unzeen_vps_ed25519 unzeen@169.58.209.71` (root по SSH выключен, пароли выключены).
- Агентов бэкапа или снапшотов провайдера в ОС нет: нет qemu-guest-agent, нет пакетов backup/Acronis, из сервисов только стандартные Ubuntu. **Владельцу проверить в панели Contabo**: не заказан ли add-on «Auto Backup» и нет ли сделанных снапшотов (Snapshots). Если есть — удалить.
- Хосты (sslip.io, домена нет): `169-58-209-71.sslip.io`, `api-devnet.169-58-209-71.sslip.io`, `api-mainnet.…`, `api-hood.…`. Mainnet-launch — только после `PINATA_JWT` (7.2).
- Bootstrap пройден в обе фазы. ufw 22/80/443 включён, fail2ban активен, монитор работает (`--dry-run` видит «volume LOCKED»). Тома ещё нет.
- Пробная сборка `a76d935e3711-wip`: все 4 образа за ≈4 мин при `CARGO_BUILD_JOBS=4`, пик 3.25 GB RAM. Core против одноразового Postgres: миграции применены, `/api/feed` 200. `deploy.test.sh` на VPS: всё ok. Это сборка рабочего дерева с чужими незакоммиченными правками — только проверка, не деплой.
