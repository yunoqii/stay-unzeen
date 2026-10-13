# Unzeen — контракт core ↔ relayer

Источник правды для `core/` (Rust, API + реестр) и релейера (`adapters/`, TS). Меняет backend по согласованию с лидом. Схема: `core/migrations/0002_relayer.sql`, `0003_payouts_epochs.sql`, `0004_relayer_state.sql`, `0005_exec_mode.sql`, `0006_exec_mode_scrub.sql`, `0008_fair_launch.sql`, `0009_verify.sql`, `0010_creator_fees.sql`, `0011_orders.sql`, `0012_fair_review.sql`, `0013_creator_stats.sql`, `0014_verify_review.sql`, `0015_rebalance.sql`, `0017_fair_bundle.sql`, `0018_discovery.sql`, `0019_quotes.sql`, `0020_quote_fees.sql`, `0021_bracket_orders.sql`, `0022_bags_first_buy.sql` (применяет core при старте; релейер миграции **не** запускает и схему не меняет).

Статус: **v10** (13.10; миграция `0022_bags_first_buy.sql`; API.md v0.16). Изменения против v9:

1. **Bags (`venue = 'bags'`, только `mainnet-beta`).** Core ставит задания `bags` только на mainnet. Площадка — только пары к SOL.
2. **`create` на Bags: всегда `lamports_in = 0`.** Первая покупка пользователя — **отдельное задание** того же действия: `op = 'buy'`, `part = 1`, `venue = 'bags'`, `lamports_in` > 0, `min_out` (0 или от кривой Bags, если есть своя строка `launch_curves`). Core вставляет его со статусом **`held`**: релейер его не видит в выборке (берёт только `queued`) и не трогает. Когда `create` (`part = 0`) стал `confirmed` с `out_mint`, core (раз в 1 с) ставит покупке `mint = out_mint`, `status = 'queued'`, `not_before = max(not_before, now())` — дальше это обычный `buy`. Если `create` `failed` — core переводит покупку в `failed` с тем же `error_code`.
   - **Vault:** покупка должна идти с того же vault, что запуск. Релейер закрепляет `mint_vaults(mint → vault)` при подтверждении Bags-`create` (vault задания, не launch wallet), и `buy` берёт vault из `mint_vaults`, как всегда.
   - Не атомарно: между запуском и покупкой кто-то может купить (API.md v0.16 это говорит пользователю).
3. **Факт `create` Bags в `confirmed`:** `out_mint` обязателен, `out_token_amount = 0`, `out_lamports = 0`, `out_creator_fee = 0` (launch-tx Bags creator fee пулу не даёт). Creator fees Bags пока не собираются: строк `creator_fee_sweeps` с `venue = 'bags'` не писать.
4. **Settlement `create` из двух заданий:** токены `buy` (`part = 1`) — это первая покупка создателя (лок создателя), упавший `buy` возвращает свою долю ZEC; `create` прошёл → комиссия запуска удержана. Действие закрывается, когда закрыты оба задания (`held` тоже считается незакрытым).
5. `committed_sol` (резерв SOL под очередь) учитывает и `held`.

Прав роли не добавилось (`status` — та же колонка). Перезапустить `infra/relayer-role.sql` после миграции — как всегда.

Изменения v9 против v8:

1. **Пул A для USD1 — Raydium CLMM** SOL/USD1 (не DAMM v2); для USDC — Meteora DAMM v2 SOL/USDC, как было (adapters `7cea54a`).
2. **Creator fees в quote-токенах (заменяет п. 8 v8).** Sweeper для сбора в quote пишет `quote_mint` и `quote_amount` (базовые единицы, дошло до vault) и:
   - **USDC/USD1:** `lamports` = SOL-эквивалент `quote_amount` по котировке пула A на момент сбора (**обязательно**). Core зачисляет создателю именно эти лампорты. `lamports` NULL или `0` при `quote_amount > 0` → core строку **не зачисляет** и ждёт (деньги не теряются).
   - **ZEC SPL:** `lamports` = `0` или NULL (не читается). Core зачисляет `quote_amount` 1:1 в зат (ZEC SPL 8 знаков = зат), сначала удерживая creator fee launch-tx ZEC-запуска (`creator_tokens.launch_fee_zat_left`). Пул-часть пишет core в `creator_fee_sweeps.pool_quote_amount`.
   Прав не добавилось (`quote_mint`, `quote_amount`, `lamports` уже есть у роли с v8).
3. **`trades.sol_amount` ZEC-пар:** релейер по-прежнему пишет `0`. Core проставляет SOL-эквивалент `floor(quote_amount × lamports_per_zec / 1e8)` по своему курсу до публикации события в ленту (сделки старше 15 мин остаются `0`), а `tokens.price_sol` ZEC-токенов — `price_quote × курс`. Релейеру эти поля после записи не трогать.
4. **`out_creator_fee` ZEC-запуска** — в единицах ZEC SPL (как `out_quote_amount`); USDC/USD1 — лампорты-эквивалент (как `out_lamports`).

Изменения v8 против v7 (миграция `0019_quotes.sql`; API.md v0.13). Согласовано с adapters `a756224` (пары к USDC для DBC и pump.fun, `fund_quote`, пул A). Изменения против v7:

**A. Пары не к SOL.**
1. **`create` в паре:** `meta.quote` = `"USDC"` | `"USD1"` | `"ZEC"` (нет поля или `"SOL"` = SOL). `raydium-launchlab`: ещё `meta.platform` = `"unzeen"` | `"bonk"` | `"stonk"` (platform id захардкожены в адаптере, сверка `claimWallet` при старте). `buy`/`sell` пары не несут: пара — свойство кривой mint. `fair_create` — только SOL.
2. **Реестр в лампортах (USDC/USD1).** `lamports_in`, `min_out` (sell), `out_lamports` — лампорты, как у SOL-пар. Релейер пересчитывает их в quote по **пулу A** (закреплённый пул SOL/quote: USDC — Meteora DAMM v2, USD1 — Raydium CLMM (v9); котировка локально из состояния пула), тратит **запас quote на vault**; если запаса не хватает — своп-нога SOL→quote ExactOut **в той же tx** (fallback, отдельной tx перед сделкой — никогда). `out_lamports` = лампорты-эквивалент потраченного/полученного quote по той же котировке пула A (+ SOL своп-ноги, если была).
3. **ZEC SPL (`A7bd…QXaS`, stock-only, без пула A, решение лида).** Для заданий в паре к ZEC **суммы — в базовых единицах ZEC SPL** в тех же колонках: `buy`/`create`: `lamports_in` = ZEC SPL к трате, `min_out` = мин. токенов; `sell`: `min_out` = мин. ZEC SPL; `confirmed`: **`out_lamports = NULL`**, `out_quote_mint` = ZEC SPL mint, `out_quote_amount` = ZEC SPL потрачено/получено (лампорты считает core). Confirmed `buy`/`sell`/`create` без `out_lamports` и без `out_quote_amount` core не закрывает (алерт оператору). Core знает пару по `tokens.quote_mint` (для `create` — по `meta.quote`) и считает 1:1 к ZEC (реестр/Verify оценивают в лампортах по своему курсу ZEC/SOL). Своп-ноги нет: запаса не хватает → `failed`/`pool_liquidity`.
4. **Новая op `fund_quote`** (ставит core; `meta = {"quote": "<mint>", "vault": "<vault>"}`, `exec_mode = 'delayed'`, `action_id = NULL`, в ленту не пишется): держать запас quote на `vault` в политике релейера (`QUOTE_STOCK_<SYM>_TARGET/LOW/HIGH`): USDC/USD1 — одним свопом через пул A с самого vault; ZEC SPL — переводом с **rebalance-адреса** (туда его приносит ребаланс ZEC → ZEC SPL через 1Click). `confirmed`: `out_token_amount` = |quote units|, `out_lamports` = |лампорты|, `vault`; запас уже в границах → `confirmed` **без tx и без `signature`** (CHECK `0019` это разрешает для `consolidate` и `fund_quote`). Core закрывает задание сам. Расписание (core): USDC/USD1 — раунд раз в 45–90 мин (случайно), по vault в случайном порядке с паузами 20–120 с между заданиями; ZEC SPL — после каждого успешного ребаланса в ZEC SPL. Локальный раннер релейера (`RELAYER_QUOTE_STOCK=1`) после этого выключить.
4a. **Колонки факта пары (`0019`).** `relayer_jobs.out_quote_mint TEXT`, `out_quote_amount NUMERIC(78,0)` — базовые единицы quote, реально прошедшие через tx (`buy`/`sell`/`create` в паре не к SOL). USDC/USD1: заполнены вместе с `out_lamports`; ZEC: только они. Права роли: SELECT + UPDATE обеих колонок. `fund_quote` для ZEC исполняет **rebalance-адрес** (перевод ZEC SPL на `meta.vault`), для USDC/USD1 — сам vault.
5. **Лента и токены.** `trades.quote_mint`, `trades.quote_amount NUMERIC(78,0)` (базовые единицы quote, ровно из tx) — для сделок в паре не к SOL; `trades.sol_amount` — SOL-эквивалент (USDC/USD1 — по пулу A; ZEC — `0`). `tokens.quote_mint` (NULL = SOL), `tokens.price_quote` (десятичная, quote за 1 целый токен), `tokens.platform` (LaunchLab). `price_sol`/`market_cap_sol` — SOL-эквивалент или `0`.
6. **Снимок Verify** читает, кроме ATA из `mint_vaults`, **ATA всех quote-mint пула** из новой таблицы `pool_quotes (network, mint, quote, decimals, bridged)` (пишет core при старте; права релейера — SELECT) на каждом vault **и на rebalance-адресе**; в `verify_vaults.tokens` — как обычные `{mint, amount}`.
7. **Запас для ребаланса ZEC SPL:** в `pool_quote_inventory (network, quote_mint, vault_amount, reserve_amount, vault_count, slot, updated_at)` релейер раз в ~5 мин (вместе с `pool_sol_inventory`) пишет Σ quote на vault и на rebalance-адресе (`NUMERIC(78,0)`). Без строки ZEC SPL core ребаланс в ZEC SPL не планирует.
8. **Creator fees в парах не к SOL** (заменено п. 2 v9): sweeper пишет в `creator_fee_sweeps` ещё `quote_mint` и `quote_amount` (`lamports` = 0, если сбор был в quote). Core такие строки **пока не зачисляет** создателю (`credited_at` остаётся NULL до v0.14, деньги не теряются) — это поведение core, релейеру ничего не делать.
9. **Площадки:** CHECK `venue` во всех таблицах += `raydium-launchlab`, `bags` (`bags` core пока не ставит). `launch_curves` для `raydium-launchlab` — по желанию (иначе кап первой покупки из env).
10. **Права** (`infra/relayer-role.sql`, перезапустить): SELECT `pool_quotes`; SELECT/INSERT/UPDATE `pool_quote_inventory`; INSERT/UPDATE новых колонок `trades`, `tokens`, `creator_fee_sweeps`.

Изменения v7 против v6:

**A. Авторебаланс пула ZEC → SOL (NEAR Intents 1Click, `0015`).** Core (сканер `serve --rebalance`) сам меняет фиксированный лот ZEC на SOL, когда свободного SOL у пула мало. Релейер делает две вещи:
1. **Снимок SOL пула → `pool_sol_inventory`** раз в ~5 мин (и при старте): `INSERT ... ON CONFLICT (network) DO UPDATE SET vault_lamports, vault_count, rebalance_lamports, slot, updated_at = now()`. `vault_lamports` = Σ лампортов **всех торговых vault** сети, `vault_count` = их число, `rebalance_lamports` = баланс rebalance-адреса, `slot` — слот чтения (`confirmed`, провайдер чтения, `getMultipleAccounts`). Без строки или старше 15 мин core ребаланс не планирует. Права: SELECT/INSERT/UPDATE `pool_sol_inventory`.
2. **Новая op `fund_vaults`** (ставит core, `action_id = NULL`, `exec_mode = 'delayed'`, `meta = {"purpose":"rebalance"}`): одна tx с **rebalance-адреса** пула, `lamports_in` лампортов разнести по vault (System transfer; по умолчанию — доливать самые бедные vault до среднего, остаток поровну; без пользовательских данных — делить не по заданиям). Подпись до broadcast (шаг 2), `vault` = rebalance-адрес, `confirmed`: `slot`, `out_lamports` = сколько реально ушло (≤ `lamports_in`), `network_fee`. На rebalance-адресе не хватает SOL → `failed` / `pool_liquidity`. В `trades` ничего. Core закрывает задание сам (`settled_at`), упавшее переставляет через 10 мин (всего до 5 попыток), потом `attention` и алерт оператору. Заморозка Verify действует (как на `transfer`).
   **Rebalance-адрес**: отдельный ключ пула (предложение: `m/44'/501'/2147483645'/4'` из creator master seed сети, как ключи аттестаций), **не vault, не creator, не ключ аттестаций**; его pubkey оператор кладёт в `UNZEEN_REBALANCE_SOL_ADDRESS` сканера. Core отказывается, если адрес совпал с vault. С rebalance-адреса **нельзя** пополнять ключи аттестаций (он публично связан и с 1Click, и с vault). Адрес входит в список адресов снимка Verify (как все ключи пула, v4 п. 2).
   **Что публично:** на Zcash — unshield фиксированного лота из Ironwood на t-адрес депозита 1Click (сумма и время видны; сумма — константа из env, время — порог запаса SOL + случайная задержка 10–60 мин, не депозиты/действия); у 1Click/в его explorer — связь «t-адрес депозита → rebalance-адрес на Solana»; на Solana — переводы rebalance → vault. Всё это уровень пула (vault и так публичны через Verify); anon-ключей, депозитов и сделок пользователей ни одна из этих записей не касается. Core тратит только «свой» ZEC пула: `spendable ≥ Σ балансов пользователей + лот + запас`, иначе ребаланс не делается.

**B. Fair-launch v2: Jito-бандл на несколько vault (`0017`, только mainnet).**
1. **`fair_create` как бандл:** нога 0 = create + первая покупка с vault A (за ним закрепляется mint, D4), ноги 1..4 = покупки с других vault, всё одним Jito-бандлом. **Jito/tip — только в бандлах fair-launch**; все остальные tx пула (в т. ч. `now`) — без Jito, единый CU price. На devnet Jito нет → одна tx (кап по vault A, как v3).
2. **`relayer_jobs.bundle_legs JSONB`** = `[{"sig","vault"}]` ног **1..4** (не нога 0). Писать при `sent` (до отправки бандла, вместе с подписью ноги 0) и ещё раз при `confirmed` — ровно те ноги, что легли в цепочку (в т. ч. найденные заново после рестарта). Core обнуляет при settle (вместе с `mint_secret`). Права: SELECT, UPDATE (`bundle_legs`).
3. **`confirmed` для `fair_create`:** `signature`, `slot`, `vault` — от ноги 0; `out_token_amount`, `out_lamports`, `network_fee`, `out_creator_fee` — **суммы по всем легшим ногам**. **Частичное исполнение принимается**: `out_lamports < lamports_in` и `out_token_amount < min_out` — не ошибка (часть ног не легла / кап по vault). Core делит токены и потраченное пропорционально эффективным суммам (T·e_i/E, S·e_i/E), неиспользованная часть hold каждого участника возвращается.
4. **Лента:** `create` + `buy` ноги 0 (подпись ноги 0) и отдельный `buy` на каждую ногу 1..4 со своей подписью, слотом и `blockTime` (как в цепочке).
5. **Новая op `consolidate`** (вместо повторов в памяти релейера): при settle подтверждённого `fair_create` core ставит по одному заданию на каждый vault из `bundle_legs`, отличный от vault A: `op='consolidate'`, `mint`, `dest` = vault A, `meta = {"from": <vault ноги>, "try": n}`, `exec_mode='delayed'`, `action_id = NULL`. Релейер: перевести **весь** баланс `mint` с `meta.from` на `dest` (ATA получателя создать при необходимости, платит `from`), подпись до broadcast, `vault` = `meta.from`, `confirmed` с `out_token_amount` = переведено (0, если пусто — тоже `confirmed`, **без tx и без `signature`**: для `consolidate` CHECK это разрешает, миграция `0018`). В `trades` ничего, `mint_vaults` не меняется (mint уже за A). Заморозка Verify — как для `transfer`. Core закрывает задания сам; `failed` → новое задание через 10 мин, всего до 6 попыток, затем алерт оператору (позиция всё равно учтена в Verify — токены на vault пула).

**C. Права роли** (`infra/relayer-role.sql`, перезапустить): + SELECT/UPDATE `relayer_jobs.bundle_legs`; + SELECT/INSERT/UPDATE `pool_sol_inventory`. Список op в claim-запросе релейера: + `fund_vaults`, `consolidate` (оба — полоса пачек, `exec_mode = 'delayed'`).

Изменения v6 против v5:
1. **`out_creator_fee` (0013).** Для `create` и `fair_create` в `confirmed` записывать `out_creator_fee` = комиссия создателя, начисленная **этой** launch-tx (pump.fun: `TradeEvent.creatorFee` покупки запуска; DBC: доля создателя в комиссии свопа). Это деньги создателя/участников запуска, по решению владельца они остаются пулу: core вычитает их из первых сборов mint. Нет колонки или поле `NULL` → core берёт верхнюю оценку (`UNZEEN_LAUNCH_CREATOR_FEE_BPS_*`: pump.fun 30 б.п., DBC 40 б.п. от `out_lamports`). Права: SELECT/UPDATE `out_creator_fee`.
2. **Verify: `min_slot` (0014, review E2).** При переходе снимка в `collecting` core пишет `verify_snapshots.min_slot` = максимальный `slot` подтверждённых и уже учтённых реестром заданий сети (NULL — таких нет). Релейер читает балансы vault на `finalized` с `minContextSlot = min_slot` (все куски `getMultipleAccounts`) и повторяет попытки, пока finalized не догонит (обычно ≤ 15 с, заморозка 120 с). Ответ со слотом < `min_slot` не записывать. Права: SELECT `verify_snapshots.min_slot`.
3. **Полоса `attest` и заморозка.** `attest` (оба назначения) берётся в **своей полосе**, первым, независимо от `exec_mode`, и **вне заморозки Verify** (заморозка останавливает только торговые задания и `transfer`). `attest` без `blockTime` в `confirmed` не переводится: tx перечитывается позже (`out_block_time` обязателен — от него зависят `beforeRound` fair-launch и `anchor.blockTime` Verify).
4. **Подпись оператора до якоря (review E10).** Для `attest` с `meta.purpose = "verify"` записывать `out_sig` (подпись ключом аттестаций над `hex_decode(meta.memo)`) и `vault` (= публичный ключ аттестаций) **при записи `sent`** (после подписи tx, до broadcast; у очереди нет ключей, поэтому не при claim). Core публикует `operator` снимка, как только подпись прошла проверку (strict ed25519 против дайджеста самого снимка), а `anchor` появляется после `confirmed`. Если memo-tx подтвердилась с `matches = false`, core ставит новое `attest` (как при `failed`).
5. **Verify: что считает core (для понимания балансов vault).** Дерева `SOL` больше нет: комиссии создателей к выплате входят в ZEC-лист создателя по курсу buy. `committedLamports` = только газ стоящих в очереди `transfer` (SOL под стоящие в очереди buy/create остаётся активом). Резерв ZEC пишет сканер (политика подтверждений K), во время заморозки сканер не отправляет новые выплаты ZEC.
6. **`min_out` квантуется core** вниз до 3 значащих цифр при постановке любого задания (ручные buy/sell, ордера, `fair_create`; review E4). Релейер передаёт его в инструкцию как есть, своих пересчётов не делает. У ордеров `min_out` считается от цены публичного тика, а не от триггера.
7. **Jupiter (`venue = 'jupiter'`)**, только mainnet: core отклоняет его на devnet до hold (`venue_unavailable`). Для mint, которых нет в `tokens`, цены у пула нет: buy/sell принимаются только с явным ненулевым `minOut`/`minZecOut` пользователя. Env релейера: `JUPITER_API_KEY` (необязателен, без него — keyless с паузой), `JUPITER_API_URL` (по умолчанию `https://api.jup.ag/swap/v2`), `JUPITER_MIN_INTERVAL_MS` (пауза между запросами), `JUPITER_CU_LIMIT` (700000), `JUPITER_SLIPPAGE_BPS` (300).

Изменения v5 против v4:
1. **Два ключа аттестаций (review F14).** `attest` несёт `meta.purpose`: `"verify"` — ключ оператора Verify `m/44'/501'/2147483645'/2'`, `"fair"` — отдельный ключ fair-launch `m/44'/501'/2147483645'/3'` (оба — жёсткие ветки creator master seed сети, как в `adapters/src/attest.ts`). Core пишет `purpose` всегда; задания без него (созданные до v5) считать `"fair"`. Публичные ключи (devnet): verify `GLScqi…`, fair `2zWX…` (полные — в `adapters`, выводятся из сида).
   **Доменные теги.** Ключ аттестаций подписывает любые 32 байта (`out_sig` над `hex_decode(meta.memo)`). Поэтому каждый новый тип memo обязан хешировать с **собственным** доменным тегом (как `unzeen/verify/v1/snapshot` у Verify; корень fair-launch — Merkle с префиксами 0x00/0x01 и отдельным ключом), чтобы подпись одного типа нельзя было выдать за другой.
   **Повтор якоря Verify.** Если `attest` снимка Verify упал (например, `pool_liquidity`: на ключе нет SOL), core ставит новое `attest` с тем же memo раз в 10 мин, не больше 12 заданий на снимок. Ключи аттестаций **НЕЛЬЗЯ** пополнять с vault: публичный перевод vault → ключ аттестаций связал бы торговые кошельки пула с подписантом Verify/fair-launch. Пополнение — только из внешнего источника, не связанного с vault (решение лида).
2. **`out_block_time` (review F2).** Для `attest` в `confirmed` записывать `out_block_time` = `blockTime` подтверждённой tx (unix секунды). Core по нему считает `beforeRound` (корень лёг в Solana до раунда drand) и `anchor.blockTime` Verify. Права: SELECT/UPDATE `out_block_time`.
3. Заморозка Verify и `fair_create` — без изменений; раунд fair-launch теперь не раньше чем через 30 с после закрытия окна, `attest` идёт в полосе `now` — релейеру нужно отправить его в эти 30 с (одно задание за раз не должно стоять за долгим `fair_create`: `attest` брать первым).
4. Ордера (API.md v0.8) релейер не видит: сработавший ордер — обычные `buy`/`sell` в эпоху. `creator_fee_sweeps` и сборщик — п. 4 v4 ниже.

Изменения v4 против v3 (Verify; миграция `0009_verify.sql`, API.md v0.7, спека `docs/analysis/verify.md`):
1. **Freeze на время снимка Verify.** Пока у сети есть снимок в `freezing`/`collecting` с `freeze_until > now()`, релейер **не берёт новые задания** (обе полосы). К WHERE claim-запроса п. 1 добавить:
   `AND NOT EXISTS (SELECT 1 FROM verify_snapshots v WHERE v.network = $2 AND v.status IN ('freezing', 'collecting') AND v.freeze_until > now())`.
   Задания `claimed`/`sent` доводятся как обычно (core ждёт, пока их не станет). Freeze ≤ 120 с, раз в сутки в 00:00 UTC (mainnet) или по ручной команде (devnet).
2. **Снимок активов vault.** Опрос раз в 1–2 с: `SELECT id, chain_id FROM verify_snapshots WHERE network = $1 AND status = 'collecting' AND assets_done_at IS NULL`. Для такого снимка:
   - адреса: **все** ключи пула, которые держит релейер (vault, адреса creator с накопленными комиссиями, ключ аттестаций);
   - балансы на **одном `finalized`-слоте**: `getMultipleAccounts` (commitment `finalized`) по адресам и их ATA для всех mint из `mint_vaults` (оба token-программы), через провайдера чтения (Shyft). Больше 100 аккаунтов → несколько запросов с `minContextSlot` = слот первого; если слоты разошлись — повторить. `solana_slot` = этот слот;
   - подпись каждого адреса его ключом: ed25519 над `utf8("unzeen/verify/v1/vault\n" + chain_id + "\n" + id + "\n" + address)`, base58;
   - `INSERT INTO verify_vaults (snapshot_id, address, lamports, tokens, sig)` (`tokens` = `[{"mint","amount"}]`, только ненулевые, суммы строками в базовых единицах), затем `UPDATE verify_snapshots SET solana_slot = $2, assets_done_at = now() WHERE id = $1 AND status = 'collecting'`.
   Успеть до `freeze_until`, иначе core пропустит снимок (повтор через 10 мин). Ключи и подписи tx не логировать; адреса и балансы публичны.
3. **`attest` → `out_sig`.** Для каждого `attest` (fair-launch и Verify) релейер дополнительно пишет `out_sig` = base58 ed25519-подписи **ключом аттестаций** над 32 байтами `hex_decode(meta.memo)`. Core проверяет её против `vault` (= публичный ключ аттестаций) и только тогда публикует как подпись оператора. Задания Verify приходят с `exec_mode = 'delayed'` (раз в сутки, срочности нет).
4. **Сборщик creator fees** (`adapters/src/relayer/fee-sweeper.ts`, миграция `0010_creator_fees.sql`, схема `creator_fee_sweeps` взята из `PROPOSED_FEE_SWEEPS_SQL` без изменений). Глобально по своему расписанию (случайно раз в 6–12 ч), никогда по запросу пользователя: все claimable-цели площадок (адреса creator пула, partner-сторона DBC) выше порога, в случайном порядке, **одна tx на цель**, приёмный vault по ротации, тот же CU price / Sender tip, что у всех tx пула. Строка `sent` с подписью **до** broadcast; `confirmed` с `lamports` (дошло до vault), `slot`, `swept_at`; `failed`. `credited_at` пишет **только core**: `kind = 'creator'` → на `claimable` создателя (`creator_tokens.anon_pubkey` по mint) на ближайшей границе эпохи Delayed, `credited_at` до часа; `partner` и mint без создателя Unzeen — выручка пула. Пользовательский `claim` — только операция реестра.
   Env: `RELAYER_FEE_SWEEP=1` — сборщик внутри `relayer:run` (иначе разовый `pnpm fees:sweep`); `FEE_SWEEP_STORE=postgres` — писать в `creator_fee_sweeps` (иначе `fee-sweeps.json` в каталоге ключей; на общей БД теперь `postgres`); `FEE_SWEEP_MIN_LAMPORTS` — нижний порог суммы цели (по умолчанию 2 000 000, и не меньше 5× стоимости tx). DBC: `METEORA_DBC_CONFIG_<NET>`.
5. Права роли (`infra/relayer-role.sql`; v6: + SELECT/UPDATE `relayer_jobs.out_creator_fee`, SELECT `verify_snapshots.min_slot`): `creator_fee_sweeps` — гранты из `PROPOSED_FEE_SWEEPS_GRANTS` (SELECT без `credited_at`, INSERT, UPDATE `status, lamports, slot, swept_at`, sequence); SELECT/UPDATE `relayer_jobs.out_sig`; SELECT (`id, network, chain_id, status, freeze_until, assets_done_at`) и UPDATE (`solana_slot, assets_done_at`) на `verify_snapshots`; SELECT/INSERT на `verify_vaults`. К деревьям, листьям и балансам пользователей доступа нет.

Изменения v3 против v2 (fair-launch, миграция `0008_fair_launch.sql`; **внутреннее до 28.10 23:59 UTC**):
1. **Новая op `fair_create`** — одна атомарная v0-tx create+buy fair-launch (спека `docs/analysis/fair-launch.md` §3). Как `create`, но: **mint keypair задан core** в новой колонке `mint_secret` (64 байта: seed 32 ‖ pubkey 32, формат Solana `Keypair.fromSecretKey`) и **один и тот же на всех попытках** — повтор не может создать второй mint (`prepareCreate(..., { mintKeypair })`). `lamports_in` — вся покупка запуска (до 25 % саплая, может быть ≫ обычного create), `min_out` > 0 (котировка по свежей кривой минус граница комиссии и 50 bps). `exec_mode = 'now'`, `not_before = now()`, `action_id = NULL` (задание связано с запуском в `fl_launches.job_id`, релейеру это не видно). Тот же путь отправки и тот же единый CU price, что у всех tx пула, **без Jito**. `confirmed`: `out_mint` = pubkey из `mint_secret` (обязательно), `out_token_amount`, `out_lamports`; в `trades`/`tokens` — как для `create` (`create` + `buy` с одной подписью), mint закрепить за vault (`mint_vaults`). `mint_secret` **никогда не логировать**; core обнуляет его при settle.
2. **Новая op `attest`** — memo-tx (программа SPL Memo `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) с данными ровно `meta.memo` (UTF-8, 64 hex корня commitment, без префиксов), подписанная **отдельным ключом аттестаций пула** (не vault, не creator; один на сеть, хранится как ключи vault: age, `$UNZEEN_HOME/<cluster>/solana/`), он же платит fee. `exec_mode = 'now'`, `action_id = NULL`, `venue`/`mint`/`lamports_in` = NULL. `confirmed`: `signature`, `slot`, `vault` = **публичный ключ аттестаций**, новая колонка `out_memo` = data memo-инструкции, **прочитанная из подтверждённой tx** (`getTransaction`), а не из задания. В `trades`/`tokens` ничего не писать. Ошибка → `failed` (запуск продолжается без аттестации).
3. **Таблица `launch_curves (network, venue, virtual_sol_lamports, virtual_token_reserves, real_token_reserves, token_total_supply, updated_at)`** — релейер пишет параметры кривой из on-chain конфига площадки (pump.fun: `OnlinePumpSdk.fetchGlobal()`: `initialVirtualSolReserves`, `initialVirtualTokenReserves`, `initialRealTokenReserves`, `tokenTotalSupply`) при старте и раз в 10 мин (`INSERT ... ON CONFLICT (network, venue) DO UPDATE`). Core считает из неё капы (`maxInitialBuyLamports`, кап fair-launch 25 %). Строка `meteora-dbc` — по желанию (иначе core берёт кривую pump.fun с запасом 5/5,013). Без строки pumpfun fair-launch на сети недоступен (`fl_create` → 503).
4. Права роли (`infra/relayer-role.sql`, перезапустить): SELECT `mint_secret`, SELECT/UPDATE `out_memo`; SELECT/INSERT/UPDATE `launch_curves`. На `fl_*` прав нет.
5. Claim-запрос п. 1 возвращает `mint_secret` (добавить в `RETURNING`). Задания `fair_create`/`attest` закрывает core (`settled_at`), обычный settler их не трогает.

Изменения v2 против v1:
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
| `op` | core | `buy` \| `sell` \| `create` \| `transfer` \| `fair_create` (v3) \| `attest` (v3) \| `fund_vaults` (v7) \| `consolidate` (v7) \| `fund_quote` (v8) |
| `venue` | core | `pumpfun` \| `meteora-dbc` \| `jupiter` \| `raydium-launchlab` \| `bags` (v10, mainnet) (NULL для `transfer`) |
| `mint` | core | base58 mint (NULL для `create`) |
| `lamports_in` | core | `buy`: лампорты на покупку; `create`: первая покупка (0 = без покупки) |
| `token_amount` | core | `sell` / `transfer`: базовые единицы токена |
| `min_out` | core | `buy`/`create`: мин. токенов; `sell`: мин. лампортов |
| `meta` | core | `create`: `{"name","symbol","image"?}`; `image` — `data:image/(png\|jpeg\|webp);base64,…` (≤ 512 КБ) |
| `dest` | core | `transfer`: свежий Solana-адрес получателя |
| `gas_lamports` | core | `transfer`: капля SOL получателю на комиссии (отправить вместе с токенами) |
| `network` | core | `devnet` \| `mainnet-beta`. Релейер берёт только свою сеть |
| `exec_mode` | core | `now` \| `delayed` \| `max` (0005); `now` — сразу, тот же единый priority fee, что у всех tx пула, без Jito. NULL после settle |
| `status` | оба | `queued` → `claimed` → `sent` → `confirmed` \| `failed`; v10: `held` (только core: первая покупка Bags до подтверждения запуска; релейер не берёт и не меняет) → `queued` |
| `not_before` | core (+ relayer: только увеличение) | граница эпохи / задержка вывода; раньше не брать. Релейер может отложить (backoff), но не ускорить |
| `attempts`, `claimed_by`, `claimed_at`, `lease_until` | relayer | аренда задания |
| `signature`, `last_valid_block_height` | relayer | пишутся **до** отправки tx |
| `vault` | relayer | публичный адрес vault, подписавшего tx (учёт релейера); для buy/sell/transfer = `mint_vaults.vault` этого mint |
| `slot`, `out_mint`, `out_token_amount`, `out_lamports`, `network_fee` | relayer | факт исполнения (см. ниже) |
| `error_code`, `error_message` | relayer | при `failed`; код из списка ниже, сообщение без данных пользователя |
| `mint_secret` | core | v3, `fair_create`: keypair mint (64 байта), один на все попытки; NULL после settle. Не логировать |
| `out_memo` | relayer | v3, `attest`: data memo из подтверждённой tx |
| `out_sig` | relayer | v4, `attest`: base58 ed25519 ключа аттестаций над `hex_decode(meta.memo)` |
| `out_block_time` | relayer | v5, `attest`: blockTime подтверждённой tx, unix секунды |
| `bundle_legs` | relayer | v7, `fair_create`: `[{"sig","vault"}]` ног 1..4 бандла; NULL после settle |
| `settled_at` | core | реестр закрыт; после этого релейер строку не трогает |

### Операции и что вернуть в `confirmed`

| op | Вход | `out_token_amount` | `out_lamports` | Прочее |
|---|---|---|---|---|
| `buy` | `venue, mint, lamports_in, min_out` | токенов получено | лампортов фактически потрачено (≤ `lamports_in`, комиссии площадки включены, network fee и рента — нет) | |
| `sell` | `venue, mint, token_amount, min_out` | токенов продано (≤ `token_amount`) | лампортов получено | |
| `create` | `venue, meta, lamports_in, min_out` | токенов от первой покупки (0 если без) | лампортов на первую покупку | `out_mint` обязателен. creator — свежий адрес пула (не vault) |
| `create` Bags (v10) | `venue='bags', meta, lamports_in = 0` | `0` | `0` | `out_mint` обязателен, `out_creator_fee = 0`; закрепить `mint_vaults` на vault задания; первая покупка — задание `buy` `part = 1` (было `held`) |
| `buy`/`sell`/`create` в паре к ZEC (v8) | суммы в единицах ZEC SPL | как выше | **`NULL`** | `out_quote_mint`, `out_quote_amount` обязательны; core читает `COALESCE(out_lamports, out_quote_amount)` в единицах quote |
| `transfer` | `mint, token_amount, dest, gas_lamports` | токенов отправлено (= `token_amount`) | 0 | с vault этого mint (`mint_vaults`) вместе с каплей SOL `gas_lamports`; отдельная tx на каждую часть |
| `fair_create` (v3) | `venue, meta, lamports_in, min_out, mint_secret` | токенов куплено | лампортов на покупку | `out_mint` = pubkey `mint_secret`; creator — свежий адрес пула; одна v0-tx + ALT |
| `attest` (v3) | `meta.memo` | — | — | `vault` = ключ аттестаций, `out_memo` из подтверждённой tx, `slot` |
| `fair_create` бандл (v7) | как v3 | Σ по ногам | Σ по ногам | `signature`/`slot`/`vault` ноги 0, `bundle_legs`; частичное исполнение допустимо |
| `fund_vaults` (v7) | `lamports_in` | — | реально разнесено | с rebalance-адреса на vault, `vault` = rebalance-адрес |
| `consolidate` (v7) | `mint, dest, meta.from` | токенов переведено | — | весь баланс `mint` с `meta.from` на `dest` (vault A), `vault` = `meta.from` |
| `fund_quote` (v8) | `meta.quote`, `meta.vault` | |quote units| | |лампорты| | запас quote на `meta.vault`; в границах → `confirmed` без tx |

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
          j.meta, j.dest, j.gas_lamports, j.attempts, j.mint_secret;   -- v3
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
