# Спека: сценарии (цепочки блоков, одна подпись)

Автор: analyst · Дата: **2026-10-13** · Основа: HEAD `131bb34`, API.md v0.17, RELAYER.md v11, `docs/analysis/orders.md`, `now-mode.md`, `final-audit.md`, `chat.md`, STATUS.md (решения 13.10). Код читал: `core/ledger/src/{actions,orders}.rs`, `core/api/src/actions.rs`, `adapters/src/intel/indexer.ts` (ценовой проход). Ничего не собирал и не запускал.
Внутреннее, **до 28.10 23:59 UTC не публиковать** (раздел про fair-launch-блоки).
Правило ZECATHON: любая утечка связи «пользователь ↔ сделка» ведёт к дисквалификации, в том числе если она видна третьей стороне.

---

## TL;DR

1. **Сценарий — это запись в реестре, а не новый тип сделки.** Пользователь один раз подписывает план (линейная цепочка ≤ 12 блоков, ветки только «при ошибке», ограниченный повтор). Затем исполнитель в core на каждом шаге вызывает **существующий** путь `build()` → `submit_in()` (или `order_create`, `claim`, `fl_*`, `chat`) со случайным nonce/request_hash, как это уже делают ордера (E20). Релейер, адаптеры и индексатор **не меняются**: для них это обычные `buy`/`sell`/`create`/`transfer` в эпохах. На цепочке шаг сценария неотличим от ручного действия. Против сетевого наблюдателя он даже лучше ручного: в момент исполнения от пользователя нет HTTP-запроса.
2. **Новые утечки появляются только из автоматизации таймингов и сумм.** Их закрывают серверные «полы», которые пользователь отключить не может:
   - случайная задержка после пополнения (10–40 мин);
   - Now разрешён только сразу после ручного старта;
   - вывод токенов не раньше чем через 1 ч после сделки по тому же mint;
   - джиттер у фиксированных ожиданий, повторов и DCA;
   - срезка выручки в Swap;
   - slow-режим и задержка для сообщения в чат после своей сделки;
   - триггеры только по mint пула (без новых RPC-запросов).

   Адрес вывода хранится зашифрованным (ключ вне БД) и удаляется сразу после постановки задания. План живёт не дольше 72 ч, затем срабатывает ретеншн D1 24/48 ч.
3. **Объём:** бек ~5,25 дня, фронт ~3,75 дня, ревью 0,5 дня. Адаптеры не трогаем. Валидатор плана и UI на моках можно начинать сразу. Исполнитель встраивается в `core/api` и `core/ledger` только **после** мержа миграции сумм на NUMERIC/u128 (те же файлы: `actions.rs`, `orders.rs`). Новые таблицы сразу заводим в `NUMERIC(78,0)`. Ядро хакатона не трогаем, фича идёт за флагом `UNZEEN_SCENARIOS`.

---

## 1. Категории блоков

Общие поля любого шага: `id` (0..11, уникален в плане), `type`, `onFail?` (§2.3).

Обозначения в колонке «Хранится»:
- **П** — в теле плана, до закрытия плана;
- **З** — запечатано (§4.4);
- **Р** — строка исполнения `scenario_runs`.

Ретеншн для всех: закрытие + 24 ч → затирание, + 48 ч → удаление (§4.6), если не сказано иное.

Ссылки:
- `MintRef` = `"<base58>"` | `{ step: id }` (mint, созданный шагом `create` / полученный шагом `swap`);
- `AmountSpec` = `{ abs: "<целое>" }` | `{ pct: 1..100, of: "balance" }` | `{ pct: 1..100, of: { step: id } }` (выход шага: токены у buy/create, зат у sell).

Защита цены: `Guard` = `{ slippageBps: 50..5000 }` (только mint с ценой тика, §1.3) | `{ limitPrice: "<дес. строка>" }` (цена в единицах пары за 1 целый токен; для любых mint). Сервер переводит Guard в `minOut`/`minZecOut` в момент исполнения и передаёт в `build()` как подписанное значение. Дальше работает обычная логика: срезка D10, квантование до 3 значащих цифр, A6.

### 1.1 Triggers — ждать события

Триггер держит курсор, пока условие не выполнится или не истечёт `timeoutSecs` (≤ остатка TTL плана; истёк → `onFail`). Все триггеры, кроме ручного старта, проверяются **только по данным, которые core уже имеет**: тик индексатора, реестр, часы. Ни один триггер не порождает RPC-запросов (O1).

| Блок | Параметры | Валидация | Что вызывает | Хранится | Примечание по приватности |
|---|---|---|---|---|---|
| `manual_start` | — | Только шаг 0. Без него план стартует сразу при создании | `POST scenario_start {id}` (подписанный) | П: ~20 Б | Запрос в T → шаг в эпоху, как обычное ручное действие |
| `time_at` | `at` (unix мс, шаг 1 мин) | `now + 60 с ≤ at ≤ expiresAt` | Часы core | П: 30 Б | **Пол:** срабатывает в `at + U(0, 10 мин)`. Иначе повторяющееся «ровно в 09:00» связывает сделки между собой |
| `price_cross` | `mint: MintRef`, `op: "gte" \| "lte"`, `priceSol` | mint есть в `intel_prices` (токен пула) или создан этим планом; только SOL-пары с тиком. Иначе `422 scenario_rule: unpriced_mint` | Та же оценка, что у ордеров: `intel_prices`, только тики новее шага, не старше 180 с | П: ~90 Б; Р: `last_tick`, `armed_tick` | `lte` — **2 тика подряд** (как SL, O4) |
| `deposit_received` | `minZat` | `≥ minDepositZat`; ≤ 1 на план | Сумма `deposits` ключа, зачисленных после взвода триггера (рост баланса без memo; выручка от продаж и claim не считается). Выход шага — эта сумма в зат (для `{of:{step}}`) | П: 30 Б; Р: `armed_at` | **Пол:** срабатывает через `U(10, 40) мин` после зачисления. Следующий торговый шаг — не Now (§4.1 P1, P3) |
| `own_result` | `ref`: `{ step: id }` (шаг `order_place`) \| `{ orderId }` (свой открытый ордер) \| `{ actionId }` (своё `queued`-действие); `on: "filled" \| "failed" \| "any"` | Ссылка на свой объект (иначе `404`), шаг — более ранний | Статус `orders` / `actions` из реестра | П: ~60 Б | — |
| `curve_progress` | `mint: MintRef`, `gtePct` (1..100) \| `graduated: true` | Mint пула или созданный планом, площадка с кривой (pump.fun, DBC) | `token_safety.market.curveProgressPct` / `intel_prices.status` из снимка тика | П: ~70 Б | Как `price_cross`: новых чтений нет |

### 1.2 Waits — пауза

| Блок | Параметры | Валидация | Что вызывает | Хранится | Примечание |
|---|---|---|---|---|---|
| `wait_fixed` | `secs` | 30 с ≤ secs ≤ остаток TTL | Таймер `next_at` | П: 20 Б; Р: `next_at` | **Пол:** фактически `secs ± max(30 с, 10 %)`. UI показывает «≈» |
| `wait_random` | `minSecs`, `maxSecs` | 30 с ≤ min < max ≤ остаток TTL | `next_at = now + U(min, max)` (CSPRNG) | П: 30 Б; Р: `next_at` | Рекомендуемый блок. Шаблоны используют только его |

`next_at` хранится до прохождения шага. Владельцу в `Portfolio` он отдаётся округлённым до минуты.

### 1.3 Trade — сделки

Цена тика есть только у mint пула на кривой pump.fun и SOL-конфиге DBC (`indexer.ts` `prices()`). У LaunchLab, Bags, пар не к SOL и выпустившихся токенов (Jupiter) её нет, поэтому для них обязателен `limitPrice`.

| Блок | Параметры | Валидация | Что вызывает | Хранится | Примечание |
|---|---|---|---|---|---|
| `buy` | `venue`, `mint: MintRef`, `zec: AmountSpec`, `guard: Guard`, `exec: "now"\|"delayed"\|"max"` | Площадка включена (`PoolInfo.venues`), `exec:"now"` по P1 | `build(SignedAction::Buy{zecIn, minOut})` → `submit_in` | П: ~150 Б; Р: `action_id` | Пара (SOL/USDC/USD1/ZEC) берётся из токена, как сейчас. Jupiter — mainnet |
| `sell` | `venue`, `mint`, `amount: AmountSpec` (токены), `guard`, `exec` | То же | `build(SignedAction::Sell{amount, minZecOut})` | П: ~150 Б; Р | A6 (срезка при совпадении с покупкой) работает сама |
| `sell_all` | `venue`, `mint`, `guard`, `exec` | — | = `sell` с `{pct:100, of:"balance"}` | П | Всегда «≈»: A6 сработает на всей позиции |
| `swap` | `from: MintRef`, `to: MintRef`, `amount: AmountSpec` (A), `guardSell`, `guardBuy`, `venueSell?`, `venueBuy?`, `exec` (`delayed`/`max`) | `from ≠ to`; `exec:"now"` → 400 | Две операции: `sell(A)` → скрытая пауза `U(3, 15) мин` → `buy(B, zec = выручка × (1 − U(2 %, 8 %)))` | П: ~250 Б; Р: 2 строки | Без срезки и паузы «продал A на X SOL → купил B на X SOL» склеивается в цепочке (P6). Остаток ZEC — на балансе |
| `dca` | `side: "buy"\|"sell"`, `mint`, `venue`, `total: AmountSpec`, `slices: 2..12`, `everySecs: {min, max}` (≥ 600 с), `guard`, `exec` (`delayed`/`max`) | `slices × max ≤ остаток TTL`; каждый срез ≥ `minActionZat` (оценка) | `slices` обычных buy/sell; веса срезов — случайные ±20 % с нормировкой; интервалы — `U(min, max)` | П: ~180 Б; Р: ≤ 12 строк | DCA и TWAP — один блок: TWAP = `everySecs` из длительности. Равные срезы через ровные интервалы склеивают сделки одного человека (P5) |

### 1.4 Orders — приватные ордера

| Блок | Параметры | Валидация | Что вызывает | Хранится | Примечание |
|---|---|---|---|---|---|
| `order_place` | Как `order_create` v0.15 (`kind` limit_buy/limit_sell/take_profit/stop_loss/bracket, цены, `rearm`, `slippageBps`, `ttlSecs`, `exec`), но `amount: AmountSpec`, `mint: MintRef` | Правила ордеров (только SOL-пары pump.fun пула, лимиты 10/4 **с учётом** ордеров сценариев) | `order_create` с синтетическим nonce; hold берётся в этот момент | П: ~200 Б; Р: `order_id` | Ордер — обычная запись `orders`. Его видно в `Portfolio.orders` |
| `order_cancel` | `ref`: `{step: id}` \| `{orderId}` | Свой ордер | `order_cancel` | П: 40 Б | Из `triggered` нельзя → `onFail` |

Шаг `order_place` считается **выполненным, когда ордер поставлен**. Чтобы ждать его исполнения, следующий шаг — `own_result`.

### 1.5 Launch — запуск и комиссии создателя

| Блок | Параметры | Валидация | Что вызывает | Хранится | Примечание |
|---|---|---|---|---|---|
| `create` | Как `create` v0.13 (`venue` — все включённые, `meta`, `initialBuyZec: AmountSpec?`, `quote`, `platform`, `exec`) | `check_meta`, `createEnabled`, кап первой покупки | `build(SignedAction::Create)` | **З:** `meta` с картинкой (≤ 512 КиБ); П: остальное | Выход шага: `mint` + `tokenAmount`. Bags — шаг закрывается, когда закрыты оба задания (как сейчас) |
| `fl_create`* | Как `fl_create` | Флаг fair-launch | `fl_create` | З: `meta` | Внутреннее до 28.10 |
| `fl_bid`* | `launchId`, `holdZat`, `ciphertext` | Запуск **уже опубликован** (раунд известен при подписи). Ставка в свой `fl_create` из того же плана невозможна: раунд ещё не известен → 400 | `fl_bid` | З: `ciphertext` | Шифротекст удаляется после reveal, как у обычных заявок |
| `fl_cancel`* | `launchId` | — | `fl_cancel` | П | — |
| `claim` | `mint?: MintRef` | — | `claim` | П: 50 Б | Операция только реестра, в цепочке её нет |

\* Только при `features.fairLaunch`. При выключенном флаге блоков нет в `PoolInfo.scenarios.blocks`, а `fl_*` в плане → `400 bad_request`, как неизвестная операция. На фронте эти блоки живут в том же ленивом чанке, что fair-launch UI (`NEXT_PUBLIC_FAIR_LAUNCH_BUILD=0` их вырезает).

### 1.6 Withdraw — выводы

| Блок | Параметры | Валидация | Что вызывает | Хранится | Примечание |
|---|---|---|---|---|---|
| `withdraw_token` | `mint: MintRef`, `amount: AmountSpec`, `to: string \| string[]`, `smart?`, `exec` (`delayed`/`max`) | Адреса валидны и различны; правило P2 | `build(SignedAction::WithdrawToken)`: A1-срезка, части, газ | **З:** `to[]`; удаляется сразу после постановки заданий (дальше — `relayer_jobs.dest` по текущим правилам) | Отдельная пометка у `smart`: все части вывода — на разные адреса |
| `withdraw_zec` | `to` (UA), `amount: AmountSpec` (зат), `exec` | `check_ua` (только Orchard/Ironwood) | `build(SignedAction::WithdrawZec)` | **З:** `to`; дальше — `zec_payouts.to_ua` по текущим правилам | A2: больше 1 ZEC на mainnet — ручной разбор, шаг ждёт |

### 1.7 Logic — логика

| Блок | Параметры | Валидация | Что делает | Хранится |
|---|---|---|---|---|
| `check_safety` | `mint: MintRef`; `require`: `{ authoritiesRevoked?, noRiskyExtensions?, maxTop10Pct?, maxDevPct?, minLpBurnedPct?, maxSniperPct? }`; `onFalse: "stop" \| {goto: id}` | Mint пула, созданный планом **или** известный по снимку индексатора. `maxSniperPct`/`maxDevPct` — только при `features.fullTrades` | Один раз читает `token_safety` (снимок ≤ 10 мин). Снимка нет → ставит mint в очередь CA, как поиск (пачка с приманками), и ждёт до 3 тиков. Нет данных — `false` | П: ~120 Б |
| `repeat` | `from: id`, `times: 2..10` | `from` < текущего шага, внутри нет `manual_start`/`deposit_received`/`create`/`fl_*`; общее число исполнений ≤ 40 | Возврат курсора на `from` | П: 20 Б; Р: счётчик |
| `end` | — | — | Завершить план успешно | — |

`onFail` — поле каждого шага, а не блок (§2.3).

### 1.8 Social — чат

| Блок | Параметры | Валидация | Что вызывает | Хранится | Примечание |
|---|---|---|---|---|---|
| `chat` | `mint: MintRef`, `text`, `showCreatorBadge?` | Правила текста v0.12 (сервер проверяет их **при создании плана**), флаг чата, допуск по стоимости аккаунта — при исполнении | Внутренний путь `chat` (ник, эпоха публикации) | **З:** `text` | **Пол P4:** если в плане раньше была сделка по этому mint, `slow` включён принудительно и добавлена пауза `U(10, 30) мин` |

---

## 2. Модель плана

### 2.1 Форма
- **Линейная цепочка** `steps[0..n)`, исполняется по порядку. Произвольного графа в v1 нет. Переходы бывают только трёх видов:
  - `onFail` / `onFalse` = `stop` | `skip` | `{ goto: id }`, где `id` больше текущего (только вперёд);
  - `repeat` — единственный переход назад, число повторов ограничено;
  - `end`.
- Ацикличность без `repeat` проверяется при создании (`goto` только вперёд). Поэтому план всегда конечен: исполнений ≤ 40.

### 2.2 Лимиты (`PoolInfo.scenarios`)
| Параметр | Значение | Почему |
|---|---|---|
| Блоков в плане | ≤ 12 | Читаемость в UI, размер тела ≤ 16 КиБ |
| Исполнений с учётом `repeat`/`dca`/`swap` | ≤ 40 | DoS, размер `Portfolio` |
| Активных планов на ключ | ≤ 3 | — |
| Активных планов на пул | ≤ 500 (сверх → `503 venue_unavailable`, без пояснения) | Как у ордеров: нельзя раскрывать чужую активность |
| TTL плана | 1–72 ч, по умолчанию 24 ч, `expiresAt` вверх до часа | Как у ордеров: намерение у оператора ≤ 3 суток |
| `wait_*` | 30 с … остаток TTL | — |
| `retry` | 1..3 | — |
| Тело `scenario_create` | паддинг до 16 КиБ (с картинкой `create` — ≤ 1 МиБ, как сейчас) | Размер не выдаёт число шагов |

Ордера, поставленные сценарием, входят в общие лимиты ордеров (10 на ключ, 4 на ключ и mint).

### 2.3 Ошибки шага
`onFail`: `"stop"` (по умолчанию) | `"skip"` | `{ retry: 1..3, then: "stop" | "skip" | {goto: id} }` | `{ goto: id }`.
- **retry** только для переходных ошибок: `slippage`, `pool_liquidity`, `venue_unavailable` (нет курса / RPC), `rate_limited`. Пауза перед повтором — `U(1, 5)` эпох. Sell при повторе получает срезку A5 (`fuzz_token_amount_rand`), поэтому две попытки никогда не идут одной суммой.
- Окончательные ошибки (`insufficient_balance`, `below_minimum`, `creator_locked`, `creator_cap`, `graduated`, `order_limit`, `not_found`, `bad_request`) сразу идут в `then`.
- `balance_frozen` (reorg) — **не ошибка шага**: курсор ждёт, пока баланс не разморозят или не истечёт TTL.
- Триггер с истёкшим `timeoutSecs` → `onFail` с кодом `timeout`.

### 2.4 Подпись, nonce, отмена, правка
- **Одна подпись.** `POST /api/actions {op:"scenario_create", plan}` подписывается как любое действие: HTTP-подпись покрывает `sha256(body)`, nonce расходуется **в той же транзакции**, что `INSERT scenarios`. Повтор того же тела → исходная квитанция, другое тело с тем же nonce → `409 replay`. Саму подпись **не храним**: это подписанное признание намерения.
- **Отмена** `scenario_cancel {id}`. В одной транзакции:
  - `status = cancelled`;
  - открытые ордера, поставленные этим планом, закрываются через `close_order`, hold освобождается;
  - запечатанные поля удаляются.

  Шаг, который уже в эпохе (`queued`/`sent`), отозвать нельзя, как сработавший ордер: он доисполняется, следующие шаги не запускаются.
- **«Стоп всего»** = `scenario_cancel {all: true}` — все активные планы ключа.
- **Истечение TTL** работает как отмена (со статусом `expired`). **Успешное завершение** ордера не трогает: они дальше живут как обычные ордера со своим TTL.
- **Правка = новый план.** `scenario_create {plan, replaces: id}` атомарно отменяет старый план и создаёт новый. Прогресс не переносится: шаги, которые старый план уже исполнил, новому неизвестны.
- **Ручной старт** `scenario_start {id}` — только для плана с `manual_start`, один раз.

### 2.5 Hold
Hold берётся **в момент исполнения шага**, а не при создании плана. Иначе не работают планы, которые ждут пополнения, и суммы от выхода предыдущего шага. Не хватает баланса → `insufficient_balance` → `onFail`. Исключение — `order_place`: ордер, как и сейчас, держит hold с момента постановки.

---

## 3. Исполнитель

### 3.1 Где живёт
- `core/ledger/src/scenarios.rs` — таблицы, переходы состояний, janitor, `*_in(tx, …)` для шага.
- `core/api/src/scenarios/{plan,validate,exec}.rs` — разбор и проверка плана, цикл исполнителя: вычисление сумм и Guard → `SignedAction` → `build()`.
- Запуск цикла — одна строка в `lib.rs` рядом с settler/orders (проход раз в 1 с, планы в случайном порядке).
- **Релейер, адаптеры, индексатор не меняются.**

### 3.2 Таблицы (новая миграция, номер — после миграции NUMERIC)
```
scenarios(
  id BYTEA(16) PK,                -- = id квитанции scenario_create
  anon_pubkey BYTEA(32),
  plan JSONB,                     -- без запечатанных полей; NULL после затирания
  status TEXT CHECK IN (waiting_start, active, done, failed, cancelled, expired),
  cursor SMALLINT, runs SMALLINT,
  state JSONB,                    -- выходы шагов: {step: {tokens, zat, mint}}, счётчики repeat/dca, seed
  next_at TIMESTAMPTZ, armed_at TIMESTAMPTZ, last_tick BIGINT, armed_tick BIGINT,
  expires_at TIMESTAMPTZ (час), created_at (минута), closed_at (час), error TEXT)
scenario_runs(scenario_id, seq SMALLINT, step SMALLINT, iter SMALLINT, attempt SMALLINT,
  status TEXT, action_id BYTEA NULL, order_id BYTEA NULL, error TEXT,
  PK (scenario_id, seq))
scenario_sealed(scenario_id, step SMALLINT, blob BYTEA,   -- AES-256-GCM, AAD = id‖step
  PK (scenario_id, step))
```
- Все суммы в `state` и `plan` — строки (u128).
- Ключ запечатывания `K_scn` — файл `UNZEEN_SCENARIO_KEY_FILE` (0600), вне БД и `.env`, как `K_chat`.
- Триггер огрубления времени — как `unzeen_order_coarse`.

### 3.3 Шаг → действие (одна транзакция Postgres)
1. `SELECT … FROM scenarios WHERE status='active' AND next_at <= now() … FOR UPDATE SKIP LOCKED`. Каждый план проходит в **своей** транзакции (как E16 у ордеров), порядок планов случайный.
2. Ключ `frozen` → пропуск. Курса нет → пропуск (с таймаутом 10 мин, потом `venue_unavailable` → `onFail`).
3. Вычислить суммы (`AmountSpec` против текущего баланса или `state`) и Guard → `minOut` (цена тика × slippage или `limitPrice`), применить серверные полы (§4.1). Собрать `SignedAction`.
4. `build(st, pk, action)` — **тот же код**, что у ручного запроса: проверки площадки, A1/A6, D10, кап и лок создателя, пары.
5. `SAVEPOINT` → `submit_in(tx, pk, random_nonce, random_request_hash, &new_action)`. Ошибка → `ROLLBACK TO SAVEPOINT`, ошибка пишется в `scenario_runs` и обрабатывается `onFail`.

   Savepoint обязателен: `submit_in` может вставить строку `actions` до отказа по балансу, а `Ledger::submit` полагается на откат всей транзакции.
6. `INSERT scenario_runs (…, action_id)`. Курсор переходит в `in_flight`. `COMMIT`.
7. Следующий проход: `actions.status <> 'queued'` → вывод выхода шага из `fill` в `state`, переход к следующему шагу (или `onFail`), `next_at` с полами.

Ордера, `claim`, `fl_*`, `chat` — тот же порядок, но через `order_create_in`/`claim_in`/…. Их нужно выделить из существующих функций механически, без изменения поведения: сейчас каждая открывает свою транзакцию.

### 3.4 Идемпотентность и гонки
| Ситуация | Что происходит |
|---|---|
| Падение процесса между шагами 3–6 | Транзакция не закоммичена: нет ни действия, ни hold, ни сдвига курсора. Шаг повторится на следующем проходе |
| Два прохода одновременно (или два процесса) | `FOR UPDATE SKIP LOCKED` по строке плана. PK `(scenario_id, seq)` — вторая вставка невозможна |
| `scenario_cancel` во время исполнения шага | Обе стороны берут строку `FOR UPDATE`. Отмена ждёт, потом видит `in_flight` и не трогает уже созданное действие |
| Пользователь вручную отменил ордер плана | `own_result` видит `cancelled` → `onFail` (`order_not_open`) |
| Пользователь вручную потратил баланс | Шаг получает `insufficient_balance` → `onFail` |
| Два плана на одном балансе | Hold атомарен (`UPDATE … WHERE available >= x`), кто первый, того и баланс |
| Срабатывание ордера и отмена плана | Как сейчас у ордеров: `triggered` не отменяется, его сделка доисполняется |
| Reorg Zcash депозита, на котором сработал `deposit_received` | Баланс `frozen` → все шаги ждут. Разморозка → продолжение. Истёк TTL → `expired` |
| Solana: tx не легла / истёк blockhash | Без изменений: правила релейера (подпись до broadcast, повтор только после проверки) |
| Сервер стоял дольше TTL | При старте janitor закрывает план (`expired`). Пропущенные шаги **не** «догоняются» пачкой: пачка шагов после простоя — это паттерн |

### 3.5 Логи
Только счётчики (`scenarios_fired=N, failed=N`). Без id плана, mint, сумм и времени шага, как у ордеров (O9).

---

## 4. Приватность

### 4.1 Правила (сервер, `422 scenario_rule`, `details: {step, code}`) и серверные полы

| Код | Комбинация | Решение | Серьёзность без него |
|---|---|---|---|
| **P1** `now_not_first` | `exec:"now"` у шага, которому предшествует что-то кроме создания плана или `manual_start` | **Запрет.** Now после события (тик, депозит, исполнение ордера, `time_at`) даёт точную связку «публичное событие → сделка через 1–3 с» без человеческой реакции. Now после старта — то же, что ручной Now (README) | high |
| **P2** `withdraw_too_soon` | `withdraw_token(M)` после `buy`/`swap`/`create`/`dca` по M без `wait_*` с минимумом ≥ 1 ч между ними | **Запрет** + пол `U(0, 30) мин` поверх. UI дополнительно предупреждает, если пауза < 12 ч | high: «купил → через 40 с вывел ≈ столько же» — A1 срезает сумму на 0,5–2 %, но тайминг её и так выдаёт |
| **P3** `trade_after_deposit` | Торговый шаг сразу после `deposit_received` | **Пол:** триггер срабатывает через `U(10, 40) мин` после зачисления. Плюс P1 (Now нельзя) | high: без человеческой задержки сделка ложится на фиксированное смещение от блока Zcash `B + K + r`. Ironwood-tx в блоке мало, а это связь с конкретной Zcash-tx (N-10) |
| **P4** `chat_after_trade` | `chat` по M, если в плане раньше была сделка по M | **Пол:** `slow` принудительно + `U(10, 30) мин` | medium: ник ↔ размер сделки (chat.md, R6) |
| **P5** `equal_slices` | `repeat` с `abs`-суммами, `dca` | **Пол:** ±10 % к каждой итерации `repeat`; веса `dca` ±20 %; интервалы случайные | medium: N одинаковых сделок через ровные интервалы склеивают историю одного человека и раскрывают стратегию |
| **P6** `swap_mirror` | `swap` / `sell` → `buy` с `{of:{step}}` выручки | **Пол:** пауза `U(3, 15) мин`, сумма buy = выручка × (1 − U(2 %, 8 %)). То же для любого `buy` с суммой от выхода `sell` | medium: «продал на X SOL → купил на ≈X SOL» |
| **P7** `jitter_fixed` | `wait_fixed`, `time_at` | **Пол:** ±max(30 с, 10 %) / `+U(0, 10 мин)` | low–medium: отпечаток расписания |
| **P8** `unpriced_mint` / `unknown_mint` | `price_cross`, `curve_progress`, `Guard.slippageBps` по mint без тика | **Запрет.** Только mint пула или созданный планом. Иначе пришлось бы держать mint в warm set из-за сценария, а это видно RPC (O1/O5) | high (третья сторона) |
| **P9** `trade_gap` | Два торговых шага подряд без ожидания | **Пол:** второй — через `+U(1, 3)` эпохи | low: пары сделок в соседних эпохах |
| **P10** | `fl_*` при выключенном флаге | `400 bad_request`, в `PoolInfo.scenarios.blocks` их нет | раскрытие фичи до 28.10 |

Полы **не настраиваются** и одинаковы для всех. Их значения публикуются в `PoolInfo.scenarios.floors` (для UI «≈», проверка остаётся на сервере).

Предупреждения только в UI, без запрета:
- `sell_all` раньше чем через 1 ч после покупки того же mint;
- один адрес в двух `withdraw_token`;
- `max` не выбран для выводов;
- план стартует сразу (без `manual_start`) после свежего пополнения (< 10 мин по локальной истории).

### 4.2 Шаблоны выравнивают поведение
- Шаблоны (§5) — константы в бандле фронта, одинаковые для всех. Параметры шаблонов — только диапазоны случайных ожиданий и `delayed`/`max`. Тогда пользователи одного шаблона дают на цепочке одинаковое распределение таймингов. Это поведенческая k-анонимность.
- Сервер **не знает**, из шаблона план или нет: поля `template` в API нет. Имя плана и шаблона фронт хранит только локально, внутри зашифрованного vault-блоба.
- Черновики планов — тоже только в зашифрованном блобе, не в открытом `localStorage`: план содержит намерения и адреса вывода.

### 4.3 Что видит кто
| Наблюдатель | Видит |
|---|---|
| Цепочка Solana | Обычные сделки и выводы vault в эпохах. Маркера «сценарий» нет (`kind` = buy/sell, случайный request_hash, единый fee-профиль) |
| Сеть (ISP, провайдер VPS) | `scenario_create` (16 КиБ), `scenario_start`/`cancel` (1 КиБ). **В момент исполнения шагов запросов нет**, поэтому связки «IP → сделка» нет вообще. Создание плана можно отличить от `buy` по размеру тела (low, см. Q9) |
| RPC-провайдеры | Ничего нового: триггеры только по тику и снимкам, `check_safety` по неизвестному mint — через ту же очередь CA с приманками |
| Публичный API | Ничего: ни счётчиков, ни статистики сценариев. **Никогда** не добавлять их в `/api/stats` |
| Оператор / утечка БД | Весь план, пока он активен: стратегия, mint, суммы, триггеры. Адреса вывода и UA — только с `K_scn`. Связь шаг ↔ действие — до 24 ч после закрытия. В README: «a scenario is an intention held by the operator until it ends (≤ 72 h)» |
| Владелец ключа | `Portfolio.scenarios` (подписанный, с паддингом). На демо-ключах судей — все, у кого есть ключ |

### 4.4 Адрес вывода и прочие запечатанные поля
- `withdraw_token.to[]`, `withdraw_zec.to`, `create.meta` (+картинка), `fl_bid.ciphertext`, `chat.text` хранятся в `scenario_sealed`, зашифрованные AES-256-GCM ключом `K_scn` вне БД. Утечка одной БД их не раскрывает.
- Удаляются **в той же транзакции**, где шаг поставил задание: дальше адрес живёт по существующим правилам (`relayer_jobs.dest` / `zec_payouts.to_ua`). При отмене, истечении или ошибке плана удаляются сразу.
- В `Portfolio` адреса отдаются маской (`Ab3d…9xYz`).

### 4.5 Тайминги — сводка
- Каждый торговый шаг идёт **только через эпоху** (`delayed` 30–60 с, `max` 5–15 мин). Now — по P1.
- Ценовые триггеры — тик (45–75 с, случайный момент внутри тика) + эпоха, как у ордеров.
- После простоя сервера пропущенные шаги не исполняются пачкой: каждый получает новый `next_at` с полом.

### 4.6 Ретеншн (D1)
| Данные | Срок |
|---|---|
| План целиком (`plan`, `state`, `next_at`, тики) | Пока план активен (≤ 72 ч) |
| `scenario_sealed` | До постановки шага или до закрытия плана — что раньше |
| Закрытие + 24 ч | `plan = NULL`, `state = NULL`, `scenario_runs.action_id/order_id = NULL`, ошибки шагов затираются. План пропадает из `Portfolio` |
| Закрытие + 48 ч | `DELETE scenarios`, `scenario_runs` |
| Действия и ордера, созданные шагами | Существующие правила D1 (24/48 ч) |
| `created_at` | Вниз до минуты; `closed_at` — до часа |

Обязательные тесты janitor: затирание, удаление, удаление sealed при отмене.

---

## 5. Шаблоны v1

Все шаблоны — `delayed` или `max`, без `wait_fixed`, TTL указан.

**T1 · Private buy & exit** (TTL 72 ч). Главный сценарий для видео.
1. `deposit_received {minZat}` (пол 10–40 мин).
2. `wait_random 20–90 мин`.
3. `check_safety {authoritiesRevoked, noRiskyExtensions}` → `onFalse: stop`.
4. `buy {zec: {pct: 95, of: {step: 0}} (или abs), guard: slippage 500, exec: max}`.
5. `order_place {bracket, amount: {pct:100, of:{step:4}}, tp, sl, rearm}`.
6. `own_result {step:5, on:"any"}`.
7. `wait_random 1–6 ч`.
8. `withdraw_zec {amount: {pct:100, of:"balance"}, to: UA, exec: max}`.

Выход в shielded ZEC: сумма вывода в цепочке не видна, поэтому P2 не нужен.

**T2 · Launch & take profit** (TTL 72 ч).
1. `create {venue, meta, initialBuyZec, exec: delayed}`.
2. `wait_random 24 ч 5 мин – 26 ч`: лок создателя 24 ч, без паузы TP получил бы `423 creator_locked`.
3. `order_place {take_profit, amount: {pct:100, of:{step:0}}, priceSol}`.
4. `own_result {step:2, on:"filled"}`.
5. `claim {mint:{step:0}}`.
6. `wait_random 1–6 ч`.
7. `withdraw_zec`.

**T3 · DCA in** (TTL ≤ 72 ч).
1. `manual_start`.
2. `dca {side: buy, total, slices: 4–8, everySecs: {min: 2 ч, max: 6 ч}, guard: slippage 500 или limitPrice, exec: delayed}`, `onFail: {retry: 2, then: skip}`.
3. `end`.

**T4 · Rotate** (TTL 24 ч).
1. `manual_start`.
2. `swap {from A, to B, amount: pct 100, guardSell, guardBuy, exec: delayed}` (пауза 3–15 мин и срезка 2–8 % внутри).
3. Опционально `order_place {stop_loss по B}`.

---

## 6. Черновик API v0.19 (API.md не правил)

```ts
// PoolInfo.features += scenarios?: true   (флаг UNZEEN_SCENARIOS; нет ключа = выключено, ops → 400)
interface ScenarioParams {               // PoolInfo.scenarios, только при features.scenarios
  blocks: ScenarioBlockType[];           // включённые блоки (без fl_* при выключенном fair-launch, без chat без features.chat)
  maxSteps: 12; maxRuns: 40; maxActivePerKey: 3;
  ttlSecs: { min: 3600; max: 259200; default: 86400 };
  floors: {
    afterDepositSecs: [600, 2400];  timeAtJitterSecs: [0, 600];  fixedWaitJitterPct: 10;
    withdrawAfterTradeMinSecs: 3600; withdrawExtraSecs: [0, 1800];
    swapGapSecs: [180, 900]; swapShaveBps: [200, 800];
    chatAfterTradeSecs: [600, 1800]; repeatJitterPct: 10; dcaWeightJitterPct: 20; tradeGapEpochs: [1, 3];
  };
}

type MintRef = string | { step: number };
type AmountSpec = { abs: string } | { pct: number; of: "balance" | { step: number } };
type Guard = { slippageBps: number } | { limitPrice: string };
type OnFail = "stop" | "skip" | { goto: number } | { retry: 1 | 2 | 3; then: "stop" | "skip" | { goto: number } };

type ScenarioBlock =
  | { type: "manual_start" }
  | { type: "time_at"; at: number }
  | { type: "price_cross"; mint: MintRef; op: "gte" | "lte"; priceSol: string; timeoutSecs?: number }
  | { type: "deposit_received"; minZat: string; timeoutSecs?: number }
  | { type: "own_result"; ref: { step: number } | { orderId: string } | { actionId: string }; on: "filled" | "failed" | "any"; timeoutSecs?: number }
  | { type: "curve_progress"; mint: MintRef; gtePct?: number; graduated?: true; timeoutSecs?: number }
  | { type: "wait_fixed"; secs: number }
  | { type: "wait_random"; minSecs: number; maxSecs: number }
  | { type: "buy"; venue: Venue; mint: MintRef; zec: AmountSpec; guard: Guard; exec: "now" | "delayed" | "max" }
  | { type: "sell"; venue: Venue; mint: MintRef; amount: AmountSpec; guard: Guard; exec: "now" | "delayed" | "max" }
  | { type: "sell_all"; venue: Venue; mint: MintRef; guard: Guard; exec: "now" | "delayed" | "max" }
  | { type: "swap"; from: MintRef; to: MintRef; amount: AmountSpec; guardSell: Guard; guardBuy: Guard;
      venueSell?: Venue; venueBuy?: Venue; exec: "delayed" | "max" }
  | { type: "dca"; side: "buy" | "sell"; venue: Venue; mint: MintRef; total: AmountSpec; slices: number;
      everySecs: { min: number; max: number }; guard: Guard; exec: "delayed" | "max" }
  | { type: "order_place"; order: Omit<OrderCreate, "op" | "amount" | "mint"> & { amount: AmountSpec; mint: MintRef } }
  | { type: "order_cancel"; ref: { step: number } | { orderId: string } }
  | { type: "create"; create: Omit<CreateAction, "op" | "initialBuyZec"> & { initialBuyZec?: AmountSpec } }
  | { type: "fl_create"; launch: Omit<FlCreate, "op"> }            // только при features.fairLaunch
  | { type: "fl_bid"; launchId: string; holdZat: string; ciphertext: string }
  | { type: "fl_cancel"; launchId: string }
  | { type: "claim"; mint?: MintRef }
  | { type: "withdraw_token"; mint: MintRef; amount: AmountSpec; to: string | string[];
      smart?: { parts: number; maxDelayMin: number }; exec: "delayed" | "max" }
  | { type: "withdraw_zec"; to: string; amount: AmountSpec; exec: "delayed" | "max" }
  | { type: "check_safety"; mint: MintRef; require: SafetyRequire; onFalse: "stop" | { goto: number } }
  | { type: "repeat"; from: number; times: number }
  | { type: "end" }
  | { type: "chat"; mint: MintRef; text: string; showCreatorBadge?: boolean };

interface ScenarioStep { id: number; block: ScenarioBlock; onFail?: OnFail }
interface ScenarioPlan { v: 1; ttlSecs?: number; steps: ScenarioStep[] }

// SignedAction +=
  | { op: "scenario_create"; plan: ScenarioPlan; replaces?: string }   // → { id, status: "active" | "waiting_start" }
  | { op: "scenario_start"; id: string }                                // → { id, status: "active" }
  | { op: "scenario_cancel"; id: string } | { op: "scenario_cancel"; all: true }   // → { id, status: "cancelled" }
// Тело scenario_*: pad до 16 КиБ (create с картинкой — ≤ 1 МиБ). Лимит pad поднять с 8192 до 16384.

interface Scenario {                       // Portfolio.scenarios (≤ 5: активные первыми, затем закрытые ≤ 24 ч)
  id: string;
  status: "waiting_start" | "active" | "done" | "failed" | "cancelled" | "expired";
  createdAt: number;                       // вниз до минуты
  expiresAt: number;                       // вверх до часа
  cursor: number;
  plan: ScenarioPlan;                      // эхо плана; адреса и UA — маской, text/meta/ciphertext — без содержимого
  steps: { id: number; status: "pending" | "waiting" | "running" | "done" | "skipped" | "failed";
           runs: number; nextAt?: number /* вниз до минуты */; actionId?: string; orderId?: string; error?: ErrorCode }[];
  error?: ErrorCode;
}
```
- Новые коды ошибок:
  - `scenario_invalid` (400, `details: {step, code}`) — структура, ссылки, диапазоны;
  - `scenario_rule` (422, `details: {step, code}`) — P1–P9;
  - `scenario_limit` (422) — активных > 3;
  - `scenario_not_active` (409) — start/cancel не из нужного статуса.
- Сценарные действия попадают в `Portfolio.actions` как обычные `buy`/`sell`/… (связь — `steps[].actionId`), ордера — в `Portfolio.orders`.
- Векторы: `core/testdata/scenario-vectors.json` — планы → ожидаемый результат валидации (`ok` | код и шаг). Фронт и core проверяют по одним векторам.
- `Portfolio` с планами может перерасти 4096 байт. Предлагаю паддинг портфеля до **8192 для всех** (Q9), чтобы размер ответа не выдавал наличие сценариев.

---

## 7. План по этапам и параллельность

### 7.1 Что с чем пересекается
- **Миграция сумм на NUMERIC/u128 идёт сейчас** в `core/ledger/src/actions.rs`, `orders.rs`, `core/api/src/actions.rs` и миграциях. Сценарии трогают **те же** файлы в трёх местах:
  - выделение `*_in`-вариантов: `order_create`, `order_cancel`, `claim`, `fl_*`, `chat`;
  - варианты `SignedAction`;
  - поля `Portfolio`/`PoolInfo`.

  Эти правки делать **только после мержа NUMERIC**, одним PR.
- Новые таблицы сразу в `NUMERIC(78,0)`, суммы в Rust — `u128`, в API — строки. Номер миграции — следующий после NUMERIC: согласовать с backend до создания файла.
- **adapters/ не трогаем**: шаги — обычные задания. **INTEL не трогаем**: всё нужное уже есть в `intel_prices` и `token_safety`.
- web: новые файлы `app/scenarios/*`, `components/scenarios/*`, `lib/scenarios/*`. Из общих файлов меняются только `lib/api/types.ts` и моки. Торговую панель, launch и withdraw не трогаем: формы блоков переиспользуют их компоненты на чтение.

### 7.2 Этапы
| # | Этап | Кто | Зависит от | Дни |
|---|---|---|---|---|
| S0 | API.md v0.19 по этой спеке + `scenario-vectors.json` | backend (по согласованию с лидом) | — | 0,25 |
| S1 | Типы плана, разбор, валидатор, правила P1–P10 (чистые функции, новые файлы, юнит-тесты по векторам) | backend (core) | S0 | 1,0 |
| W1 | Типы v0.19, моки, клиентский валидатор по векторам | frontend | S0 | 0,5 |
| W2 | Конструктор: палитра по 8 категориям, линейный список, формы блоков, `onFail`, «≈» по полам, предупреждения | frontend | W1 | 1,5 |
| S2 | Миграция и ledger: `scenarios`/`runs`/`sealed`, переходы, janitor 24/48, `K_scn` | backend (core) | **NUMERIC смержен** | 0,5 |
| S3 | Исполнитель: waits, `manual_start`, buy/sell/sell_all через `build()` + savepoint, `onFail`/retry, cancel/stop-all/expire, `AmountSpec`/`MintRef` | backend (core) | S1, S2 | 1,25 |
| W3 | Экран «Review & sign» (человеческое резюме всех шагов, адреса), черновики в зашифрованном блобе, `Portfolio.scenarios`, отмена / стоп всего, UX-состояния | frontend | W1 | 1,0 |
| S4 | Триггеры: price/time/deposit/own_result/curve + `check_safety` | backend (core) | S3 | 0,75 |
| S5 | `order_place`/`order_cancel`, swap, dca, repeat; `*_in`-варианты | backend (core) | S3 | 0,5 |
| S6 | create/fl_*/claim/withdraw/chat + запечатывание | backend (core) | S3 | 0,5 |
| W4 | 4 шаблона, связка с реальным беком | frontend | S3–S6 | 0,75 |
| S7 | Тесты: гонки (cancel/шаг/ордер), идемпотентность (падение до коммита), ретеншн, «ни одного RPC» в исполнителе, полы, флаг | backend | S3–S6 | 0,5 |
| A1 | Ревью кода и приватности | analyst | S7, W4 | 0,5 |
| | **Итого** | | | **бек ~5,25 · фронт ~3,75 · ревью 0,5** |

Параллельно с первого дня можно вести S1 и W1–W3: они не трогают файлы миграции NUMERIC.

**Порядок урезания внутри фичи**, если понадобится (ядро сценария — T1 и T3, их не трогать):
1. `chat`;
2. `fl_*`;
3. `repeat`;
4. `curve_progress`;
5. `check_safety`;
6. `own_result` по внешним `orderId`/`actionId`;
7. `swap` как блок (оставить T4 из `sell` + `wait_random` + `buy`).

**Не резать:** полы P1–P3, P8; запечатывание адресов; ретеншн; savepoint.

---

## 8. Находки и риски (по убыванию)

**HIGH**
- **S-1 · Автоматический Now после события** (тик, депозит, ордер) даёт точную связку «публичное событие → сделка через секунды». *Исправление:* P1.
- **S-2 · «Пополнил → купил» без человеческой задержки** привязывает сделку к блоку Zcash `B + K + r`. *Исправление:* P3, пол 10–40 мин.
- **S-3 · «Купил → вывел»** в одном плане связывает новый адрес с покупкой по таймингу, даже со срезкой A1. *Исправление:* P2.
- **S-4 · Адрес вывода хранится у оператора до 72 ч** до исполнения, рядом с anon-ключом. *Исправление:* §4.4: шифрование ключом вне БД, удаление при постановке задания и при закрытии.
- **S-5 · Триггер по mint вне пула** заставил бы индексатор читать этот mint из-за сценария, и это видно RPC. *Исправление:* P8.
- **S-6 · `submit_in` без savepoint**: строка `actions` остаётся после отказа по балансу, курсор сломан. *Исправление:* §3.3 п. 5 + тест.

**MEDIUM**
- **S-7 · Одинаковые срезы DCA и повторов** склеивают сделки и раскрывают стратегию. *Исправление:* P5.
- **S-8 · Swap «X SOL → X SOL».** *Исправление:* P6.
- **S-9 · Чат сразу после своей сделки** связывает ник с размером сделки. *Исправление:* P4.
- **S-10 · Fair-launch-блоки в бандле или в `PoolInfo` при выключенном флаге** раскрывают фичу до 28.10. *Исправление:* P10, ленивый чанк.
- **S-11 · Догоняющее исполнение после простоя** даёт пачку сделок одного плана. *Исправление:* §3.4, новые `next_at`.
- **S-12 · Черновики и имена планов в открытом `localStorage`.** *Исправление:* только зашифрованный блоб.

**LOW**
- **S-13 · Размер тела `scenario_create`** отличает создание плана от сделки. Принято: факт «у IP есть сценарий» без содержимого.
- **S-14 · Рост `Portfolio` при наличии планов.** *Исправление:* общий паддинг 8192 (Q9).
- **S-15 · Логи исполнителя** с id, mint или временем. *Исправление:* только счётчики.
- **S-16 · Публичная метрика сценариев.** Не добавлять никогда.

---

## 9. Судейский взгляд
- **Впечатлит:** «одна подпись → пополнение shielded ZEC → покупка → bracket → выход в shielded ZEC, и в момент сделки от пользователя нет ни одного запроса». Это сильнее ручного Delayed против сетевого наблюдателя. Плюс правила P1–P3, которые сервер навязывает сам: судьи из Zcash-сообщества оценят, что автоматизация не стала утечкой. В видео — T1 и полы на экране «Review & sign».
- **Риск:** объём (~9 человеко-дней) поверх Bags/LaunchLab/деплоя. Для демо достаточно T1 и T3 на devnet (Jupiter и Bags — только mainnet).
- **Чего не хватает для Grand Prize:** честного абзаца в README («a scenario is an intention held by the operator ≤ 72 h; the chain and the network never see it run») и теста «исполнитель не делает RPC».

---

## Открытые вопросы для лида / владельца

1. **TTL плана ≤ 72 ч**, как у ордеров. DCA на неделю тогда невозможна. Ок, или 7 суток только для планов без выводов?
2. **Now в сценариях — только сразу после ручного старта** (P1). Подтверждаете?
3. **`wait_fixed` фактически «≈»** (±10 %, минимум ±30 с), а время у `time_at` + до 10 мин. Ок?
4. **Hold в момент шага**, а не при создании плана: шаг может упасть с `insufficient_balance`, если пользователь потратил баланс вручную. Ок?
5. **«Пополнение ≥ X»** = сумма **депозитов** после взвода триггера, без выручки от продаж и claim. Так задумано?
6. **Лимиты:** 3 активных плана на ключ, 12 блоков, 40 исполнений. Ок?
7. **`fl_bid` только в уже опубликованный запуск** (ставка в свой `fl_create` из того же плана невозможна криптографически: раунд неизвестен при подписи). Ок?
8. **Ордера плана:** отменяются при отмене или истечении плана, а при успешном завершении остаются. Ок?
9. **Паддинг `Portfolio` до 8192 для всех** (+4 КиБ трафика на опрос) — берём?
10. **Флаг `UNZEEN_SCENARIOS`** — включать на публичном деплое до 28.10 или, как fair-launch, только 28.10?
11. **Номер миграции и момент встраивания** — после мержа NUMERIC. Нужна дата от backend, чтобы поставить S2.

## Источники (проверено 2026-10-13, по репозиторию, HEAD `131bb34`)
- Путь действия и hold: `core/ledger/src/actions.rs:200-410` (`submit`/`submit_in`, `ON CONFLICT (anon_pubkey, nonce)`, hold до отказа — нужен savepoint).
- Ордера как образец исполнителя: `core/ledger/src/orders.rs:435-766` (свой tx на ордер, случайный порядок, E20 случайные nonce/request_hash, A5/A6 срезка, перенос hold), `:770-785` (janitor 24/48 ч).
- Построение действия: `core/api/src/actions.rs:471` (`pub async fn build`), `Epochs` `:179-227`.
- Ценовой проход: `adapters/src/intel/indexer.ts:383-425` (только pump.fun-кривая и DBC SOL-конфиг, только `pinned`), `core/migrations/0011_orders.sql` (`intel_prices`).
- Правила Now, выводов, депозита: `docs/analysis/now-mode.md` N-1, N-10; A1/A5/A6 — `docs/analysis/final-audit.md`; R6 — `docs/analysis/chat.md:23,152`.
- Внешние источники не использовались: всё, что спека предлагает, опирается на существующий код и API v0.17.
