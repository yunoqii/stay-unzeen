# Ревью дня 4: core/api + ledger actions + 0002, релейер, web v0.3

Автор: analyst · Дата проверки: **2026-10-12** · Объект: коммиты `8d75cbd` (core), `519ca37` (adapters), `95157cd` (web). Только чтение. Тесты не перезапускал, счётчики взяты из STATUS.md (их проверил лид).
Правило: любая утечка, в том числе третьей стороне = дисквалификация.

## TL;DR

1. **Аутентификация API и идемпотентность релейера сделаны правильно, critical нет.** Подписывается сырой request-target, есть `chainId`, `verify_strict`, окно ±60 с, nonce в Postgres (для GET отдельная таблица, для POST в той же транзакции, что hold). Тело парсится ровно из подписанных байт. IP/ключи/тела не логируются, ошибки Postgres сведены к SQLSTATE, на подписанных ответах `no-store`. Релейер пишет подпись до broadcast, `landed` считается только при `confirmed`/`finalized`, `expired` определяется по finalized-высоте, нулевые суммы не засчитываются. N1, N3, N6, N7, N10 закрыты.
2. **Отвязка `action_id` через 24 ч ничего не отвязывает.** `token_ops` и `actions` навсегда хранят точные суммы рядом с `anon_pubkey`, и эти суммы совпадают с публичными суммами сделок в Solana (D1). Ещё две утечки. Окно 3–20 с между POST и сделкой даёт провайдеру VPS или ISP связку IP ↔ сделка (D2). Депозит прямо с биржи или t-адреса раскрывает сумму и источник, а UI об этом молчит (D3).
3. **Риск сорвать демо.** sell и withdraw требуют, чтобы один vault держал всю сумму, а покупки разбросаны по vault случайно. Из-за этого «купил → вывел» в течение 30 мин и «продать всё после 2+ покупок» падают с `pool_liquidity` (D4). Ещё: `create` и `withdraw_zec` API принимает, но исполнителя у них нет, и деньги висят в hold бессрочно (D6). Боевого запуска релейера на Postgres нет (есть только devnet-скрипт на in-memory очереди), и он подключится под ролью владельца БД (D8).

---

## Статус находок прошлых ревью

### review-day2 (C/H)

| Находка | Статус | Где / комментарий |
|---|---|---|
| C1 viewing key | **Закрыто** (`/verify` исправлен, N8) | `web/app/verify/page.tsx` |
| C2 оплата за действие | **Закрыто** | memo только deposit |
| C3 вывод токенов без газа | **Закрыто по механике**: капля SOL + ATA в одной tx, задержка 30 с–5 мин, отдельная tx на часть. Правило «другой vault» сделано эвристикой и не даёт приватности (D4, D5) | `adapters/src/withdraw.ts:109-113`, `core/api/src/actions.rs:388-447` |
| H1 lightwalletd видит интерес к txid | **Открыто** (план: дни 4–5, не урезается) | `core/scanner/src/sync.rs` |
| H2 reorg | **Закрыто** + авто-разморозка (N4) | `ledger/src/lib.rs:454-468` |
| H3 кто подписывает memo | **Закрыто** | — |
| H4 связка в логах и на диске | **Почти закрыто**: SQLSTATE вместо DETAIL, Postgres `log_error_verbosity=terse`, ключи Solana в `~/.unzeen`. Остаток: шифрованный том решён, но не развёрнут (N2), L-6 | `infra/docker-compose.yml:15-26` |
| H5 гонки баланса | **Закрыто для ZEC и токенов** (`token_balances` с условным UPDATE) | `ledger/src/actions.rs:236-249` |
| H6 публичные агрегаты | **Частично**: id 128 бит, `/api/actions/:id` только владельцу. `/api/stats` (`zecShielded`) ещё нет | — |
| H7 claim / EXIF | **Открыто**: EXIF не чистится, картинка как есть уходит в `relayer_jobs.meta` (D9) | `core/api/src/actions.rs:211-226,356-359` |
| H8 тайминг | **Частично**: джиттер 3–20 с на действие, батчей нет (D2) | `core/api/src/config.rs:173-174` |
| H9 pubkey в URL | **Закрыто** в API/клиенте. Деплой: см. D13 | `web/lib/api/client.ts:140` |
| H10 DoS / rate-limit | **Закрыто частично**: лимит по ключу работает, лимит по IP за прокси становится глобальным (D11) | `core/api/src/lib.rs:123-129` |

### review-day3 (N/L)

| Находка | Статус | Где |
|---|---|---|
| N1 двойная покупка | **Закрыто** (подпись до отправки, `confirmed/finalized`, `expired` по finalized-высоте, один in-flight на vault в процессе). Новый остаток: D7 | `adapters/src/tx.ts:150-168`, `relayer/engine.ts:129-191` |
| N2 `wallet.sqlite` открытым текстом | **Решено** (LUKS/gocryptfs, ARCHITECTURE:77), **не развёрнуто** | infra |
| N3 DETAIL Postgres в логах | **Закрыто** | `ledger/src/lib.rs` (`sqlstate`, `error_chain`), compose |
| N4 вечная заморозка | **Закрыто** (`complete=false` → реестр не трогаем; `clear_reorg`) | `scanner/src/service.rs`, `ledger/src/lib.rs:454` |
| N5 точные времена/высоты | **Закрыто по перечисленным колонкам** (триггеры `date_trunc('day')`, `mined_height=NULL`). Связь по суммам осталась: D1 | `migrations/0002_relayer.sql:170-222` |
| N6 подпись не привязана к сети | **Закрыто** (`chainId` в подписи, ключ по сети). Остаток: D15 | `protocol/src/api_auth.rs:67-81`, `anon_key.rs` |
| N7 действия без hold обходят frozen | **Закрыто** (`SELECT frozen … FOR UPDATE` всегда, минимум для sell) | `ledger/src/actions.rs:210-220`, `api/src/actions.rs:314-323` |
| N8 «publishes a viewing key» в UI | **Закрыто** | — |
| N9 ключи adapters на Desktop | **Закрыто** (`~/.unzeen/<cluster>/solana`, chmod 700). Шифрование до mainnet: открыто | `adapters/src/keys.ts:18-21`, `config.ts:24-28` |
| N10 нулевые суммы | **Закрыто** (`amountsKnown`, retry вместо 0). Остаток: бесконечный retry (L-16) | `relayer/engine.ts:223-234` |
| N11 CSP | **Частично**: CSP есть, но `script-src 'unsafe-inline'` (D12) | `web/next.config.ts:35` |
| L-1 signer после lock | **Открыто** | `web/lib/crypto/session.ts:133-136` |
| L-2 автоблокировка 30 мин от unlock | **Открыто** | `session.ts:19,117` |
| L-3 слова фразы в state | не перепроверял | — |
| L-4 `iterations` без нижней границы | **Открыто**. Апгрейд v1→v2 ещё и переносит старое значение | `web/lib/crypto/vault.ts:99,119` |
| L-5 копирование anon ID | не перепроверял | — |
| L-6 cap логов обходится RUST_LOG | **Открыто**: `add_directive` менее специфичной директивы не перебивает `zcash_client_backend::sync=info` | `core/scanner/src/main.rs:182-193` |
| L-7 `changes={credited}` с временем | не перепроверял | — |
| L-8 тесты PG молча пропускаются | **Закрыто** (`REQUIRE_PG=1` в core и adapters) | `ledger/tests/ledger_pg.rs:46` |
| L-9 refund в memo v1 | **Закрыто** (убран) | `ledger/src/decide.rs` |
| L-10 счётчик creator не атомарен | **Открыто** (файл) | `adapters/src/keys.ts:104-118` |
| L-11 тихий откат на часы | не перепроверял | — |

---

## Новые находки

Формат: **серьёзность · файл:строка · проблема · исправление**.

### HIGH

**D1 · `core/migrations/0002_relayer.sql:10-21,37-46` + `core/ledger/src/actions.rs:580-598,629-656` · Отвязка `action_id` через 24 ч не отвязывает: точные суммы рядом с anon-ключом хранятся вечно и совпадают с публичными суммами в Solana.**
После `detach_old_jobs` остаются:
- `token_ops(anon_pubkey, mint, kind='buy_credit', delta_available = out_token_amount)`. Это **ровно** `trades.token_amount`, а значит и сумма TradeEvent в публичной tx. Чтобы связать anon-ключ с конкретной сделкой, достаточно одной таблицы и эксплорера. `action_id` здесь тоже не обнуляется;
- `actions(anon_pubkey, amount_zat, rate_lamports_per_zec, token_mint, token_hold)`. `floor(amount_zat × rate / 1e8)` даёт ровно `relayer_jobs.lamports_in` (хранится вечно), а `token_mint, token_hold` у sell/withdraw ровно равны `relayer_jobs.mint, token_amount`. Получаем связь с `signature`, хотя `action_id` уже NULL;
- `ledger_ops` (`settle`/`refund`): refund выводится из `out_lamports`, это ещё один отпечаток.

STATUS.md пишет «связывает … в пределах суток». На деле связь вечная. Сейчас утечка БД (бэкап, снапшот провайдера) = полная история «anon-ключ → сделки».
*Исправление (backend, ~2 ч):*
- в janitor через 24 ч после `settled_at`: `UPDATE actions SET amount_zat=0, fee_zat=0, hold_zat=0, rate_lamports_per_zec=NULL, rate_source=NULL, token_mint=NULL, token_hold=0` (CHECK позволяют);
- `DELETE FROM token_ops / ledger_ops WHERE created_at < now() - 48h` (баланс уже в `balances`/`token_balances`, журнал нужен только для отладки текущих суток). Если журнал нужен для аудита Merkle-sum, хранить агрегат на ключ, а не операции;
- у `relayer_jobs` после settle огрублять `created_at`, `claimed_at`, `not_before`, `updated_at` до часа. Релейеру они после settle не нужны;
- в README (threat model): «`token_balances` неизбежно хранит текущую позицию; при одной покупке она равна сумме сделки». Это остаточный риск, его закрывает только шифрованный том (N2).

**D2 · `core/api/src/config.rs:173-174`, `core/api/src/actions.rs:254`, `adapters/src/relayer/postgres-queue.ts:78-85` · Окно 3–20 с между POST и сделкой: сетевой наблюдатель (провайдер VPS, ISP, CDN) связывает IP со сделкой.**
Содержимое TLS третьей стороне не видно, но видно «IP X прислал POST ~200 байт в T». При малом объёме Unzeen следующая сделка vault пула в [T+3 с, T+20 с] почти однозначна. API.md обещает «батчи + джиттер», а в коде джиттер на каждое действие независимый (равномерный 3–20 с), релейер берёт `LIMIT 1 ORDER BY not_before`, батчей нет. Портфель опрашивается раз в 10–15 с подписанным GET, поэтому сам факт соединения не выдаёт. Выдаёт POST-всплеск плюс сделка.
*Исправление:*
- эпохи в релейере: брать все задания с `not_before <= epoch_end` раз в эпоху (случайно 20–60 с) и исполнять в случайном порядке, как в RELAYER.md §1;
- дефолт джиттера поднять до 15–120 с. В UI режим «Max privacy» (до 10 мин) для buy/sell, на демо оставить быстрый с честной подписью;
- README: «timing privacy scales with volume; network observers of the server can correlate request time with execution time within the jitter window».

**D3 · `web/components/pay/top-up.tsx:136` (текст оплаты) + `core/scanner` · Нет запрета и предупреждения на оплату с t-адреса или прямо с биржи.**
Если депозит идёт с прозрачного адреса (t→Ironwood) или выводом с биржи на UA пула:
- в цепочке видны t-адрес отправителя и **сумма**. Сумма ×курс = `sol_amount` первой покупки через несколько минут (см. D10);
- биржа (третья сторона с KYC) видит вывод на **публичный и единственный** UA пула Unzeen, то есть знает, что этот клиент — пользователь Unzeen, и знает сумму.

С review-day2 (C2) это висело как «проверить текст в UI». Текста нет.
*Исправление:*
- frontend: на Top up явный блок «Pay from a shielded balance (e.g. ZODL/Zashi shielded). Never withdraw from an exchange straight to this address: shield first, wait, then pay». Перед QR — чекбокс подтверждения;
- backend (дёшево): сканер видит полную tx и может пометить депозит с прозрачными входами (`vin` не пуст). Хранить флаг `from_transparent` без адресов и показывать владельцу в `DepositInfo` предупреждение «this deposit came from a transparent address; its amount is public».

**D4 · `adapters/src/relayer/vaults.ts:140-150`, `executors.ts:55-58,105-111`, `postgres-queue.ts:216-224` · sell и withdraw требуют, чтобы один vault держал всю сумму, а покупки разбросаны случайно. Демо-сценарии падают.**
- `withdraw`: исключаются vault, купившие этот mint за 30 мин (эвристика, `action_id` релейеру не виден). Свежий pump-токен, купленный один раз, лежит ровно на одном vault, и он исключён. Получаем `insufficient_tokens` → `pool_liquidity` → 3 claim → `failed`. Демо-скрипт обходит это, выбирая mint, который держат ≥ 2 vault (`scripts/relayer-devnet.ts:99`);
- `sell`: юзер купил 3 раза → токены на 3 разных vault → «продать всё» не найдёт vault с полной суммой → `pool_liquidity`, хотя у пула токенов достаточно;
- ошибка уходит юзеру как `pool_liquidity` («проблема пула»), разбираться в ней нельзя.

Правило «вывод с другого vault» приватности не добавляет: все vault публичны (Verify) и связаны графом пополнений, наблюдатель считает их одним субъектом. Приватность вывода определяют только сумма и время (D5).
*Исправление (решение лида, ниже вопрос 1):*
- (а) **позиция по mint на одном vault**: релейер назначает mint → vault при первой покупке и все buy/sell этого mint ведёт с него. sell всегда исполним. withdraw — с того же vault: правило «другой vault» снять в API.md/ARCHITECTURE как не дающее приватности;
- (б) если правило оставляем: перед выводом плановый внутренний перевод vault→vault по расписанию пула, не по запросу юзера, иначе тайминг. Это дольше и сложнее, для 16 дней не советую.

В обоих вариантах sell и withdraw должны уметь разбиваться на несколько tx из разных vault. Иначе после ротации старые позиции застрянут.

### MEDIUM

**D5 · `core/api/src/actions.rs:388-447` · Вывод токенов связывается с покупкой точной суммой.**
TradeEvent даёт точное число токенов (6 знаков). Вывод «всё, что купил» = то же число. `smart` делит на части ±20 %, но их сумма снова равна покупке (subset-sum по выводам одного mint за окно тривиален). Получатель сам по себе свежий, но он становится «тем, кто купил в сделке X», и все его части группируются.
*Исправление:*
- на фронте по умолчанию предлагать округлённую сумму (2 значащие цифры, остаток остаётся на балансе), предупреждать при точном совпадении с суммой любой покупки этого ключа (не только последней);
- дефолтная задержка вывода — до 30–60 мин, сейчас 30 с–5 мин;
- в README честно: «withdrawing exactly what you bought links the recipient to that buy».

**D6 · `core/api/src/actions.rs:337-387` vs `adapters/src/relayer/postgres-queue.ts:37` · `create` и `withdraw_zec` принимаются, но не исполняются; hold и адрес висят бессрочно.**
`OPS = ["buy","sell","transfer"]`, поэтому задания `create` никто не берёт, ZEC (комиссия + первая покупка) заморожен навсегда. У `withdraw_zec` нет исполнителя (API.md это признаёт), а `zec_payouts.to_ua` хранит личный UA юзера рядом с `action_id → anon_pubkey`. Это прямая связь, и удаления по таймеру нет.
*Исправление:* пока исполнителя нет, API отвечает `503 venue_unavailable` на `create`/`withdraw_zec`, а UI скрывает кнопки. В janitor: действия в `queued` старше N часов без исполнителя → `failed`, hold вернуть.

**D7 · `adapters/src/relayer/postgres-queue.ts:103-114` · Ошибка БД при `recentBuyVaults` помечает «в полёте» transfer как `failed`, и токены уходят дважды.**
`claim` возвращает и истёкшие in-flight строки (`status='sent'` с подписью). Если `recentBuyVaults` (или `rowToSpec`) бросит исключение, ветка `catch` пишет `failed/bad_request`, не проверив подпись в цепочке. Если tx уже приземлилась, core вернёт юзеру token hold, а получатель тоже получил токены, и пул теряет их.
*Исправление:* в `catch` для строк с `signature IS NOT NULL` не делать `failed`, а оставлять аренду (`retry`). `recentBuyVaults` вынести из `try` и при ошибке ставить `retry`. Тест: `sent`-строка + сбой запроса → статус не `failed`.

**D8 · `adapters/src/env.ts:103`, `infra/relayer-role.sql` · Релейер подключится под ролью владельца БД.**
Релейер читает `DATABASE_URL` из общего корневого `.env`, а там роль `unzeen` (владелец всех таблиц). Колоночный запрет на `action_id`, на котором стоит вся граница приватности в RELAYER.md, тогда не действует. Боевого раннера на Postgres пока нет, ловушка сработает при его написании.
*Исправление:* отдельная переменная `RELAYER_DATABASE_URL`. На старте релейер проверяет `SELECT has_column_privilege('relayer_jobs','action_id','SELECT')` и при `true` отказывается стартовать.

**D9 · `core/api/src/actions.rs:211-226,356-359` · Картинка `create` хранится как есть (с EXIF) в `relayer_jobs.meta` бессрочно.**
API.md:185 обещает, что сервер удалит EXIF и перекодирует. В коде проверка идёт только по префиксу и размеру. JPEG с телефона несёт GPS и серийник камеры. Если релейер позже зальёт файл в метаданные pump.fun (IPFS), это публичная вечная утечка. Плюс `meta` до 683 КБ в каждой строке очереди не чистится после settle.
*Исправление:* в core декодировать и перекодировать (crate `image`, вывод PNG/WebP без метаданных, ресайз ≤ 1024 px) до вставки задания. После settle обнулять `meta.image`. Это блокер для `create` на mainnet.

**D10 · `core/api/src/actions.rs:282-284`, `rate.rs:80-108` · Сумма сделки в SOL выдаёт введённую сумму ZEC с точностью до зат.**
`lamports_in = floor(zecIn × rate_applied / 1e8)`, курс один на окно кэша 45 с, и наблюдатель может получить ту же котировку 1Click. Делим `sol_amount` (или `lamports_in`) на курс и получаем `zecIn`. Это обычно круглое число (0.5 ZEC) и отпечаток. В паре с D3 (публичная сумма t→z депозита) получается прямое совпадение.
*Исправление:* добавлять к `lamports_in` случайный шум −0..−1 % (разница возвращается в ZEC через существующий refund) или исполнять сумму, округлённую до 3 значащих цифр SOL. Фронт по умолчанию предлагает некруглые суммы.

**D11 · `core/api/src/lib.rs:123-129`, `config.rs:68-71` · Лимит по IP за nginx становится глобальным: 20 rps на весь сервис.**
Peer всегда `127.0.0.1`. Одна вкладка с опросом ленты и портфеля даёт ~0.3 rps, так что десяток судей плюс бот сделают 429 для всех. Это риск доступности в судейский период.
*Исправление:* лимит по клиенту переложить на nginx (`limit_req_zone $binary_remote_addr`, без access_log), лимит IP в приложении отключать, когда `API_BIND` loopback (или поднять до 500 rps как предохранитель).

**D12 · `web/next.config.ts:35` · `script-src 'unsafe-inline'` при секрете в памяти JS.**
CSP почти не защищает от XSS: любой внедрённый inline-скрипт выполнится и прочитает слот сессии (ключ, фразу при reveal). Комментарий о PPR/nonce верный, но есть путь через хеши.
*Исправление:* `experimental.sri` (Next) плюс хеши inline-скриптов бутстрапа (`'sha256-…'`, `'strict-dynamic'`). Как минимум для `/key` и `/portfolio` отказаться от `cacheComponents` и использовать nonce. Добавить `require-trusted-types-for 'script'` после проверки совместимости.

**D13 · `web/components/feed/feed-item.tsx:92`, `web/lib/network.ts:103-108` · Ссылка на Solscan из ленты: клик по своей сделке сообщает Solscan/Cloudflare связку «IP ↔ tx».**
`no-referrer` не помогает, подпись лежит в самом URL. Типичный сценарий: юзер купил и кликнул «свою» строку в ленте через 10 с.
*Исправление:* ссылку на эксплорер скрыть за «copy signature» или показывать только у сделок старше N минут с подсказкой «opening an explorer reveals your IP to it». В README: «use Tor/VPN for explorers».

**D14 · `core/api/src/rate.rs:80-108` + `actions.rs:282` · Котировка 1Click запрашивается по требованию: NEAR/Defuse (третья сторона) видит моменты отправки действий.**
Кэш промахивается → запрос к 1Click внутри обработки POST. Запрос «пул спросил курс в T» = «кто-то отправил действие в T». Личности это не раскрывает, но сужает окно D2 для третьей стороны. Плюс `RATE_MAX_STALE_SECS=300`: при сбое 1Click курс до 5 мин устаревший, и юзер может выбирать момент (свободный опцион, ограничен спредом + комиссиями pump ~3 % на круг, поэтому low по деньгам).
*Исправление:* фоновое обновление курса раз в 30 с независимо от запросов. Stale-фолбэк 120 с, при stale спред ×2.

### LOW

- **D15 · `web/lib/crypto/keys.ts:20,27` · Старый общий путь = новый mainnet-путь.** Ключ v1 (`m/44'/133'/0'/0'`), уже засвеченный на devnet (сервер, БД, логи тестеров), совпадает с mainnet-ключом той же фразы. Реальных mainnet-юзеров нет, поэтому low. *Исправление:* либо mainnet = `2'` (векторы, ~1 ч, только сейчас), либо в UI при апгрейде v1: «this phrase was used on Devnet before v0.3; create a new phrase for Mainnet». И при апгрейде предупредить, что devnet-баланс остался на старом ID.
- **D16 · `core/api/src/config.rs:207` + `actions.rs:436` · Капля газа всегда 2 000 000 лампортов.** Core передаёт фиксированный `gas_lamports`, поэтому случайный `pickGasDrop` (`executors.ts:124`) не срабатывает. Приватности почти не вредит (vault публичны), но правило «не фиксированный отпечаток» нарушено. *Исправление:* случайное значение 2–4 млн в core или `gas_lamports=NULL`.
- **D17 · `core/api/src/market.rs:279-283` · WS-опрос `id > last` пропускает строки, закоммиченные не по порядку id** (несколько релейеров или параллельные транзакции). *Исправление:* перечитывать окно `id > last - 50` и фильтровать уже отправленные.
- **D18 · `core/api/src/actions.rs:156-170` · buy по неизвестному mint разрешён** (API.md:269 говорит 404 для неотслеживаемых). Пул покупает любой pump-mint. Адаптер проверяет кривую, но строки в `tokens` нет, и `/api/tokens/:mint` отдаёт 404 на только что купленный токен. *Исправление:* либо 404, либо релейер делает `INSERT … ON CONFLICT DO NOTHING` в `tokens` при первой сделке.
- **D19 · Postgres WAL / мёртвые кортежи.** После `UPDATE … action_id=NULL` старые версии строк живут до VACUUM, а в WAL до ротации. *Исправление:* `autovacuum` по умолчанию достаточно. Не включать `archive_mode`, не делать `pg_basebackup` вне шифрованного тома.
- **L-16 · `adapters/src/relayer/engine.ts:223-234` · `finalize` → `retry` без лимита, если tx нечитаема** (RPC без истории). Задание крутится вечно, hold висит. *Исправление:* после N claim — алерт оператору (без данных юзера), не `failed`.
- **L-17 · `adapters/src/relayer/engine.ts:198-221` · Один процесс исполняет одно задание за раз, `resolve` может держать очередь до 120 с.** Пока это даже помогает таймингу, но очередь встанет при сбое RPC. *Исправление:* N воркеров в процессе (VaultPool уже держит busy-set).
- **L-18 · Деплой:** `/ws/feed?mint=`, `/api/tokens/:mint` и `/api/actions/:id` в URL. При access-логах или TLS-терминирующем CDN (Cloudflare) третья сторона видит «IP смотрел mint M за 10 с до единственной покупки M» и `x-unzeen-pubkey` в заголовке. *Исправление:* в чек-лист деплоя: никакого CDN с терминированием TLS перед API, nginx `access_log off`, `proxy_pass` без URI-части (иначе nginx нормализует путь и подписи ломаются).

---

## Что видит наблюдатель on-chain (для README)

> Draft in English for `README.md` → "Privacy model". Keep it honest; judges reward precise threat models.

**Zcash side (anyone with a block explorer)**
- A shielded transaction to *some* Orchard/Ironwood address. Sender, amount, recipient and memo are encrypted. The pool's address is public, but a shielded payment to it is indistinguishable from any other Ironwood transaction.
- Exception: paying **from a transparent address or straight from an exchange** reveals the source address and the amount, and the exchange learns you paid Unzeen. The app tells you to pay only from a shielded balance.
- Payouts (`withdraw_zec`) are shielded and the pool keeps no outgoing viewing data.

**Solana side**
- Every trade, launch and withdrawal is signed by one of the pool's **public vaults** (listed on /verify). An observer can attribute any of them to "Unzeen", but not to a person. Vaults rotate per action, and no vault belongs to a user.
- Launches use a fresh creator address per token. Nothing links two launches by the same user on chain.
- What an observer **can** do:
  - group Unzeen trades by token. If you are the only Unzeen user trading a small token, all Unzeen trades in it are yours (a pseudonymous position, not an identity);
  - match a token withdrawal to earlier buys by amount (withdraw a rounded amount and wait), and see that the recipient was funded by Unzeen (the gas drop). The recipient is a fresh address, so keep it separate from your main wallet;
  - correlate timing: execution is delayed by a random 3–20 s (configurable). With low volume, someone who sees both your connection to our server and the chain (your ISP, our hosting provider) can narrow down your trade.
- What an observer **cannot** do: link a Solana trade to a Zcash sender, to a deposit, or to your anon key. That mapping exists only in the pool's ledger.

**Operator (trust assumption, MVP)**
- The pool operator holds the ledger (anon key → balances and positions) on an encrypted volume. It keeps no IPs, no request logs, and no action-to-transaction links after 24 h. A compromised operator still sees current balances and positions. Roadmap: Squads multisig vaults, FROST on the Zcash side.

(После исправления D1 и D2 поправить формулировки про 24 ч и 3–20 с под фактические значения.)

---

## Открытые вопросы для лида

1. **D4:** снимаем правило «вывод с другого vault» (оно не даёт приватности) и делаем «позиция mint на одном vault»? Без этого demo-сценарий «купил → вывел» нестабилен. Это меняет API.md:183, ARCHITECTURE:47 и релейер.
2. **D2:** какой дефолт джиттера для демо и для mainnet? Предлагаю батчи-эпохи 20–60 с и режим «Max privacy» до 10 мин. Видео-демо снимать в быстром режиме с подписью.
3. **D1:** согласовать удаление `token_ops`/`ledger_ops` старше 48 ч. Нужен ли журнал для Merkle-sum в /verify, или хватит снапшота балансов?
4. **D6:** закрываем `create` и `withdraw_zec` ответом 503 до появления исполнителей? `create` в плане дней 6–8, `withdraw_zec` — ядро («депозит → покупка → лента → вывод»): исполнитель выплат ZEC нужен в плане явно.
5. **D3:** даём frontend текст предупреждения про биржи/t-адреса, а backend флаг `from_transparent`?
