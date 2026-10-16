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
- Запрос UTXO и отправка идут через `LIGHTWALLETD_SEND_URL` (если задан), не через сервер сканирования: тот не узнаёт t-адрес пула. Сумма и t-адрес шилд-tx публичны (как любой t→z), адресат — нет.
- txid по умолчанию не печатается (`--show-txid`, если нужен). `--min-zat` (по умолчанию 20 000) — меньше не шилдит.
- Кошельки, созданные до 16.10 (локальный testnet-пул), прозрачного ключа не имеют: `address --transparent` отвечает «created before GAP-2». Mainnet-пулы (Solana и hood) создаются `init` этой сборкой — у них t-адрес есть. Обход для старого кошелька — только явный `UNZEEN_REBALANCE_REFUND_TADDR`.

### 6.2 `needs_review` → `unzeen-api review-job` (GAP-11)
```bash
./core/target/release/unzeen-api review-job                 # список: id, op, venue, сеть, суммы задания, возраст
./core/target/release/unzeen-api review-job 42 --show-signature   # одно задание + хеш tx для Blockscout/Solscan
./core/target/release/unzeen-api review-job 42 --reparse    # hood: отдать релейеру сейчас, он перечитает receipt из цепочки
./core/target/release/unzeen-api review-job 42 --confirm --out-token-amount N --out-lamports W [--out-mint M] [--slot B] --yes
./core/target/release/unzeen-api review-job 42 --fail --yes # ТОЛЬКО если tx не потратила средства: core вернёт ZEC
```
- Порядок: сначала `--reparse` (суммы из цепочки, не руками). Если через ~1 мин задание снова `needs_review` — смотреть tx в explorer и делать `--confirm` с фактами (wei/лампорты, базовые единицы токена) или `--fail`.
- `--confirm` проверяет суммы против задания: buy — потрачено ≤ `lamports_in` и токенов > 0; sell — продано ≤ `token_amount`; create — нужен `--out-mint`; transfer — ровно `token_amount`; `fund_vaults` — `--out-lamports`. `attest` руками не подтверждается (только `--reparse`/`--fail`). Пары с ZEC: `--out-quote-amount` + `--out-quote-mint` вместо `--out-lamports`.
- Меняет только задания в `needs_review` без `settled_at`. Если релейер успел разобрать сам — «left needs_review meanwhile», ничего не меняется. Дальше settler core закрывает действие за ~1 с.
- `--reparse` только для hood: Solana-релейер `needs_review` не пишет.

### 6.3 Meteora DBC и платформа LaunchLab «Unzeen» на mainnet (GAP-3, GAP-4; один раз на сеть, делает владелец)
1. `SOLANA_CLUSTER=mainnet-beta UNZEEN_ALLOW_MAINNET=yes pnpm meteora:config --simulate`, затем то же для `pnpm launchlab:platform --simulate`. Скрипты печатают адрес partner (он же fee claimer и admin платформы), сколько нужно и сколько не хватает. Ориентир: ≈0.008 SOL на конфиг и ≈0.0075 SOL на платформу, вместе ≈0.016 SOL.
2. Пополнить partner **из внешнего операторского кошелька**, как ключ `verify`. Никогда из vault и никогда с адреса ребаланса (публично связало бы торговые кошельки пула с fee claimer'ом). Скрипт на mainnet отказывает, пока денег не хватает.
3. `... UNZEEN_ALLOW_MAINNET_SETUP=yes pnpm meteora:config --send` и подтвердить, введя адрес partner (или `--confirm-mainnet <partner>`). Записать напечатанный `METEORA_DBC_CONFIG_MAINNET` в main.env, добавить `meteora-dbc` в `UNZEEN_VENUES`, перезапустить релейер и API.
4. То же для `pnpm launchlab:platform --send`. После перезапуска релейера WARN `LaunchLab platform unzeen switched off` пропадёт, create с `platform: "unzeen"` заработает (creator fee 0.30 %, у bonk 0). Пока платформы нет — create с `unzeen` получает `venue_unavailable` до подписи, запускать с `bonk`.
5. Снять `UNZEEN_ALLOW_MAINNET_SETUP`. Перед `--send` обязательно `--simulate` уже с пополненным partner.
