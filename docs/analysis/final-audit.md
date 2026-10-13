# Финальный аудит (дни 13–14): core/ и adapters/ на HEAD

Автор: analyst · Дата: **2026-10-13** · Объект: HEAD `a0e782a` (API.md v0.16, RELAYER.md v10, миграции до `0022`), `infra/`. Фронт (`web/`) смотрел по HEAD точечно и **с пометкой «в работе»**: там параллельно идут правки, находки по нему предварительные.
Внутреннее, **до 28.10 23:59 UTC не публиковать** (есть детали fair-launch v2 / Jito).
Код только читал. Ничего не собирал и не запускал, тесты не гонял.

Правило ZECATHON: любая утечка связи «пользователь ↔ сделка», в том числе третьей стороне, ведёт к дисквалификации. Поэтому ниже разделено, что видит **публика / третья сторона**, а что только **оператор** (доверенная сторона по README).

---

## TL;DR

1. **Critical нет.** Ни один поток не отдаёт публике или третьей стороне anon-ключ, связку «депозит ↔ сделка» или «IP ↔ сделка» в режимах Delayed/Max. Ядро сделано аккуратно: одна транзакция Postgres на nonce + hold + задания, подпись tx пишется в БД до broadcast, единый CU price и чаевые Sender на всех tx vault, `min_out` квантуется, ордера срабатывают по цене тика, отдельные HD-ветки ключей по ролям, роль релейера без `action_id`.
2. **Три high надо закрыть до сдачи.**
   - **A1.** `withdraw_token` уходит в цепочку **точной суммой**. В ARCHITECTURE/FEATURES обещано округление, но его нет. Сценарий «купил → вывел всё» связывает новый адрес пользователя с его публичной покупкой. Это ровно тот сценарий, который будут повторять судьи.
   - **A2.** На mainnet выплаты ZEC больше 0.05 ZEC ждут ручного разбора. Пять таких выплат в голове очереди блокируют **все** выплаты.
   - **A3.** Деплой. Данные Postgres лежат в docker-томе вне зашифрованного раздела (N2 не развёрнут). Конфига обратного прокси нет (access-логи, gzip поверх паддинга, лимит по IP).
3. **Новые паттерны v0.15–v0.16:**
   - **rearm** повторяет ту же сумму токенов (A5, medium);
   - первая покупка Bags может упасть, потому что vault выбран без запаса SOL, а в запасном варианте у неё `min_out = 0` (A4, medium);
   - guard Jupiter не видит других счетов vault (A7, medium);
   - выплаты ZEC вещаются через тот же публичный lightwalletd, что и кошельки пользователей (A8, medium).

   Единый fee-профиль после CU-классов не сломан, пыль quote ничего не раскрывает, фондер Bags и `ArBv9x` в порядке (подробно — в разделе «Новые паттерны»).

**Счёт находок этого аудита:** critical 0 · high 3 · medium 7 · low 8.

---

## Блокеры для сдачи (закрыть до 28.10)

| # | Что | Кто | Оценка |
|---|---|---|---|
| **A1** | Округлять сумму `withdraw_token` на сервере: итог и каждую часть smart вниз до 3 значащих цифр, остаток остаётся на балансе. Плюс отказ или авто-сдвиг, если сумма совпадает с `trades.token_amount` этого mint | backend (core) + frontend (текст) | 1–2 ч |
| **A2** | Выплаты больше капа не должны блокировать очередь. Кап для демо поднять | backend (core) | 30 мин |
| **A3** | Postgres на зашифрованный том. Конфиг Caddy/nginx в `infra/` без access-логов и gzip для `/api/*`. Лимит по IP за прокси (A9) | backend (infra) + лид | 1–2 ч |

Настоятельно советую закрыть до видео ещё **A4** (Bags на mainnet-демо), **A5** (rearm), **A7** (Jupiter) и **A9** (лимит по IP под нагрузкой судей). Каждая из них — 30–90 мин.

---

## 1. Сквозная приватность по потокам

Наблюдатели:
- **Ц** — on-chain (Zcash и Solana публично);
- **С** — сеть пользователя и VPS (ISP, провайдер VPS как сетевой узел; видит IP, время и размер TLS, но не содержимое);
- **П** — провайдеры (zec.rocks, Helius, Shyft, Jupiter, 1Click, Jito, Bags API, Raydium/Meteora — только программы, HTTP-API Raydium не вызывается);
- **БД** — оператор или утечка БД;
- **VPS** — провайдер VPS с доступом к хосту.

| Поток | Ц | С | П | БД (утечка) | Что связывается |
|---|---|---|---|---|---|
| **Депозит → баланс** | shielded tx в Ironwood, сумма скрыта (кроме `publicSource`) | IP → кошелёк → lightwalletd пользователя | zec.rocks видит broadcast tx от IP пользователя. Пул скачивает **все** shielded tx блоков (H1), поэтому депозиты не выделены | `deposits` (pk, сумма, день), wallet.sqlite (txid ↔ memo ↔ pk) | Публике — ничего. Оператору — pk ↔ депозит (принято) |
| **buy/sell SOL, Delayed/Max** | vault покупает/продаёт; сумма SOL округлена до 0.001 SOL со срезкой 0–1 %, `min_out` — 3 значащие цифры; время — граница эпохи | POST в T, сделка в эпоху T+30..60 с (Max 5–15 мин) | Helius (Sender + симуляция) видит tx до landing; Shyft — чтения vault | 24 ч: `action_id` ↔ задание ↔ подпись; потом `token_balances` = текущая позиция pk | Публике: при полной продаже — пара «buy X ↔ sell X» одного (анонимного) человека (A6). Оператору — всё в пределах 24–48 ч |
| **buy/sell, Now** | tx неотличима от Delayed (тот же CU price, чаевые, CU-класс). Видна только как «одиночка вне границы эпохи» | **POST в T → tx в T+1–3 с**: сетевой наблюдатель VPS связывает IP ↔ сделку | как выше | как выше | Сеть VPS — **да, по построению** (README, UI предупреждает) |
| **ZEC SPL пара** | траты ZEC SPL со срезкой, шаг 0.0001 ZEC | как buy | как buy; 1Click — ребаланс пула | как buy | Новых связей нет. Риск моста — README |
| **USDC/USD1 пара** | сделка из запаса quote или нога SOL→quote ExactOut в той же tx; CU-класс один на оба пути | как buy | Meteora/Raydium — только программы | как buy | Новых связей нет; пополнение запаса раз в 45–90 мин, не от сделок |
| **Лента** | — | WS/REST без подписи | — | `trades` публичны | Ничего о пользователе |
| **Вывод токенов** | vault → новый адрес: токены + капля SOL, задержка 30 с–5 мин (Max 10–60 мин) | POST в T, tx позже | Helius | `relayer_jobs.dest` до 24 ч после settle | **Сумма точная → совпадает с покупкой (A1, high)** |
| **Вывод ZEC** | shielded Ironwood→Ironwood, OVK discard, пачки до 5 | POST в T, выплата через 1–10 мин | **zec.rocks видит broadcast выплаты от пула и затем GetTransaction этой tx от IP кошелька пользователя (A8)** | `zec_payouts.to_ua` до подтверждения | Публике — ничего. Третьей стороне (zec.rocks) — «этот IP получил выплату Unzeen», без суммы |
| **Ордера (limit/TP/SL/bracket)** | обычная buy/sell в эпоху после публичного тика; `min_out` от цены тика | запроса в момент исполнения нет | — | `orders` до закрытия + 24 ч | Тайминг относительно тика — принято. **rearm повторяет ту же сумму (A5)** |
| **Чат** | — | POST ровно 1024 байт, публикация на границе эпохи | — | ник = HMAC(K_chat), в чат-таблицах нет pk. `api_nonces` 120 с: pk ↔ ник ↔ id | Публике — нет. Оператор с K_chat — да (README) |
| **Fair-launch v1** | одна tx create+buy с vault, memo с корнем от отдельного ключа | заявки — POST с tlock-шифротекстом | drand relays (сервер, раунд публичен) | `fl_bids` до 48 ч; сумма до раунда не известна никому | Публике — только итог и `"<5"` |
| **Fair-launch v2 (Jito)** | бандл до 5 vault, Jito-чаевые (видно, что это fair-launch), затем `consolidate` | — | Jito видит бандл (уровень пула); tip floor — фоном | `bundle_legs` до settle | Связывает vault между собой (они и так публичны в Verify) |
| **Verify** | memo-якорь ключом Verify | GET proof подписанный, ответ 64 КиБ | — | узлы деревьев 48 ч | Ничего (V1–V10, E1–E22 в основном закрыты) |
| **Creator fees** | сбор глобально раз в 6–12 ч, одна tx на цель, приёмный vault по ротации | claim — только реестр | — | `creator_claimable` (pk ↔ mint) | Запуски одного создателя не связываются (свежий creator, без дерева SOL — E5) |
| **Ребаланс ZEC→SOL / ZEC→ZEC SPL** | unshield фиксированного лота на t-адрес 1Click; rebalance → vault | — | 1Click: t-адрес ↔ rebalance-адрес | `pool_rebalances` | Уровень пула; триггер — запас SOL, а не действие пользователя |
| **Discovery** | — | один публичный список для всех | Helius (индексатор, программы) | `intel_discovery` | Ничего |
| **Поиск CA / safety** | — | GET без подписи | Helius: пачка из 8 с приманками | очередь без pk | Ничего (T3/T5 закрыты) |
| **LaunchLab** | create под platform `Unzeen`/bonk/stonk, свежий creator | как create | только программы (Raydium API не вызывается, `launchlab.ts:71`) | как create | Запуски Unzeen публично помечены platform id (by design) |
| **Bags** | launch wallet (свежий creator, заранее пополнен фондером) → create; через секунды покупка vault | как create | **Bags API видит метаданные и время запуска до публикации, IP сервера, API-ключ** | как create | Публике: «запуск Unzeen» (фондер в Verify) — by design. О пользователях Bags не знает ничего |

**VPS-провайдер** видит всё, что видит сервер в работе (том разблокирован): это доверие наравне с оператором (README).

---

## 2. Находки

Формат: **серьёзность · файл:строка · проблема · исправление**.

### CRITICAL
Нет.

### HIGH

**A1 · high · `core/api/src/actions.rs:837-897` (`WithdrawToken`), `:410-430` (`split_amount`), `web/components/portfolio/withdraw-panel.tsx:152-176` (в работе) · Вывод токенов уходит в цепочку точной суммой.**
ARCHITECTURE.md:54 и FEATURES.md:104 обещают «вывод всегда … с округлением суммы», но в core округления нет. Части smart в сумме дают ровно `amount`. Фронт только предупреждает, и то лишь по локальной истории браузера (`recentBuyAmounts`): на другом устройстве и после очистки истории предупреждения нет.
Демо-сценарий «купил 1 раз → Max → вывел» даёт on-chain `vault → новый адрес` на ровно `out_token_amount` публичной покупки того же vault. Это связывает новый Solana-адрес пользователя с конкретной сделкой (время, цена, размер). Как только пользователь двинет токены с этого адреса на свой кошелёк или биржу, связь становится личной.
*Исправление (core, ~1 ч):*
- итог вывода округлять вниз до 3 значащих цифр (как `quantize_min_out`) с предварительной случайной срезкой 0.5–2 %, остаток оставить в `available`;
- при smart квантовать каждую часть, а не только сумму;
- дополнительно отказывать (`400`, или авто-сдвиг на шаг вниз), если итог равен любому `trades.token_amount` этого mint за 30 дней.

В API.md: «сумма вывода округляется сервером, остаток остаётся на балансе». Во фронте: показывать «≈».

**A2 · high · `core/ledger/src/payouts.rs:30-41` (`ready_payouts … ORDER BY not_before LIMIT $1`) + `core/scanner/src/payout.rs:150-155` + `.env.example:38` (`UNZEEN_MAX_PAYOUT_ZAT=5000000`) · Блокировка всех выплат ZEC на mainnet.**
На mainnet выплата больше 0.05 ZEC пропускается («manual review»), но остаётся в выборке. Пять таких в голове очереди — и пакет пуст на каждом проходе, остальные выплаты не уходят никогда. Команды «одобрить» нет: разбор = поднять env и перезапустить. Отменить `withdraw_zec` пользователь не может. Судья, выводящий 0.1 ZEC, повиснет в `queued`.
*Исправление (~30 мин):*
- в SQL `AND (NOT $mainnet OR amount_zat <= $cap)`, большие выбирать отдельным запросом только для алерта;
- кап для демо — 0.5–1 ZEC;
- в RUNBOOK — процедура разбора;
- фронту — код состояния («on review»), чтобы не было вечного `queued`.

**A3 · high (деплой) · `infra/docker-compose.yml:34,45` (именованный том `pg-data`), в `infra/` нет конфига прокси; `core/api/src/lib.rs:199-205` · Решения N2/H9/E17/L-18 не развёрнуты, а инструкций для них нет.**
- Postgres пишет в `/var/lib/docker/volumes/…`, а не на LUKS/gocryptfs-том `UNZEEN_HOME`. Снапшот диска провайдера или утечка тома дают реестр за последние 24–48 ч, в том числе связку `action_id` ↔ подпись.
- Нет `nginx.conf`/`Caddyfile`. Стандартный access-лог пишет IP + путь (`/api/tokens/<mint>`, `/ws/feed?mint=`). gzip/br схлопнет паддинг пробелами в `/api/portfolio`, `/api/verify/proof` и POST. Лимит по IP за прокси становится общим на всех (A9).

*Исправление:*
- bind-mount `${UNZEEN_HOME}/<net>/pg:/var/lib/postgresql/data` (или `data-root` docker на зашифрованном томе);
- в `infra/` положить конфиг прокси: `access_log off` (или формат без IP и пути), `gzip off` / `encode` только для статики, `Cache-Control: no-transform` для подписанных путей, без `X-Forwarded-For`, `limit_req` на прокси;
- шаги — в RUNBOOK, и пройти их до открытия демо-URL.

### MEDIUM

**A4 · medium · `core/api/src/actions.rs:779-803` + `adapters/src/relayer/executors.ts:146-152` (`vaultRequest` create: `minSol = lamportsIn + 35M`, у Bags `lamportsIn = 0`) + `core/api/src/actions.rs:784-789` · Первая покупка Bags может упасть или пройти без защиты.**
- Vault для Bags-`create` выбирается без запаса под первую покупку, а mint закрепляется за ним (D4). Потом `held`-покупка на `lamports_in` упирается в `pool_liquidity`, после трёх claim — `failed`. Запуск прошёл, комиссия удержана, первой покупки нет. Деньги не теряются, но демо «запуск на Bags с initial buy» срывается.
- Если строки `launch_curves` для `bags` нет (ошибка чтения `ArBv9x…` при старте, `runtime.ts:356-361`), `min_out = 0`: на свежем пуле первую покупку сэндвичат боты без ограничения цены.

*Исправление:*
- core кладёт в `meta` create-задания `reserve_lamports` (сумма первой покупки), executor добавляет её к `minSol` (~20 мин);
- без своей строки кривой core отказывает в `initialBuyZec > 0` на Bags (`503 venue_unavailable`), а не ставит `min_out = 0`.

**A5 · medium · `core/ledger/src/orders.rs:228-266` (`rearm_on_slippage`), `:651-660, 706` (sell с `token_amount = amount`) · rearm повторяет ту же сумму токенов (риск из STATUS).**
Slippage обычно случается при резком движении цены (SL в обвал). Тогда упавшая tx **ложится в цепочку**: preflight прошёл, а исполнение — нет. Через 1–3 мин (тик + 2 тика взвода SL + эпоха) тот же vault продаёт **ровно ту же** сумму X. Наблюдатель видит автоматический повтор — значит, у кого-то стоит ордер на X. Если X = вся позиция = публичная покупка, он связывает покупку с наличием стопа и его уровнем (цена тика первой попытки).
*Исправление (~30 мин):* при каждом срабатывании sell-ордера (и при rearm) списывать `amount' = quantize3(amount × (1 − u·1 %))`, где u — случайное число, а остаток `amount − amount'` возвращать в `available` той же транзакцией. Тогда две попытки различаются, а сумма продажи не равна сумме покупки. В UI ордера показывать «≈ amount».

**A6 · medium · `core/api/src/actions.rs:592-661` (sell) · «Продать 100 %» = точная сумма публичной покупки.**
Связывает покупку и продажу одного анонимного пользователя: время входа и выхода, PnL. Личность не раскрывается, но это связь сделок одного человека, а она видна любому. (D5, частично.)
*Исправление:* то же квантование, что в A1/A5, для ручных sell с порогом (например, когда сумма совпадает с `trades.token_amount` mint) или всегда. Пыль остаётся на балансе (её можно вывести вместе со следующей продажей). Если владелец решит, что для обычных продаж это лишнее, вынести в README как известное ограничение.

**A7 · medium · `adapters/src/jupiter.ts:631-660` (`guard`) · Симуляция проверяет только SOL vault и ATA mint.**
Allowlist проверяет программы setup и cleanup, но аккаунты самой swap-инструкции Jupiter v6 не проверяет. Скомпрометированный или ошибочный ответ `/build` с `source` = другой ATA vault (запас USDC/ZEC SPL или токен другого mint) пройдёт guard на sell: токен mint не убыл, SOL пришло ≥ `minOut`. Settle зачислит пользователю выручку, а заплатит пул другим активом.
*Исправление (~45 мин):* в `simulateTransaction` передавать все token-аккаунты vault, записываемые в tx (writable keys с owner = vault). Требовать, чтобы убывал только ATA mint (sell) или wSOL (buy). Либо отказывать, если среди writable-аккаунтов swap-инструкции есть ATA vault, кроме ATA mint и wSOL.

**A8 · medium · `core/scanner/src/payout.rs:126,184` (broadcast через `client` = тот же `LIGHTWALLETD_URL`, zec.rocks) · Третья сторона связывает IP пользователя с выплатой Unzeen.**
Пул вещает выплату через zec.rocks. Кошелёк пользователя (ZODL, тот же zec.rocks по умолчанию) после обнаружения ноты делает `GetTransaction` этой tx со своего IP. zec.rocks видит: «tx P отправил сервер Unzeen, IP X её запросил», то есть IP X — пользователь Unzeen, вывел ZEC в момент T. Суммы и сделки он не видит. Cover-fetch (H1) прячет депозиты, но не выплаты.
*Исправление:*
- (а) вещать выплаты и unshield ребаланса через **другой** публичный lightwalletd (отдельный env `LIGHTWALLETD_SEND_URL`), сканировать через zec.rocks. Тогда zec.rocks не знает, что P — tx пула;
- (б) в README и на экране вывода: «use a lightwalletd other than zec.rocks or Tor for the receiving wallet».

Если второго оператора нет, остаётся (б).

**A9 · medium · `core/api/src/lib.rs:199-205`, `core/api/src/config.rs:599-600` (D11) · За прокси лимит по IP общий на всех: 20 rps / burst 60.**
Фронт опрашивает портфель, ленту, запуски, чат (10–15 с) и шлёт noop. 5–10 одновременных судей плюс WS-переподключения дают `429` всем, а один скрипт кладёт сервис.
*Исправление (10 мин):* если peer — loopback (прокси), лимит по IP не применять и полагаться на `limit_req` прокси (A3). Либо `API_RL_IP_PER_SEC` ≥ 200 в деплое. В RUNBOOK.

**A10 · medium (латентная) · `adapters/scripts/bags-fund.ts:33` · Фондер Bags всегда берёт `FileCreatorIndexCounter` и не пишет реестр `creator-pubkeys.json`.**
Пока `RELAYER_STATE=file` (RUNBOOK:48), счётчик общий с блокировкой, и всё безопасно. Но релейер при `RELAYER_STATE=postgres` берёт `PgCreatorIndexCounter`. Тогда `bags:fund` выдаст индекс, который релейер уже отдал pump/DBC-запуску: **один creator-адрес у двух запусков** (класс L-10, связывает запуски, а фондер Bags публично пополняет creator pump-токена). Реестр создателей (T1-гонка индексатора) не знает Bags launch wallets.
*Исправление:* в `bags-fund.ts` выбирать счётчик тем же кодом, что `buildRelayer` (`RELAYER_STATE`, `DATABASE_URL_RELAYER`), и передавать `CreatorPubkeyFile.inDir`. Либо выделить Bags-кошелькам отдельную ветку пути (`[44,501,0x7ffffffd,7,i]`).

### LOW

**A11 · low · `core/ledger/src/rebalance.rs:178-189` (`zec_liabilities`) · Обязательства для гейта ребаланса не включают `creator_claimable.zat` (комиссии ZEC-пар, долг в ZEC).** Ребаланс может продать ZEC, который должен создателям. Verify это покрывает SOL, но выплаты ZEC потом ждут. Обратного ребаланса SOL→ZEC нет вообще: при перекосе в продажи и выводы ZEC резерв пополняется только вручную (RUNBOOK).
*Исправление:* `+ COALESCE(sum(zat),0) FROM creator_claimable`.

**A12 · low · `core/api/src/market.rs:559-575` (D17) · WS-опрос `id > last` пропускает строки, закоммиченные не по порядку.** Теперь в одном процессе 3 полосы (now/batch/attest), и вставки `trades` из разных транзакций реально перемешиваются. Событие пропадает из живой ленты (REST его покажет).
*Исправление:* перечитывать окно `id > last − 50` с дедупликацией по id.

**A13 · low · `core/api/src/lib.rs:548-603` · Ответы-ошибки `POST /api/actions` не паддятся** (паддятся только успех, чат и noop). Размер TLS-ответа отличает `insufficient_balance` / `creator_locked` / `replay` от успеха. Наблюдатель — сеть VPS.
*Исправление:* в `ApiError::into_response` для подписанных путей — `padded(…, 1024)`.

**A14 · low · `adapters/src/bags.ts:431` (`markUsed` до отправки), `core/api/src/actions.rs:303-305` · Bags:**
- launch wallet помечается использованным до отправки tx: каждая неудачная попытка сжигает пополненный кошелёк (~0.05 SOL остаётся на нём, учитывается в Verify);
- выпустившийся Bags-токен core отклоняет на `venue: "bags"` (`graduated`), хотя адаптер умеет уходить в Jupiter. UI должен сам переключать на `jupiter`.

*Исправление:* `markUsed` после `reportSent` (или переиспользовать кошелёк, если tx провably expired и баланс цел); для `bags` + `graduated` в core направлять задание с `venue = 'bags'` (адаптер сам выберет Jupiter).

**A15 · low · `adapters/src/relayer/engine.ts:405` (L-16) · tx легла, но нечитаема → `retry` без лимита.** Hold висит вечно, алерта нет.
*Исправление:* после N claim — счётчик/алерт оператору (без данных задания).

**A16 · low (op-sec) · RUNBOOK:386, `adapters/src/attest.ts:26-32`, `adapters/src/bags.ts:63-64` · Пополнение ключей пула.** Код нигде не пополняет ключи аттестаций с vault/rebalance, это хорошо. Но источник средств — ручной.
- Ключ fair-launch (`…/3'`) **не пополнять из того же кошелька, что ключ Verify (`…/2'`)**: связь ключей раскрыла бы фичу до 28.10. После 28.10 это неважно.
- Фондер Bags (`…/6'`) и ключ Verify не пополнять с личного кошелька владельца: оба публичны в Verify.
- Один отдельный вывод с биржи на каждый ключ.

**A17 · low · `core/scanner/src/main.rs:246-257` (L-6) · `RUST_LOG=zcash_client_backend::sync=info` перебивает кап WARN** (более специфичная директива сильнее). Оператор может случайно вернуть txid в логи. *Исправление:* в `serve` игнорировать `RUST_LOG` для этих крейтов (строить фильтр без env для них) или падать при таком значении.

**A18 · low/medium · фронт (в работе, по HEAD) · Хвосты прошлых ревью:**
- D12 `script-src 'unsafe-inline'` (`web/next.config.ts:35`);
- D13 ссылки на Solscan из ленты (`components/feed/feed-item.tsx:114`): клик по своей сделке отдаёт Solscan/Cloudflare связку «IP ↔ tx». В статусе действия уже сделано копирование, так же нужно и в ленте;
- F11: создатель опрашивает `GET /api/launches/<id>` до публикации (`fair-launch-view.tsx:37-55`);
- L-2 автоблокировка 30 мин от unlock;
- L-4 `iterations` из хранилища без нижней границы (`lib/crypto/vault.ts:99`);
- E13 метка «Proven» у балансов vault (`solvency-table.tsx:78-80`).

Сам фронт сейчас ходит только на свой origin (CSP `connect-src 'self' api`), сторонних запросов, кроме ссылок, не нашёл.

---

## 3. Безопасность денег

Проверено и **в порядке**:
- **Идемпотентность и двойные траты.**
  - `submit_in`: nonce + hold + задания в одной транзакции; повтор того же тела → исходный квиток, другое тело → `409`; `UPDATE … WHERE available_zat >= $2` (`core/ledger/src/actions.rs:216-410`).
  - Ордера: перенос hold под `FOR UPDATE`, OCO одной строкой, rearm в транзакции settle (`orders.rs:228-266, 627-739`).
  - Claim и fl_*: тот же путь `submit_in`.
- **Двойная покупка и выплата.**
  - Подпись пишется до broadcast (`postgres-queue.ts:383-410`); повтор только после `getSignatureStatuses(history) = пусто && finalized height > lvbh` (`tx.ts:280-298`, `engine.ts:365-394`).
  - Выплаты ZEC: txid до broadcast, переотправка той же tx, новая — только после `expiry_height` на полностью просканированном tip (`payout.rs:113-136`).
- **Reorg.** Zcash: K + r подтверждений, `reorged` → freeze, автоснятие. Solana: в расчёт идут только `confirmed`/`finalized`, `processed` не считается (`tx.ts:290-296`).
- **Многошаговые действия.**
  - Bags `held`: релейер видит только `queued`; освобождение раз в 1 с; при неудаче create покупка становится `failed`; settle ждёт оба задания; доля ZEC упавшей покупки возвращается; лок = токены цепочки (`actions.rs:546-575, 675-765`).
  - Fair v2: частичное исполнение делится пропорционально; `consolidate` — до 6 попыток, потом алерт.
  - `fund_quote` / `consolidate` без tx разрешены CHECK `0019`.
- **Округления в пользу пула.** Hold = `ceil`, кредит sell = `floor`, возврат неистраченного pro rata, пыль fair — пулу, quote-покупка из запаса не записывает больше `lamports_in` (`executors.ts:225`).
- **Allowlist сторонних tx.**
  - Bags: подписанты, программы, creator/payer/base mint/quote/config, подпись mint, кап комиссии и CU, симуляция траты launch wallet (`bags.ts:236-272, 561-567`).
  - Jupiter: setup, cleanup, программа swap, `minOut`/threshold, симуляция. Есть дыра A7.
- **Ключи.**
  - Разделение ролей по HD-веткам creator master seed: vault — отдельные ключи; creators `[44,501,i,0]`; partner `0x7ffffffe/1`; Verify `/2`; fair `/3`; rebalance `/4`; Bags auth `/5`; Bags funder `/6`.
  - Ключи age-зашифрованы, на mainnet это обязательно (`runtime.ts:102-110`).
  - Сид Zcash — в age, ключ вне тома.
  - K_chat — файл 0600.
  - Роль релейера без `action_id`, проверка на старте, отказ на mainnet (`runtime.ts:73-81`); индексатор без пользовательских таблиц.

Открыто по деньгам: A2 (выплаты), A4 (первая покупка Bags), A7 (Jupiter), A11 (гейт ребаланса), A15 (вечный retry).

---

## 4. Новые паттерны (по заданию)

| Паттерн | Вывод |
|---|---|
| **rearm sell с той же суммой** | Утечка есть (A5, medium): повтор ровно той же суммы раскрывает ордер. Исправление — случайная срезка + квантование при каждом срабатывании |
| **Пыль quote** | Новых связей нет. Реестр USDC/USD1 ведётся в лампортах; остаток quote от ноги ExactOut и от продаж остаётся на vault (пулу). Пополнение запаса — по своему расписанию (45–90 мин, случайный порядок vault), ExactOut раскрывает только Σ публичных сделок vault. Пыль ZEC SPL ниже `dustBelow` в Verify не засчитывается (консервативно) |
| **Единый fee-профиль** | Сохранён. CU limit зависит только от класса операции (`pumpfun.ts:57-74`, `meteora.ts:85-94`, `launchlab.ts:151-155`, withdraw/attest/stock/fund — свои константы) и одинаков для пути «запас» и «нога». Режим (Now/Delayed/Max) на CU price, чаевые и форму tx не влияет: один кэш `PriorityFeeCache`, один `poolPrefix`, Sender-tip на mainnet везде. Исключения by design: бандлы fair-launch (Jito tip), launch-tx Bags (её строит Bags, подписывает launch wallet, не vault; выглядит как любой Bags-запуск), транзакции фондера Bags (не vault, без tip) |
| **`ArBv9x` Bags** | Хорошо: запуски под общим конфигом Bags на цепочке неотличимы от прочих Bags-запусков по конфигу. Чужой конфиг отклоняется (`bags.ts:427-429`). Риск — только запасной `min_out = 0` без строки кривой (A4) |
| **Связь ключей аттестаций** | В коде связи нет: отдельные пути, ключ fair не в списке Verify (F14), пополнения с vault/rebalance нет. Риск — ручное пополнение из одного кошелька (A16) |
| **Фондер Bags** | Пополняет launch wallets заранее, круглой суммой, по одному переводу, не с vault — хорошо. Публичен через Verify (`runtime.ts:222`), связь «фондер → launch wallet → Unzeen» — уровень пула (запуск Unzeen и так помечен в ленте). Проблема — счётчик/реестр creator в `bags:fund` (A10) |

---

## 5. Сводная таблица прошлых находок

Легенда: **закрыто** — кодом (проверено сейчас или в прошлых ревью); **README** — принято, описать в threat model; **открыто** — нужно действие; **фронт** — в работе у frontend; **деплой** — решено, ждёт развёртывания.

| Ревью | ID | Статус | Где / комментарий |
|---|---|---|---|
| day2 | C1 viewing key | закрыто | OVK discard, viewing key не публикуется |
| day2 | C2 оплата за действие | закрыто | memo только `deposit` |
| day2 | C3 вывод без газа | закрыто (механика) / **открыто: округление → A1** | `withdraw.ts`, `actions.rs:837` |
| day2 | H1 lightwalletd видит txid | закрыто | `scanner/src/cover.rs` (выплаты — A8) |
| day2 | H2 reorg | закрыто | K + r, `reorged` → freeze |
| day2 | H3 кто подписывает memo | закрыто | фронт, векторы |
| day2 | H4 логи/диск | закрыто в коде / **деплой (A3)** | том не развёрнут |
| day2 | H5 гонки баланса | закрыто | условные UPDATE |
| day2 | H6 публичные агрегаты | закрыто | `/api/stats` раз в сутки, k = 5 |
| day2 | H7 claim / EXIF | закрыто | `metadata.ts`, `assertSingleAuthority` |
| day2 | H8 тайминг | закрыто (эпохи) + README (Now) | — |
| day2 | H9 pubkey в URL / логи хостинга | закрыто в API / **деплой (A3)** | конфиг прокси |
| day2 | H10 DoS | закрыто (минимумы) / **открыто D11 → A9** | — |
| day2 | M1–M3 сервис сканера | закрыто (day3) | — |
| day2 | M4 выплата на t/Sapling | закрыто | `payout.rs` `orchard_only` |
| day2 | M5, M6, M8 | закрыто | — |
| day2 | M7 ops в memo | снято (только deposit) | — |
| day2 | M9 связка в БД | закрыто (D1) + README | `token_balances` = текущие позиции |
| day2 | M10 картинки из браузера | закрыто (T2) | `/media` |
| day2 | M11 малый anonymity set | README | — |
| day2 | M12 pre-release librustzcash | README | — |
| day2 | M13 ребаланс | закрыто | фиксированный лот, триггер по запасу SOL |
| day2 | L1, L3, L5 | закрыто | — |
| day2 | L2 зануление секретов | не перепроверял (low) | — |
| day2 | L4 пароль Postgres | деплой | сгенерировать |
| day2 | L6 путь ключа | принято | — |
| day2 | L7 QR с memo в видео | README / видео | одноразовый ключ |
| day3 | N1 двойная покупка | закрыто | подпись до broadcast |
| day3 | N2 wallet.sqlite / том | **деплой (A3)** | — |
| day3 | N3–N8, N10 | закрыто | — |
| day3 | N9 ключи на Desktop | закрыто | `~/.unzeen`, age на mainnet |
| day3 | N11 CSP | частично → фронт (D12) | — |
| day3 | L-1, L-3, L-5, L-7, L-11 | не перепроверял (фронт / low) | — |
| day3 | L-2 автоблокировка | открыто (фронт) | `session.ts:20` |
| day3 | L-4 iterations | открыто (фронт) | `vault.ts:99` |
| day3 | L-6 RUST_LOG | открыто → A17 | — |
| day3 | L-8, L-9 | закрыто | — |
| day3 | L-10 счётчик creator | закрыто / латентно → A10 | `bags-fund.ts` |
| day4 | D1 вечные суммы | закрыто + README | janitor 24/48 ч |
| day4 | D2 окно 3–20 с | закрыто (эпохи) | — |
| day4 | D3 t-адрес | закрыто (backend `publicSource`) | текст фронта — фронт |
| day4 | D4 vault на mint | закрыто | `mint_vaults` |
| day4 | D5 вывод = покупка | **открыто → A1 / A6** | — |
| day4 | D6, D7, D8, D9, D10, D14 | закрыто | — |
| day4 | D11 лимит по IP | **открыто → A9** | — |
| day4 | D12 `unsafe-inline` | фронт (A18) | — |
| day4 | D13 Solscan из ленты | фронт (A18) | — |
| day4 | D15 legacy-путь = mainnet | README (касается только ранних devnet-тестеров) | `keys.ts:27` |
| day4 | D16 газ фиксирован | принято (vault публичны, случайность ничего не прячет) | — |
| day4 | D17 WS по `id >` | **открыто → A12** | — |
| day4 | D18 buy неизвестного mint | закрыто дизайном v0.10 (явный `minOut`) | — |
| day4 | D19 WAL / мёртвые кортежи | README | — |
| day4 | L-16 вечный retry | **открыто → A15** | — |
| day4 | L-17 одна полоса | закрыто (3 полосы) | — |
| day4 | L-18 URL в логах прокси | **деплой (A3)** | — |
| day8 | E1, E2, E3, E4, E5, E6, E9, E10, E15, E16, E20, E21 | закрыто | проверено по коду |
| day8 | E7, E8 резерв ZEC / выплаты в полёте | закрыто (`verify_frozen` в выплатах; политика K — по API v0.10, код сканера не перепроверял) | — |
| day8 | E11, E22 | фронт | — |
| day8 | E12 доверие к данным оператора | частично: в mjs закреплён `--operator`; дедупликацию vault не перепроверял | `verify-proof.mjs` |
| day8 | E13 метка «Proven» | фронт (A18) | — |
| day8 | E14 изоляция тика Verify | закрыто для аттестаций (`attest_loop`) | `api/src/verify.rs:227` |
| day8 | E17 паддинг и gzip | **деплой (A3)** | — |
| day8 | E18 SQL на кусок | не перепроверял (perf) | — |
| day8 | E19 доки F14 | не перепроверял | — |
| fair | F1–F10, F12–F15 | закрыто | — |
| fair | F11 опрос до публикации | открыто (фронт, low) | `fair-launch-view.tsx:37` |
| intel | T1, T2, T3, T4, T5, T6, T8, T10 | закрыто | — |
| intel | T7 история дева | принято (Helius Developer) | — |
| intel | T9 Referer | закрыто (`no-referrer`, `noreferrer`) | — |
| verify | V1, V2, V3, V5, V7, V9 | закрыто | — |
| verify | V4, V6 | закрыто (через E1/E2/E7–E10) | — |
| verify | V8 суточная дельта | принято | — |
| verify | V10 опущенные пользователи | README + E11 (фронт) | — |
| orders | O1, O2, O3, O5, O6, O7, O9, O10 | закрыто | — |
| orders | O4 охота за SL | README | — |
| orders | O8 POST без сделки | принято (паддинг, noop) | — |
| now | N-1, N-3, N-4, N-5, N-6, N-8, N-9, N-12, N-14 | закрыто | — |
| now | N-2 опрос статуса | фронт (постоянный опрос портфеля) | — |
| now | N-7, N-10, N-11, N-13 | README / принято | — |
| chat | C-1, H-1, H-2, H-3, M-1, M-2 | закрыто | HMAC-ник, отдельный ник создателя, 1024 байт, без строк `actions`, без WS, допуск по стоимости аккаунта |
| chat | L-1 текст README | README | — |
| chat | L-2 размер ответов | принято | — |
| chat | R1–R6, R8 | реализовано | — |
| chat | R7 blind-токены | roadmap | — |

---

## 6. Что честно написать в README (threat model)

Ниже текст на английском, готовый для README (английский — по правилам проекта).

**Trust model**
- The operator runs the pool: it holds the vault keys, the Zcash pool seed and the ledger, so it can steal funds and, while data is fresh, link your anon key to your actions. MVP limitation. Roadmap: Squads multisig on vaults, FROST t-of-n on the Zcash side, ZK proof of reserves.
- The VPS provider can see what the running server sees (memory, network metadata). Data at rest sits on an encrypted volume unlocked by hand.
- Verify proves liabilities (Merkle-sum) and vault ownership. The ZEC reserve is **attested by the operator**, not proven (no viewing key is ever published). ZEC SPL on vaults is a **bridged** asset with issuer risk. Users who never check their proof can be omitted (general PoL limitation).

**What is private, what is not**
- Public on Solana: every pool trade ("unzeen bought…"), the vault addresses (listed on /verify), launches made through Unzeen (feed flag, LaunchLab platform "Unzeen", Bags launch wallets funded by a listed pool key). Not public: which anon key traded, deposits, balances, orders, bids before the drand round.
- Execution modes:
  - **Now** protects against chain observers only. Anyone who watches the server's network (VPS provider, ISP) sees your request and the trade seconds apart. Use Delayed / Max or Tor/VPN.
  - **Delayed / Max** batch trades on random epochs (30–60 s / 5–15 min).
- Small anonymity set: with few users, any unzeen trade is likely one of them. No cryptography hides that.
- Amounts: buys are rounded (0.001 SOL / 0.0001 ZEC with a random 0–1 % shave), `minOut` to 3 significant digits, withdrawals rounded (after A1). Selling or withdrawing exactly what you bought still lets anyone pair the two (the UI warns).
- Orders run on a public price tick: the trade timing follows that tick. A stop-loss is not a guaranteed exit.
- Bags: the first buy is a separate trade after the launch (can be sniped). Bags' API sees launch metadata and time before they are public, never users.
- Third parties:
  - Helius (send + fee estimate) and Jupiter (route build) see pool trades seconds before they land, without users.
  - Shyft and Helius see pool reads.
  - zec.rocks serves the pool's blocks (the pool fetches all shielded txs, so deposits are not singled out), and **can see that your wallet fetches a payout the pool broadcast**: use another lightwalletd or Tor for the receiving wallet (A8).
  - 1Click links the pool's transparent rebalance deposits to the pool's Solana rebalance address (pool-level, no users).
  - Jito sees fair-launch bundles.
- Database: settled trades lose their link to your key after 24 h; amounts and journals are erased after 48 h. A leak inside that window links your key to your trades. Current token balances per key stay (that is the ledger) and can be matched to public trades by amount.
- Chat: nicks are HMAC(K_chat, …) and differ per token. The operator, holding K_chat, can link nicks of one key. Messages publish on epoch boundaries.
- Creator rules (24 h lock, 5 % cap) apply to the launching key only: a second key bypasses them.
- Deposit from a transparent address or an exchange makes its amount and time public (the app flags it).
- Demo keys for judges are shared: anyone holding them sees the same portfolio.

**Roadmap (not in this build):** Tor (.onion) mirror, own lightwalletd, multisig/FROST, ZK proof of reserves, blind-token chat (Privacy Pass), anonymous creator reputation.

---

## 7. Судейский взгляд (кратко)

- **Впечатлит:**
  - «Now неотличим от Delayed на цепочке» (единый `poolPrefix`, тесты `uniform-tx.test.ts`);
  - cover-fetch всех shielded tx;
  - Verify с проверкой в браузере и офлайн-скриптом;
  - fair-launch с tlock и якорем до раунда;
  - ордера, которые не видны в цепочке и не раскрывают триггер.

  Это стоит показать в видео явно, с эксплорером.
- **Может сорвать впечатление:** A1 (судья выводит всё и находит свою покупку в Solscan за минуту), A2 (вывод ZEC висит), A9 (429 при нескольких судьях), A4 (Bags initial buy не прошёл).
- **Резать при нехватке времени** — по CLAUDE.md. Bags на демо показывать только после A4.

---

## Открытые вопросы для лида

1. A1/A6: округлять **всегда** (проще, однозначно) или только при совпадении суммы с публичной сделкой? Я за «всегда» для выводов и «при совпадении» для sell.
2. A8: есть ли второй публичный lightwalletd другого оператора для отправки выплат? Если нет — только README и подсказка на экране вывода.
3. A2: какой кап выплат на mainnet-демо (предлагаю 1 ZEC) и кто разбирает большие?
4. A3: кто пишет конфиг прокси — backend (`infra/`) или лид при деплое? Без него H9/E17/L-18 не закрыты.
5. Bags на mainnet-видео: показываем после A4 или убираем из сценария?
