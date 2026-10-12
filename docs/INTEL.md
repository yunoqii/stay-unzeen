# Unzeen — контракт core ↔ индексатор токенов

Источник правды для `core/` (Rust, API) и индексатора (`adapters/`, TS). Меняет backend по согласованию с лидом. Схема: `core/migrations/0007_intel.sql` (применяет core при старте; индексатор миграции **не** запускает и схему не меняет). Публичная сторона — `docs/API.md` v0.5, раздел «Безопасность токена и лента сделок». Обоснование схемы (тик, приманки, warm set) — `docs/analysis/token-intel.md` §2.

Статус: **v2** (12.10, ордера; миграция `0011_orders.sql`). Изменения против v1:
- **Ценовой проход и `intel_prices`.** На **каждом** тике индексатор читает кривые **всех** `intel_warm.pinned` mint (токены пула) и пишет цены в `intel_prices` в той же транзакции тика. Из них core исполняет приватные ордера (API.md v0.8). Набор опрашиваемых mint от ордеров **не зависит** — ордера не порождают ни одного RPC-запроса.

Статус v1: 12.10, дни 6–7.

## Кто что делает

```
 web ── GET /api/tokens/:mint[/safety] ──▶ core (API)
                                            │ нет снимка → INSERT intel_requests (mint), 202 pending
                                            │ есть снимок → 200 из token_safety / intel_tokens
                                            │ раз в 60 с: intel_warm ← tokens, trades(create), mint_vaults (pinned, hot)
                                            ▼
                         intel_requests, intel_warm ◀── читает ── индексатор (TS, Shyft Free)
                                                                   │ тик 45–75 с: пачка 8 mint = ≤ 4 запроса + приманки
                                                                   │ + обновление части warm set по расписанию
                                                                   ▼
                         token_safety, intel_tokens, intel_warm.expires_at, intel_meta (одной транзакцией на тик)
```

- **core** принимает публичные запросы, ставит холодные mint в очередь, держит «закреплённую» часть warm set, собирает ответ API и **сам применяет T1** (для Unzeen-запусков вырезает `dev`, ставит `devPct = null`, добавляет `unzeen.rules`). core в RPC Solana не ходит.
- **индексатор** — единственный, кто читает Solana для token intel (Shyft Free, `docs/STACK.md`). Пишет только снимки по тику. Про anon-ключи, реестр и действия ничего не знает и доступа к ним не имеет.
- **релейер** не меняется: пишет `tokens`/`trades` только по сделкам пула (`docs/RELAYER.md`).

## Приватность (обязательно для индексатора)
1. **Расписание не зависит от запросов.** Тик — по своему таймеру, интервал случайный равномерный **45–75 с** (60 ± 15). Запрос пользователя не будит индексатор и не ускоряет тик. Просмотры страниц не меняют частоту обновления warm set.
2. **Пачка фиксированного размера 8**, отправляется **на каждом тике, даже если очередь пуста** (тогда 8 приманок; Shyft Free без кредитов, это ~10 вызовов в минуту). Настоящих mint в пачке ≤ 4 (остальные ждут следующего тика), остальное — приманки. Порядок внутри пачки случайный. Сторонний RPC видит одинаковый поток каждую минуту и не может отличить искомый mint от приманки.
3. **Приманки:** случайные mint из свежих create pump.fun (последние ~50 create программы `6EF8…`, индексатор ведёт сам) и случайные mint warm set; если свежих create нет — только из warm set. Приманка обрабатывается **ровно как настоящий запрос**: тот же набор RPC-вызовов, снимок пишется, `intel_warm.expires_at = now() + 7 дней`. Поэтому `200` на «случайный» mint не доказывает, что его кто-то искал.
4. **Нигде не хранить, что было запросом, а что приманкой.** Ни колонки, ни лога, ни метрики «real/decoy». В логах — только номер тика, размер пачки (всегда 8), длительность, коды ошибок RPC. Никаких mint в логах.
5. **Время только по тику.** `token_safety.as_of`, `holders.asOf`, `intel_tokens.as_of` = момент начала тика, **округлённый вниз до минуты**. Все записи снимков — только в транзакции тика (обновления из подписок копятся в памяти и сбрасываются на ближайшем тике).
6. **Никогда не писать в `tokens` и `trades`** (роль этого не позволит): публичный `/api/tokens` строится только из токенов пула, найденные mint туда не попадают (API v0.5, ответ лида (а)).
7. **T1.** Для Unzeen-запусков (mint, у которого в `trades` есть строка `kind = 'create'`) не считать и не писать `holders.devPct`, `dev`, теги `dev`; `firstBlocks.unzeenLaunchBuy = true`, наша launch-покупка не идёт в `sameSlot*`/`snipers`. core это всё равно перепроверяет и вырезает, но индексатор не должен даже вычислять.
8. **Метаданные и картинки** — только при попадании mint в пачку тика или в warm set (не по клику): `https://` и `ipfs://` (IPFS → один наш шлюз), таймаут 3 с, ≤ 64 КБ JSON, без редиректов, блок RFC1918/loopback/link-local/`169.254.169.254` после DNS. Картинка — тем же пайплайном, что `adapters/src/metadata.ts` (без SVG, ≤ 512 КиБ), публикуется в `UNZEEN_MEDIA_DIR` (имя `<sha40>.<ext>`) и в снимок пишется **только** `${UNZEEN_METADATA_BASE_URL}/<sha40>.<ext>`. core отбрасывает `image`, путь которого не оканчивается на `/media/<sha40>.(png|jpeg|jpg|webp)`.
9. **Соцсети** — только нормализованные `https://` ссылки: `twitter` (x.com / twitter.com), `telegram` (t.me), `website` (любой https). Без превью, favicon, OG.
10. Один инстанс индексатора на БД: на старте `SELECT pg_try_advisory_lock(8461835325787734023)` (`0x756e7a65656e0007`); `false` → выход.

## Таблицы (0007)

### `intel_requests` — очередь холодных CA
| Поле | Кто пишет | Смысл |
|---|---|---|
| `mint` (PK) | core | base58 mint из `/api/tokens/:mint` или `/safety`, для которого нет снимка |
| `queued_at` | core | округлено до минуты; только для порядка |

- core вставляет `ON CONFLICT DO NOTHING`, очередь ограничена `UNZEEN_INTEL_QUEUE_MAX` (по умолчанию 256) — сверх лимита запрос остаётся `202` и не ставится (клиент повторит). Ни IP, ни времени запроса с точностью выше минуты, ни счётчика повторов.
- индексатор: в начале тика `SELECT mint FROM intel_requests ORDER BY queued_at, random() LIMIT 4`, в транзакции записи снимков — `DELETE FROM intel_requests WHERE mint = ANY($1)`. Если тик упал — строки остаются, будут в следующем.

### `intel_warm` — тёплое множество
| Поле | Кто пишет | Смысл |
|---|---|---|
| `mint` (PK) | оба | |
| `pinned` | core | `true` — токен пула: есть в `tokens` или `mint_vaults` (позиции пула, Unzeen-запуски). Не истекает |
| `hot` | core | `true` — сделка пула по mint за последний час (обновлять каждые 5 мин, иначе 30 мин) |
| `expires_at` | индексатор | для mint пачки тика (запрос или приманка): `now() + 7 days` (`GREATEST` с текущим). NULL у закреплённых |

- core раз в 60 с синхронизирует `pinned`/`hot` и удаляет истёкшие незакреплённые строки, а вместе с ними их `token_safety`/`intel_tokens` (если mint не в `tokens`). Снимки `missing` старше 1 ч core удаляет (mint снова можно искать).
- индексатор: `INSERT INTO intel_warm (mint, expires_at) VALUES ($1, now() + interval '7 days') ON CONFLICT (mint) DO UPDATE SET expires_at = GREATEST(intel_warm.expires_at, EXCLUDED.expires_at)`.
- Обновление warm set: на каждом тике, кроме пачки, — до 20 mint warm set с самым старым снимком, у которых снимок старше 5 мин (`hot`) / 30 мин (остальные) или его нет; порядок случайный. Mint без снимка (новый токен ленты) — первыми. Top-10 холдеров (`getTokenLargestAccounts`) — по тому же расписанию.

### `token_safety` — снимок для `GET /api/tokens/:mint/safety`
| Поле | Кто пишет | Смысл |
|---|---|---|
| `mint` (PK) | индексатор | |
| `as_of` | индексатор | минута тика (`date_trunc('minute', …)`; CHECK в схеме) |
| `missing` | индексатор | `true` — аккаунта mint нет / владелец не SPL Token и не Token-2022 → API отдаёт 404 |
| `data` | индексатор | JSONB, поля `TokenSafety` (API.md) **кроме** `mint`, `asOf`, `unzeen` — их ставит core. NULL при `missing` |

`data` (camelCase, как в API.md):
```jsonc
{
  "program": "spl-token" | "token-2022",
  "authorities": { "mintRevoked": bool, "freezeRevoked": bool, "metadataImmutable": bool | null,
                   "riskyExtensions": ["permanentDelegate" | "transferHook" | "transferFee" | "defaultFrozen" | "mintClose" | "pausable"] },
  "holders": { "top10Pct": "12.5", "devPct": "3.1" | null, "unzeenPoolPct": "0.8" },   // необязательно; asOf ставит core = as_of
  "market": { "venue": "pumpfun" | "meteora-dbc" | "jupiter", "status": "curve" | "graduated",
              "curveProgressPct": "41.2", "lpBurnedPct": "100" },                     // проценты — десятичные строки
              // meteora-dbc: lpBurnedPct = доля LP, заблокированного навсегда (позиция DAMM v2), а не сожжённый LP-mint
  "socials": { "twitter": "https://x.com/…", "telegram": "https://t.me/…", "website": "https://…" },  // необязательно
  "image": "https://<api origin>/media/<sha40>.png",                                  // необязательно
  "dev": { "address": "…", "launchesSeen": 3, "rugsSeen": 1, "since": 1760000000000 }, // только с историей дева (флаг), не для Unzeen-запусков
  "firstBlocks": { "snipers": 2, "sniperPct": "4.0", "sameSlotBuyers": 0, "sameSlotPct": "0", "unzeenLaunchBuy": false } // только с полной лентой
}
```
- `top10Pct` — без `associated_bonding_curve`, base-vault пула AMM, `mayhem_token_vault` и **всех vault пула Unzeen**; `unzeenPoolPct` — сумма по vault пула. Делить на текущий саплай mint.
- Список vault пула: `SELECT DISTINCT vault FROM relayer_vault_usage` ∪ `SELECT DISTINCT vault FROM mint_vaults` (+ конфиг адаптеров).
- core пропускает только перечисленные ключи с правильными типами, проценты — строки вида `^\d{1,3}(\.\d{1,4})?$`; лишнее отбрасывает.

### `intel_tokens` — карточка `Token` для mint, которого нет в `tokens`
Колонки как у `tokens` (`venue`, `symbol`, `name`, `image`, `decimals`, `status`, `price_sol`, `market_cap_sol`, `created_at`) + `as_of`. Пишет индексатор в той же транзакции тика, что `token_safety` (без `missing`). `venue = 'jupiter'`, если mint не на кривой pump.fun / Meteora DBC. `created_at` — время create on-chain, если известно, иначе `as_of`. core использует её только для `GET /api/tokens/:mint` (`trades: []`), свечей и `/trades` (`[]`); в `GET /api/tokens` она **не участвует**.

### `intel_subscriptions` — состояние подписок индексатора
`account` (PK), `mint`, `kind` (`pump_curve` | `dbc_pool` | `pumpswap_pool`), `since`. Пишет и читает только индексатор (переподписка после рестарта). `accountSubscribe` — только на аккаунты mint из warm set с `hot = true` (кривая / пул), снимаются, когда mint вышел из warm set или остыл. Данные из подписок — только в память до тика.

### `market_trades` — полная лента сделок (за флагом)
Пишет индексатор **только** при `UNZEEN_INTEL_FULL_TRADES=1` (после перехода на тариф с потоком, ~день 9). Пока флаг выключен, таблица пуста и core отвечает `400 feature_disabled` на `filter=whales|dev`.
| Поле | Смысл |
|---|---|
| `id` | bigserial, id `TokenTrade` |
| `mint`, `kind` (`buy`/`sell`), `venue`, `symbol`, `decimals` | как в `trades` |
| `trader` | публичный адрес подписанта сделки |
| `unzeen` | `true` — сделку сделал vault пула (тогда в API `trader = "unzeen"`) |
| `tags` | подмножество `{whale, dev, sniper}`; `dev` запрещён при `unzeen` (CHECK) и для Unzeen-запусков (core вырезает) |
| `token_amount`, `sol_amount` | базовые единицы / лампорты |
| `signature`, `ix`, `slot`, `ts` | `ix` — номер события в tx; `UNIQUE (signature, ix)`; `ts` — blockTime |

`whale`: `sol_amount ≥ UNZEEN_WHALE_LAMPORTS` (по умолчанию 1 SOL, тот же порог core применяет к сделкам пула).

### `intel_prices` — цена с тика (v2, для ордеров)
| Колонка | Смысл |
|---|---|
| `mint` | PK, только `pinned` mint (токены пула) |
| `price_sol` | `NUMERIC > 0`: SOL за 1 целый токен. pump.fun: `(virtual_sol_reserves / 1e9) / (virtual_token_reserves / 10^decimals)` из аккаунта кривой |
| `status` | `curve` \| `graduated` (`complete` кривой → `graduated`, цена — последняя на кривой) |
| `tick_at` | unix мс этого тика (= `intel_meta.last_tick_at`, который пишется в той же транзакции) |
| `prev_price_sol`, `prev_tick_at` | значение предыдущего тика, где этот mint был прочитан (core проверяет «2 тика подряд» для stop-loss: `prev_tick_at` = тик, на котором SL взвёлся) |

Запись (в транзакции тика, одна строка на mint):
```sql
INSERT INTO intel_prices (mint, price_sol, status, tick_at) VALUES ($1, $2, $3, $4)
ON CONFLICT (mint) DO UPDATE SET prev_price_sol = intel_prices.price_sol, prev_tick_at = intel_prices.tick_at,
  price_sol = EXCLUDED.price_sol, status = EXCLUDED.status, tick_at = EXCLUDED.tick_at
WHERE intel_prices.tick_at < EXCLUDED.tick_at;
```
- Проход: `getMultipleAccounts` по PDA кривых всех `pinned` (≤ 100 на вызов; при десятках токенов пула это 1–2 вызова на тик). Для `hot` mint можно взять последнее значение подписки, если оно свежее начала тика.
- Ошибка RPC по mint — строку не трогать (core считает старую цену «этим же тиком» и не срабатывает повторно). Ошибка всего прохода — `intel_prices` в этом тике не пишется.
- История не хранится: только текущее и предыдущее значение. Логи — без mint и цен.

### `intel_meta` — расписание
| key | value | Кто пишет |
|---|---|---|
| `next_tick_at` | unix мс следующего тика (десятичная строка) | индексатор, в транзакции тика и при старте |
| `last_tick_at` | unix мс начала последнего тика | индексатор |

core считает `retryAfterMs = next_tick_at − now + 10 000` (запас на обработку), минимум 1 000. Если `next_tick_at` нет или он в прошлом больше чем на 30 с (индексатор не работает) — `60 000`, ответ всё равно `202`.

## Тик индексатора (порядок)
1. `t = now()`; `asOf = floor_minute(t)`.
2. `real = SELECT … FROM intel_requests … LIMIT 4`; приманки до 8; перемешать.
3. RPC (Shyft): `getMultipleAccounts` (mint + PDA кривой/пула по всей пачке), `getTokenLargestAccounts` по каждому mint пачки, `getMultipleAccounts` владельцев token-аккаунтов; метаданные/картинки по правилам выше. Затем до 20 mint warm set по расписанию. Не больше ~5 rps.
4. Ценовой проход (v2): кривые всех `pinned` mint одним-двумя `getMultipleAccounts`.
5. Одна транзакция: `token_safety` / `intel_tokens` (upsert, `as_of = asOf`), `intel_prices` (v2, `tick_at = t`), `intel_warm.expires_at` для всей пачки, `DELETE intel_requests` для `real`, `intel_meta` (`last_tick_at = t`, `next_tick_at = t + U(45,75) с`).
6. Ошибка RPC по одному mint — снимок этого mint не пишется (старый остаётся), запрос остаётся в очереди; по всей пачке — тик пропускается целиком, `next_tick_at` всё равно обновляется.

## Роль Postgres `unzeen_indexer`
`infra/indexer-role.sql` (идемпотентный, перезапускать после новых миграций), подключение по `DATABASE_URL_INDEXER`. Владельческий `DATABASE_URL` и `DATABASE_URL_RELAYER` индексатору не давать.

| Таблица | Права |
|---|---|
| `intel_requests` | SELECT, DELETE |
| `intel_warm` | SELECT, INSERT (`mint`, `expires_at`), UPDATE (`expires_at`) |
| `token_safety`, `intel_tokens`, `intel_subscriptions`, `intel_meta` | SELECT, INSERT, UPDATE, DELETE |
| `intel_prices` (v2) | SELECT, INSERT, UPDATE |
| `market_trades` | SELECT, INSERT, UPDATE (`tags`); sequence USAGE |
| `tokens`, `trades`, `mint_vaults`, `relayer_vault_usage` | только SELECT |
| всё остальное (`actions`, `balances`, `deposits`, `creator_tokens`, `relayer_jobs`, журналы, `pool_meta`, …) | нет доступа |

На старте индексатор проверяет `SELECT has_table_privilege('creator_tokens','SELECT') OR has_table_privilege('tokens','INSERT')` и при `true` отказывается стартовать (значит, дали не ту роль).

## Контрольный список для индексатора
- [ ] Роль `unzeen_indexer`, advisory lock, отказ стартовать с лишними правами.
- [ ] Тик 45–75 с по своему таймеру; пачка всегда 8, ≤ 4 настоящих, случайный порядок; приманки обрабатываются так же.
- [ ] (v2) Ценовой проход по **всем** `pinned` на каждом тике → `intel_prices` в транзакции тика; набор не зависит ни от чего, кроме `pinned`.
- [ ] Все записи снимков — в транзакции тика, `as_of` = минута тика; `next_tick_at` обновляется каждый тик.
- [ ] Никаких записей в `tokens`/`trades`; никаких логов с mint и признаком «запрос/приманка».
- [ ] T1: для mint с `trades.kind = 'create'` — без `devPct`/`dev`/тега `dev`, `unzeenLaunchBuy = true`.
- [ ] `image` — только наш `…/media/<sha40>.<ext>`; соцсети — только https; SSRF-защита при фетче `uri`.
- [ ] `market_trades` — только при `UNZEEN_INTEL_FULL_TRADES=1`.
