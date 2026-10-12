# Unzeen — контракт core ↔ relayer

Источник правды для `core/` (Rust, API + реестр) и релейера (`adapters/`, TS). Меняет backend по согласованию с лидом. Схема: `core/migrations/0002_relayer.sql`, `0003_payouts_epochs.sql`, `0004_relayer_state.sql`, `0005_exec_mode.sql`, `0006_exec_mode_scrub.sql` (применяет core при старте; релейер миграции **не** запускает и схему не меняет).

Статус: **v2** (12.10, дни 4–5). Изменения против v1:
1. **Подключение только под ролью `unzeen_relayer`** через `DATABASE_URL_RELAYER` (D8). Владельческий `DATABASE_URL` релейеру не давать. На старте релейер проверяет `SELECT has_column_privilege('relayer_jobs','action_id','SELECT')` и при `true` отказывается стартовать.
2. **Режимы исполнения, колонка `exec_mode` (0005, `now` | `delayed` | `max`).** Для `delayed`/`max` core ставит `not_before` = ближайшая граница эпохи (интервалы случайные 30–60 с / 5–15 мин; расписание не зависит от прихода запросов). Задания одной эпохи имеют одинаковый `not_before`: релейер берёт всё готовое разом и исполняет в случайном порядке, свой джиттер не добавляет. Для `now` (только buy/sell/create) `not_before` = момент приёма: релейер исполняет сразу. Priority fee — **единый квантованный compute unit price на ВСЕ tx пула** (любого режима, по Helius `getPriorityFeeEstimate`), чтобы tx режима now не выделялись комиссией. **Jito для now не используется** (Jito остаётся только для fair-launch). Юзер платит плоскую `nowFeeZat` core-у, на сумму `lamports_in` это не влияет. `transfer` всегда `delayed`/`max`. При settle core обнуляет `exec_mode` (0006).
3. **Backoff через `not_before`.** Роли выдан `UPDATE (not_before)`; триггер `relayer_jobs_not_before_monotonic` (0003) разрешает только **увеличение** (`check_violation` при попытке сдвинуть раньше). Ранний запуск = нарушение тайминга.
4. **Позиция по mint на одном vault (D4, решение владельца).** Таблица `mint_vaults (network, mint, vault)`: релейер закрепляет mint за vault при первой покупке/запуске и ведёт через него все buy/sell/transfer этого mint. Правило «вывод с другого vault» **снято** (vault публичны и связаны графом пополнений, приватности не добавляло). Поле `avoid_vaults` в задание **не добавлено**: при общем инвентаре оно не нужно.
5. **Состояние релейера в Postgres (0004):** `relayer_vault_usage (network, vault, last_used_at)` для ротации и `relayer_creator_counter (network, next_index)` для свежих creator (несколько процессов не выдадут один creator двум запускам, L-10).
6. **Огрубление после settle (D1, D9).** В момент settle core огрубляет `created_at`, `not_before`, `claimed_at`, `lease_until`, `updated_at`, `settled_at` до часа и удаляет `meta.image`. Через 24 ч — `action_id = NULL`, `dest = NULL` (как раньше).
7. **Суммы buy/create (D10):** `lamports_in` кратно 0.001 SOL (1 000 000 лампортов), с случайной срезкой 0–1 %; `min_out` пропорционально уменьшен. Релейер исполняет как есть.
8. **`create` выключен в API** (`503 venue_unavailable`), пока `UNZEEN_CREATE_ENABLED` ≠ `1` (D6). Включает лид, когда исполнитель create в релейере готов.
9. **Медиа токенов** раздаёт core: `GET /media/<sha40>.<png|jpeg|jpg|webp|json>` из `$UNZEEN_HOME/<cluster>/media` (`UNZEEN_MEDIA_DIR`), только по точному имени, без листинга, без логов. Релейер ставит `UNZEEN_METADATA_BASE_URL=https://<origin API этой сети>/media`.

## Кто что делает

```
 web ──подписанный POST /api/actions──▶ core (API)
                                        │ одна транзакция Postgres:
                                        │   nonce + hold ZEC/токенов + INSERT relayer_jobs (status=queued, not_before=now+джиттер)
                                        ▼
                                   relayer_jobs ◀──claim (FOR UPDATE SKIP LOCKED)── relayer (TS)
                                        │                                         │ адаптер → Solana
                                        │◀──── sent → confirmed/failed + факт ─────┘
                                        │      + INSERT trades / UPSERT tokens (публичные данные)
                                        ▼
                         core settler (раз в 1 с): закрывает hold, начисляет токены/ZEC,
                         action → executed/failed, job.settled_at = now()
```

- **core** создаёт задания, считает курс ZEC→SOL (сумма в лампортах уже посчитана в задании), закрывает holds. Релейер про ZEC, балансы и anon-ключи **ничего не знает**.
- **relayer** только исполняет задание на Solana и пишет результат + публичные данные ленты.
- `withdraw_zec` — не релейер (выплата из кошелька пула, core: таблица `zec_payouts`).

## Приватность (обязательно для релейера)
- В `relayer_jobs`, `trades`, `tokens` нет `anon_pubkey`. Единственная связь — `relayer_jobs.action_id` (128 бит, случайный). Core обнуляет `action_id` через 24 ч после settlement.
- Релейер **не логирует** `action_id`, `dest`, суммы задания вместе с подписью. В логах — `job.id`, op, venue, статус, длительность. Подпись tx и mint публичны, но в паре с `job.id`/временем постановки в очередь их не логировать.
- `not_before` соблюдать строго: не брать задание раньше (это защита от тайминга H8). «Ускорять» очередь нельзя.
- Отдельная роль Postgres для релейера с правами только на свои таблицы (`relayer_jobs` поколоночно, `trades`, `tokens`, `mint_vaults`, `relayer_vault_usage`, `relayer_creator_counter`): `infra/relayer-role.sql` (идемпотентный, перезапускать после новых миграций). Проверено 12.10 на локальной БД: все запросы этого документа проходят; `action_id`, `SELECT *`, `actions`, `balances`, `deposits`, `zec_payouts`, журналы, `pool_meta`, INSERT/DELETE в очередь и сдвиг `not_before` назад — отказ. Колонка `action_id` этой роли **не видна** (column-level SELECT), поэтому `SELECT *` / `RETURNING *` по `relayer_jobs` не работают — перечисляйте колонки.

## Таблица `relayer_jobs`

| Поле | Кто пишет | Смысл |
|---|---|---|
| `id` | core | bigserial, id задания для логов релейера |
| `action_id` | core | bytea(16) или NULL. Релейеру не нужен, не логировать |
| `part` | core | номер части (`transfer` при умном выводе: 0..N-1), иначе 0 |
| `op` | core | `buy` \| `sell` \| `create` \| `transfer` |
| `venue` | core | `pumpfun` \| `meteora-dbc` \| `jupiter` (NULL для `transfer`) |
| `mint` | core | base58 mint (NULL для `create`) |
| `lamports_in` | core | `buy`: лампорты на покупку; `create`: первая покупка (0 = без покупки) |
| `token_amount` | core | `sell` / `transfer`: базовые единицы токена |
| `min_out` | core | `buy`/`create`: мин. токенов; `sell`: мин. лампортов |
| `meta` | core | `create`: `{"name","symbol","image"?}`; `image` — `data:image/(png\|jpeg\|webp);base64,…` (≤ 512 КБ) |
| `dest` | core | `transfer`: свежий Solana-адрес получателя |
| `gas_lamports` | core | `transfer`: капля SOL получателю на комиссии (отправить вместе с токенами) |
| `network` | core | `devnet` \| `mainnet-beta`. Релейер берёт только свою сеть |
| `exec_mode` | core | `now` \| `delayed` \| `max` (0005); `now` — сразу, тот же единый priority fee, что у всех tx пула, без Jito. NULL после settle |
| `status` | оба | `queued` → `claimed` → `sent` → `confirmed` \| `failed` |
| `not_before` | core (+ relayer: только увеличение) | граница эпохи / задержка вывода; раньше не брать. Релейер может отложить (backoff), но не ускорить |
| `attempts`, `claimed_by`, `claimed_at`, `lease_until` | relayer | аренда задания |
| `signature`, `last_valid_block_height` | relayer | пишутся **до** отправки tx |
| `vault` | relayer | публичный адрес vault, подписавшего tx (учёт релейера); для buy/sell/transfer = `mint_vaults.vault` этого mint |
| `slot`, `out_mint`, `out_token_amount`, `out_lamports`, `network_fee` | relayer | факт исполнения (см. ниже) |
| `error_code`, `error_message` | relayer | при `failed`; код из списка ниже, сообщение без данных пользователя |
| `settled_at` | core | реестр закрыт; после этого релейер строку не трогает |

### Операции и что вернуть в `confirmed`

| op | Вход | `out_token_amount` | `out_lamports` | Прочее |
|---|---|---|---|---|
| `buy` | `venue, mint, lamports_in, min_out` | токенов получено | лампортов фактически потрачено (≤ `lamports_in`, комиссии площадки включены, network fee и рента — нет) | |
| `sell` | `venue, mint, token_amount, min_out` | токенов продано (≤ `token_amount`) | лампортов получено | |
| `create` | `venue, meta, lamports_in, min_out` | токенов от первой покупки (0 если без) | лампортов на первую покупку | `out_mint` обязателен. creator — свежий адрес пула (не vault) |
| `transfer` | `mint, token_amount, dest, gas_lamports` | токенов отправлено (= `token_amount`) | 0 | с vault этого mint (`mint_vaults`) вместе с каплей SOL `gas_lamports`; отдельная tx на каждую часть |

Если `out_lamports` при `buy` меньше `lamports_in`, core вернёт пользователю разницу в ZEC по курсу задания. При `sell` недопроданный остаток токенов возвращается на баланс пользователя.

### Коды ошибок (`error_code`)
`slippage` · `graduated` · `pool_liquidity` (у vault не хватает SOL/токенов — проблема пула) · `venue_unavailable` · `not_found` (нет кривой для mint) · `bad_request` · `internal`.
Маппинг из адаптера: `insufficient_sol` → `pool_liquidity`, `insufficient_tokens` → `pool_liquidity`, `graduated` → `graduated`, остальное — одноимённо. Коды уходят пользователю в `GET /api/actions/:id`.

## Протокол релейера

### 1. Взять задания (атомарно, несколько релейеров безопасны)
```sql
UPDATE relayer_jobs j
   SET status = 'claimed', claimed_by = $1, claimed_at = now(),
       lease_until = now() + interval '60 seconds', attempts = attempts + 1, updated_at = now()
 WHERE j.id IN (
       SELECT id FROM relayer_jobs
        WHERE status = 'queued' AND not_before <= now() AND network = $2
          AND <lane>   -- now: exec_mode = 'now'; batch: exec_mode IN ('delayed','max')
        ORDER BY not_before, <tiebreak>   -- now: id (FIFO); batch: random()
        LIMIT 1
        FOR UPDATE SKIP LOCKED)
RETURNING j.id, j.part, j.op, j.venue, j.mint, j.lamports_in, j.token_amount, j.min_out,
          j.meta, j.dest, j.gas_lamports, j.attempts;
```
Релейер держит две независимые полосы (Now — опрос ~300 мс, пачка — по эпохам). `exec_mode` используется только в WHERE: не возвращается, не передаётся исполнителю, не логируется. Внутри эпохи пачка исполняется в случайном порядке (N-4). Исполнение в обеих полосах побайтно одинаковое (один CU price из фонового кэша, без Jito).
`$1` — id инстанса релейера (не hostname с IP), `$2` — сеть релейера, `$3` — размер батча (≥ ожидаемого размера эпохи, например 50). Опрос раз в 1–3 с. Задания одного батча (= одной эпохи core) исполнять в случайном порядке.

### 2. Перед отправкой tx — записать подпись
Подпись известна до broadcast (подписанная tx). Сначала запись, потом отправка:
```sql
UPDATE relayer_jobs SET status = 'sent', signature = $2, last_valid_block_height = $3, vault = $4,
       lease_until = now() + interval '120 seconds', updated_at = now()
 WHERE id = $1 AND status = 'claimed' AND claimed_by = $5;
```
0 строк → задание уже не наше (аренда истекла), **не отправлять**.

### 3. Результат
Успех (только после `confirmed`/`finalized` в Solana и разбора факта из tx):
```sql
UPDATE relayer_jobs SET status = 'confirmed', slot = $2, out_mint = $3, out_token_amount = $4,
       out_lamports = $5, network_fee = $6, updated_at = now()
 WHERE id = $1 AND status = 'sent';
```
Ошибка (tx не попала в блок и уже не попадёт, либо ошибка до отправки):
```sql
UPDATE relayer_jobs SET status = 'failed', error_code = $2, error_message = $3, updated_at = now()
 WHERE id = $1 AND status IN ('claimed', 'sent');
```
В той же транзакции, что `confirmed`, релейер пишет публичные данные (см. ниже).

### 4. Повторы и зависшие задания (защита от двойной покупки)
- Отложить задание (площадка/RPC недоступны): `UPDATE relayer_jobs SET status='queued', claimed_by=NULL, not_before = now() + interval '<N> seconds', updated_at=now() WHERE id=$1 AND status='claimed' AND signature IS NULL`. `not_before` только растёт (триггер). Альтернатива без сдвига очереди — продлить `lease_until`.
- `claimed` без подписи и `lease_until < now()` → можно вернуть в `queued` (`status='queued', claimed_by=NULL`), если `attempts < 3`; иначе `failed` / `venue_unavailable`.
- `sent` с подписью: **никогда** не отправлять новую tx, пока не доказано, что старая не попадёт: `getSignatureStatuses(sig, {searchTransactionHistory:true})` пусто **и** `getBlockHeight() > last_valid_block_height`. Только тогда — либо `failed`, либо новая попытка: `status='claimed'`, новая подпись через шаг 2.
- Найдена в цепочке с ошибкой программы → `failed` с кодом по ошибке (slippage и т. п.).
- Релейер после рестарта сначала разбирает свои `claimed`/`sent`, потом берёт новые.

### 5. Публичные данные ленты (в той же транзакции, что `confirmed`)
```sql
-- create: новая строка токена
INSERT INTO tokens (mint, venue, symbol, name, image, decimals, status, price_sol, market_cap_sol)
VALUES (...) ON CONFLICT (mint) DO NOTHING;
-- после каждой сделки: свежая цена/статус из котировки адаптера
UPDATE tokens SET price_sol = $2, market_cap_sol = $3, status = $4, updated_at = now() WHERE mint = $1;
-- событие ленты (одно на сделку; create с первой покупкой = 'create' + 'buy' с одной подписью)
INSERT INTO trades (kind, venue, mint, symbol, token_amount, sol_amount, decimals, signature, slot, ts)
VALUES (...) ON CONFLICT (signature, kind, mint) DO NOTHING;
```
- `trades.ts` — `blockTime` tx (не время постановки задания). `sol_amount` — лампорты сделки, `token_amount` — базовые единицы.
- `price_sol`, `market_cap_sol` — `NUMERIC`, писать десятичной строкой.
- `transfer` в `trades` **не пишется** (вывод не попадает в ленту).
- Только сделки Unzeen (vault пула). Чужие сделки по mint — позже индексатор, не релейер.

Core отдаёт `trades` в `/api/feed`, `/api/tokens/:mint/trades`, свечи и WS (опрос новых `id` раз в 1 с).

### 6. Закрепление mint → vault (0003)
```sql
-- при первой покупке/запуске mint (гонка двух релейеров безопасна)
INSERT INTO mint_vaults (network, mint, vault) VALUES ($1, $2, $3) ON CONFLICT (network, mint) DO NOTHING;
SELECT vault FROM mint_vaults WHERE network = $1 AND mint = $2;
-- перенос позиции (операторская процедура, после внутреннего перевода токенов)
UPDATE mint_vaults SET vault = $3 WHERE network = $1 AND mint = $2;
```
Данные публичные (vault видны через Verify), без anon-ключей и action_id.

### 7. Состояние релейера (0004)
```sql
-- ротация vault
INSERT INTO relayer_vault_usage (network, vault, last_used_at) VALUES ($1, $2, now())
  ON CONFLICT (network, vault) DO UPDATE SET last_used_at = EXCLUDED.last_used_at;
-- свежий creator: атомарно взять индекс
INSERT INTO relayer_creator_counter (network, next_index) VALUES ($1, 1)
  ON CONFLICT (network) DO UPDATE SET next_index = relayer_creator_counter.next_index + 1
  RETURNING next_index - 1;
```
**Перенос состояния из файлов (один раз, оператор, под владельцем БД):** `next_index` = значение `next` из `$UNZEEN_HOME/<cluster>/solana/creator-counter.json`, пины — из `mint-vaults.json`. Локально (devnet) выполнено 12.10: `next_index = 4`, 1 пин.
```sql
INSERT INTO relayer_creator_counter (network, next_index) VALUES ('devnet', <next>)
  ON CONFLICT (network) DO UPDATE SET next_index = GREATEST(relayer_creator_counter.next_index, EXCLUDED.next_index);
```

## Что делает core при settlement
Settler (в процессе API, раз в 1 с) берёт `status IN ('confirmed','failed') AND settled_at IS NULL` `FOR UPDATE SKIP LOCKED` и в одной транзакции:

| op | confirmed | failed |
|---|---|---|
| `buy` | hold ZEC списан; возврат `hold × (lamports_in − out_lamports) / lamports_in`; `+out_token_amount` токенов на баланс | hold ZEC → доступно |
| `sell` | токены списаны (недопродано → обратно); `+floor(out_lamports × 1e8 / курс)` зат | токены → доступно |
| `create` | hold (комиссия + первая покупка, с возвратом остатка) списан; токены первой покупки на баланс; запись прав создателя | hold → доступно |
| `transfer` | токены части списаны | токены части → доступно |

В той же транзакции core огрубляет времена задания до часа и удаляет `meta.image` (D1/D9). Janitor (раз в 60 с): через 24 ч после settle — `action_id`/`dest` = NULL; закрытые действия через 24–48 ч теряют суммы, курс и `fill`; журналы `ledger_ops`/`token_ops` старше 48 ч удаляются.

Действие закрывается, когда все его задания закрыты: `executed`, если хоть одно `confirmed`, иначе `failed` с `error_code` первого упавшего. Комиссия вывода токенов при полном провале возвращается.

## Контрольный список для релейера
- [ ] Подключение по `DATABASE_URL_RELAYER` (роль `unzeen_relayer`), отказ стартовать, если `action_id` читается; сеть из `UNZEEN_SOLANA_CLUSTER`, проверка `network` в каждом задании.
- [ ] Claim через `FOR UPDATE SKIP LOCKED`, соблюдение `not_before`, вся эпоха в случайном порядке; backoff только увеличением `not_before`.
- [ ] buy/sell/transfer mint — через его vault из `mint_vaults`.
- [ ] Подпись в БД до broadcast; повтор только по правилам п. 4.
- [ ] Факт из tx (`out_*`), а не из котировки.
- [ ] `trades`/`tokens` в той же транзакции, что `confirmed`.
- [ ] Логи без `action_id`, `dest` и связки сумма ↔ подпись ↔ время постановки.
