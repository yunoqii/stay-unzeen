# Unzeen — контракт core ↔ индексатор токенов

Источник правды для `core/` (Rust, API) и индексатора (`adapters/`, TS). Меняет backend по согласованию с лидом. Схема: `core/migrations/0007_intel.sql` (применяет core при старте; индексатор миграции **не** запускает и схему не меняет). Публичная сторона — `docs/API.md` v0.5, раздел «Безопасность токена и лента сделок». Обоснование схемы (тик, приманки, warm set) — `docs/analysis/token-intel.md` §2.

Статус: **v4** (18.10, API.md v0.28 «Trading comfort»; миграция `0035_trading_comfort.sql`). Изменения против v3:
- **Ценовой проход пишет прогресс и состояние кривой**: `intel_prices.progress_pct` (`NUMERIC(5,2)`, только на кривой) и `intel_prices.curve` (JSONB: `virtualSol`, `virtualTokens` — текущие резервы кривой / сегмента DBC, `feeBps` — комиссия сейчас (у pump.fun нет — уровень FeeConfig ставит core), `buyFee` `added|input|output`, `buyLimitLamports?`, `sellLimitTokens?`). Только SOL-пары на кривой. В тот же `getMultipleAccounts` добавлен Global pump.fun (прогресс), а для каждого pinned mint — PDA пула LaunchLab (mint, wSOL); конфиг и платформа LaunchLab — вторым вызовом, только если такие пулы есть; для DBC с активацией по слотам — один `getSlot` на проход. Набор mint по-прежнему только `pinned`, от пользователей не зависит. Права роли не меняются (UPDATE/INSERT на всю таблицу).
- **Discovery LaunchLab** (mainnet, Parsed Streams, `INTEL_DISCOVERY_LAUNCHLAB=0` выключает): create LaunchLab — кандидаты discovery (только SOL-пулы), метрики — пул (PDA mint/wSOL) и mint на тике. `intel_discovery.venue` += `raydium-launchlab`.
- **core** своим таймером (20 с) копирует прогресс с тиков в `curve_progress` (1 ч) и отмечает первые graduation в `curve_graduations` (7 сут) — для Pulse и ETA. Индексатор к этим таблицам доступа не имеет.

Изменения v3 против v2 (13.10, кабинет создателя API.md v0.9; миграции не меняются):
- **`holders.count`** в `token_safety.data` — целое число владельцев mint с ненулевым балансом (без `associated_bonding_curve`, base-vault пула AMM и `mayhem_token_vault`; vault пула Unzeen считаются как обычные владельцы). Читает только core для подписанного `GET /api/creator` (`CreatorToken.holders`); в публичный `TokenSafety` не выводится. **Пока `null`/нет ключа:** на тарифе Shyft Free нет `getProgramAccounts`, посчитать владельцев нечем; core тогда отдаёт `holders: null`. Включить после перехода на провайдера с GPA (или Helius DAS `getTokenAccounts`), в том же тике и с той же приманочной пачкой, что остальные поля.

Изменения v2 против v1 (ордера; миграция `0011_orders.sql`):
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
8. **Метаданные и картинки** — только при попадании mint в пачку тика (основного или карточек) или в warm set (не по клику): `https://` и `ipfs://` (IPFS → один наш шлюз; с 24.10 туда же переписываются ссылки на публичные шлюзы `https://ipfs.io/ipfs/<cid>`, `*.mypinata.cloud`, `dweb.link`, `<cid>.ipfs.<gw>` и т. п. — ipfs.io / dweb.link отвечают нашему VPS 429; шлюз по умолчанию `https://ipfs.filebase.io/ipfs`, `INTEL_IPFS_GATEWAY`; картинка, не скачанная из-за 429/таймаута, повторяется через 10 мин, а не через 6 ч; запросы к шлюзу/хостам метаданных — не чаще 0.9/с, всплеск 2 (`offchainRps`; Filebase отвечает 429 выше ~1/с), тик карточек слота не ждёт — без двух свободных слотов пишет карточку без фетча, его делает основной тик), таймаут 3 с, ≤ 64 КБ JSON, без редиректов, блок RFC1918/loopback/link-local/`169.254.169.254` после DNS. Картинка — тем же пайплайном, что `adapters/src/metadata.ts` (без SVG, ≤ 512 КиБ), публикуется в `UNZEEN_MEDIA_DIR` (имя `<sha40>.<ext>`) и в снимок пишется **только** `${UNZEEN_METADATA_BASE_URL}/<sha40>.<ext>`. core отбрасывает `image`, путь которого не оканчивается на `/media/<sha40>.(png|jpeg|jpg|webp)`.
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
  "holders": { "top10Pct": "12.5", "devPct": "3.1" | null, "unzeenPoolPct": "0.8",
               "count": 1234 },                                                       // необязательно; asOf ставит core = as_of; count (v3) — пока не пишется
  "market": { "venue": "pumpfun" | "meteora-dbc" | "raydium-launchlab" | "jupiter", "status": "curve" | "graduated",
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

| `next_card_at` | unix мс следующего тика карточек (v0.29) | индексатор, в транзакции тика карточек |

core считает `retryAfterMs = next_tick_at − now + 10 000` (запас на обработку), минимум 1 000; для `GET /api/tokens/:mint` — по `next_card_at` (+ 3 000), см. «Быстрая карточка». Если `next_tick_at` нет или он в прошлом больше чем на 30 с (индексатор не работает) — `60 000`, ответ всё равно `202`.

## Тик индексатора (порядок)
1. `t = now()`; `asOf = floor_minute(t)`.
2. `real = SELECT … FROM intel_requests … LIMIT 4`; приманки до 8; перемешать.
3. RPC (Shyft): `getMultipleAccounts` (mint + PDA кривой/пула по всей пачке), `getTokenLargestAccounts` по каждому mint пачки, `getMultipleAccounts` владельцев token-аккаунтов; метаданные/картинки по правилам выше. Затем до 20 mint warm set по расписанию. Не больше ~5 rps.
4. Ценовой проход (v2): кривые всех `pinned` mint одним-двумя `getMultipleAccounts`.
5. Одна транзакция: `token_safety` / `intel_tokens` (upsert, `as_of = asOf`), `intel_prices` (v2, `tick_at = t`), `intel_warm.expires_at` для всей пачки, `DELETE intel_requests` для `real`, `intel_meta` (`last_tick_at = t`, `next_tick_at = t + U(45,75) с`).
6. Ошибка RPC по одному mint — снимок этого mint не пишется (старый остаётся), запрос остаётся в очереди; по всей пачке — тик пропускается целиком, `next_tick_at` всё равно обновляется.

## Быстрая карточка (тик карточек, 24.10, API v0.29)
Цель: новый CA открывается за ≤ 10–15 с, токены Pulse — сразу. Полный снимок (холдеры, авторитеты, socials) остаётся на основном тике.

**Тик карточек** (`IntelIndexer.cardTick`, `INTEL_CARD_LANE=0` выключает):
1. Свой таймер, интервал случайный равномерный **6–10 с** (8 ± 2), не зависит от запросов и от основного тика; до первого основного тика (пул приманок, множества T1) пачка пустая.
2. Пачка **ровно 8**: ≤ 4 mint из `intel_requests`, которые ещё не проходили через тик карточек (память процесса; повторно настоящий mint в пачку карточек не попадает), остальное — приманки из свежих create pump.fun и warm set; порядок случайный. Отправляется на каждом тике карточек, даже при пустой очереди.
3. RPC: **один** `getMultipleAccounts` на read-провайдере (Shyft): mint + кривая + метаданные + пул (+ DBC) по всей пачке. Без `getTokenLargestAccounts` (Helius) и без второго чтения. Метаданные/картинка — те же правила п. 8 (зеркалирование в `/media`), удачный фетч кэшируется в памяти, основной тик его не повторяет.
4. Одна транзакция `commitCards`: `intel_tokens` (upsert, `image` не затирается на `null`), `token_safety.missing` только если строки ещё нет, `intel_warm.expires_at ≥ now() + 15 мин` для всей пачки (чтобы warm sync core не удалил карточки), `intel_meta.next_card_at`. **Не** пишет `token_safety`-снимков и **не** разбирает очередь.
5. Коммиты тика карточек и основного тика сериализованы в процессе (одни и те же таблицы).

**Основной тик при включённых карточках:** в пачку берутся только mint очереди, которые уже прошли тик карточек; приманки — из mint пачек карточек с прошлого основного тика (если их мало — как раньше). Так каждый mint основной пачки был в какой-то пачке карточек, и read-провайдер не может выделить «тот, кого не было в карточках». Index-провайдер (Helius) видит, как и раньше, только основную пачку 8.

**warm set:** mint без снимка обновляется в warm-проходе только если он `pinned` или кандидат discovery. Mint пачек карточек (15 мин в `intel_warm`) сюда не попадают: настоящие получают полный снимок в основной пачке, приманки просто истекают вместе с карточкой.

**API:** `GET /api/tokens/:mint` → `200` как только есть `intel_tokens`; `202.retryAfterMs = next_card_at − now + 3 000` (≥ 1 000), если `next_card_at` свежий (не старше 30 с), иначе по `next_tick_at`. `/safety` — по-прежнему по основному тику. Фронт: страница открывается по `200` токена, pending — только в панели безопасности.

## Discovery → warm set (24.10)
Кандидаты discovery (`Discovery.activeMints()`, публичный поток create, набор не зависит от пользователей; RPC-провайдер discovery их уже видел) на каждом основном тике добавляются в warm set: новейшие первыми, не больше **250** (`DISCOVERY_WARM_MAX`; discovery сам ограничен 200 / 6 ч). В транзакции тика — `intel_warm.expires_at ≥ now() + 1 ч` (продлевается, пока кандидат активен; после выхода из discovery истекает через час, если mint не продлён пачкой). Без снимка — первыми в warm-проходе (≤ 20 mint за тик), т. е. новый кандидат снимается на ближайшем-следующем тике (≤ ~2 мин после допуска): снимок, safety, метаданные, картинка в `/media` → `PulseToken.image` и `200` у `/api/tokens/:mint` без 202. Дальше — по обычному расписанию warm set (30 мин); кандидат, у карточки которого ещё нет картинки (шлюз ответил 429/таймаут), — раз в 10 мин.

**Кредиты.** warm-проход ограничен 20 mint за тик и на mainnet уже насыщен (`warm=20` каждый тик), поэтому discovery вытесняет старые приманки warm set, а не добавляет вызовов: Helius `getTokenLargestAccounts` ≈ 28 / тик (8 пачка + 20 warm) ≈ 1 700 / ч ≈ 40 тыс. / сутки — как до изменения. Тик карточек — 0 вызовов Helius, ~450 `getMultipleAccounts` / ч на Shyft (42 ключа в вызове, ≤ 1 вызов за 6–10 с). 200 кандидатов × 2 снимка / ч = ~400 из ~1 200 warm-слотов в час.

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
- [ ] Тик карточек 6–10 с по своему таймеру; пачка всегда 8, ≤ 4 настоящих, только `getMultipleAccounts`, только карточки; настоящий mint в пачке карточек один раз; основная пачка — только из прошедших карточки.
