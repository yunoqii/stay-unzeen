# Ревью дня 3: код дня 2 (protocol, ledger, scanner serve/seed, web crypto, adapters)

Автор: analyst · Дата: **2026-10-12** · Объект: коммиты `debb153` (core), `2b61aad` (web), `a9ccd7b` + `ff3ce68` (adapters). Только чтение. Незакоммиченные правки backend/frontend в рабочем дереве (adapters/src/tx.ts, web/lib/*) видел. Где они меняют вывод, это отмечено отдельно.
Правило: любая утечка, в том числе третьей стороне = дисквалификация.

## TL;DR

1. **Протокол и реестр сделаны добротно.** В `unz1` строгий base64url, проверяется длина, все поля под подписью, `verify_strict`, `chain_id`, expiry считается по времени блока. В HTTP-подписи формат заголовков строгий, тоже `verify_strict`. В ledger атомарный hold одним `UPDATE … WHERE available >= x`, nonce расходуется в той же транзакции, ретраи идемпотентны, дедуп по `note_ref`, K=3, при reorg баланс замораживается. Critical-находок нет. Из C1–C3/H1–H10 по коду закрыты C1, C2, H2, H3, H10 и основная часть H4/H5. H1 запланирован на дни 4–5, остальное записано в API.md и ждёт API-сервер и релейер.
2. **Главная новая дыра в приватности: `wallet.sqlite`.** В нём открытым текстом лежат UFVK, все memo с anon_pubkey, txid и история выплат. Ключ HMAC для `note_ref` выводится из того же UFVK. age-ключ сида лежит в той же `~/.unzeen`. Шифрование сида защищает право тратить, но не приватность. Если провайдер VPS (третья сторона) снимет снапшот диска, он получит полный реестр, прошлые и будущие депозиты. Нужен зашифрованный том плюс ключ вне `UNZEEN_HOME`.
3. **Деньги.** В закоммиченном `adapters/src/tx.ts` транспортная ошибка `sendRawTransaction` теряет подпись, и релейер может купить дважды. В рабочем дереве backend уже чинит это (`signTx`/`signatureState`). Нужна одна правка: `landed` засчитывать только при `confirmed`/`finalized`.

---

## Статус находок review-day2

| Находка | Статус | Где |
|---|---|---|
| **C1** публикация viewing key | **Закрыто** в коде и доках. **Регресс в UI:** `/verify` всё ещё обещает «publishes a viewing key» | `core/scanner/src/send.rs:131` (`OvkPolicy::Discard`), ARCHITECTURE «Verify», FRONTEND.md:41. Остаток: `web/app/verify/page.tsx:10-11,45` (см. N8) |
| **C2** оплата за действие | **Закрыто** (режим вырезан, memo только `op=deposit`) | `core/protocol/src/memo.rs:215-233`, `ledger/src/decide.rs:105-107`, `web/lib/crypto/unz1.ts:219`, API.md:222. Текст в UI о депозите с t-адреса/Sapling проверить в `/portfolio` Top up (frontend в работе) |
| **C3** вывод токенов без газа | **Записано** в API (газ всегда, другой vault, задержка, отдельные tx), кода нет | API.md:134. Реализация — релейер `withdraw_token` |
| **H1** lightwalletd видит интерес пула к txid | **Открыто**, запланировано на дни 4–5 (владелец: не урезается) | `core/scanner/src/sync.rs:254-263` по-прежнему `GetTransaction` только своих txid |
| **H2** reorg после зачисления | **Закрыто** (K=3, `seen/confirmed/credited`, флаг `reorged`, баланс заморожен, не в минус, идемпотентность `note_ref`). Остаток: заморозка мгновенная и вечная (N4) | `ledger/src/decide.rs:84-93`, `ledger/src/lib.rs:183-206`, `migrations/0001_ledger.sql:17-38` |
| **H3** кто подписывает memo | **Закрыто** (собирает и подписывает фронт, `/api/deposit` и intents удалены, векторы общие) | `web/lib/crypto/session.ts:140`, `web/lib/crypto/unz1.ts`, `core/testdata/unz1-vectors.json`, API.md:23,222 |
| **H4** связка в логах и на диске | **В основном закрыто**: `serve` пишет только в Postgres, dev-команды на mainnet закрыты, umask 077, `~/.unzeen` 0700/0600, сид в age, txid-логи librustzcash ограничены. **Остаток:** `wallet.sqlite` открытым текстом и age-ключ рядом (N2), ключи adapters в репо на Desktop (N9), DETAIL ошибок Postgres в логах (N3), RUST_LOG обходит cap (L-6) | `scanner/src/service.rs`, `main.rs:142-198`, `seed.rs`, `config.rs:98-172` |
| **H5** гонки баланса, ретраи | **Закрыто для ZEC** (условный UPDATE, nonce в той же tx, повтор → исходный receipt, другое тело → `Replay`, тест на 10 параллельных holds). **Открыто:** holds токенов для sell/withdraw_token (таблицы нет), frozen и минимум не проверяются при `hold=0` (N7) | `ledger/src/lib.rs:270-343`, `tests/ledger_pg.rs:233` |
| **H6** публичные агрегаты и статусы | **Записано**: `zecShielded` раз в сутки с округлением, id 128 бит, `/api/actions/:id` подписанный; id действий генерируются случайно | API.md:19,126,137; `ledger/src/lib.rs:282`. Ждёт API-сервер |
| **H7** claim и EXIF | **Частично**: свежий creator на запуск есть, claim — чисто реестровый (в доке), EXIF — в доке | `adapters/src/keys.ts:86-129`, API.md:96,136. Расписание сбора fees и перекодирование картинки ждут релейер/API |
| **H8** тайминг | **Записано** (батчи 3–10 с + джиттер 0–20 с) | API.md:133. Ждёт релейер. Паддинг тел запросов не записан |
| **H9** pubkey в URL и логи хостинга | **Закрыто в API и клиенте**. Чек-лист nginx/VPS ждёт деплой | API.md:17, `web/lib/api/client.ts:152-153`, `credentials:"omit"`, `no-referrer` |
| **H10** DoS пылью | **Закрыто** (`MIN_DEPOSIT_ZAT` до разбора memo, `MIN_ACTION_ZAT` на hold). Rate-limit ждёт API-сервер | `ledger/src/decide.rs:91`, `lib.rs:278` |
| M5 expiry по времени блока | Закрыто (откат на часы, если блока нет в БД) | `decide.rs:103`, `service.rs:83,92` |
| M8 подпись HTTP | (в) nonce в Postgres и (д) `verify_strict` закрыты. (а) сырой request-target и (г) сырое тело записаны, ждут сервер. **(б) `chain_id` не сделан** (N6) | `api_auth.rs:123`, `0001_ledger.sql:43-64` |
| L1 размеры memo | Закрыто (153/196, тест) | `memo.rs:35-38,383-392` |
| L3 multi-step proposal | Закрыто (отказ до сборки tx) | `send.rs:114-117` |
| L6 путь ключа | Решение лида: оставить `m/44'/133'/0'/0'` (см. N6 о сетях) | STATUS «Решения» |

---

## Новые находки

Формат: **серьёзность · файл:строка · проблема · исправление**.

### HIGH

**N1 · `adapters/src/tx.ts:46-58` (коммит `ff3ce68`) · Двойная покупка при транспортной ошибке отправки.**
Если `sendRawTransaction` упал по таймауту или 5xx, tx мог уйти в сеть, но `SendFailure` создаётся без `signature`. Релейер не может проверить статус и повторит покупку, то есть потратит SOL пула дважды и спишет с hold юзера один раз.
*Исправление:* в рабочем дереве backend уже вводит `signTx` (подпись известна до отправки), `stage` и `signatureState`. Чтобы считать N1 закрытым, нужно ещё:
- в `signatureState` засчитывать `landed` только при `confirmationStatus ∈ {confirmed, finalized}`. `processed` на отброшенном форке даст «settle» несуществующей сделки, так что это `pending`;
- при неоднозначной ошибке `stage:"confirm"` ретрай делать только после `expired` по finalized-высоте (уже так задумано);
- релейер держит одну исполняемую tx на vault за раз (сейчас `requireSol` гоняется при параллельных покупках с одного vault);
- тест: сымитировать throw в `sendRawTransaction` после реальной отправки и проверить, что повторной tx нет.

**N2 · `~/.unzeen/<net>/data/wallet.sqlite` + `core/scanner/src/service.rs:43-58` + `.env.example:20` · Один файл раскрывает всех, шифрование сида это не меняет.**
В `wallet.sqlite` открытым текстом (0600, но без шифрования):
- UFVK пула. Он расшифровывает каждый будущий депозит из цепочки, пока пул не сменит адрес;
- все memo (anon_pubkey) с txid, суммами и высотами;
- `sent_notes`: получатели и суммы выплат. `OvkPolicy::Discard` защищает только от расшифровки из цепочки, локальная запись остаётся.

Ключ `note_ref` = `sha256(domain ‖ UFVK)` берётся из того же файла, поэтому «БД реестра без wallet.sqlite» не спасает при захвате хоста. age-ключ сида лежит в `~/.unzeen/seed.agekey` (проверено на машине), то есть в одном каталоге с `~/.unzeen/test/keys/pool.mnemonic.age`, и `.env.example:20` советует именно этот путь. Провайдер VPS — третья сторона с доступом к дискам и снапшотам.
*Исправление (до mainnet-демо):*
- `UNZEEN_HOME` держать на зашифрованном томе (LUKS или gocryptfs), который владелец разблокирует вручную после загрузки. Снапшоты и бэкапы провайдера для этого тома не включать;
- age-ключ держать вне `UNZEEN_HOME` (`/etc/unzeen/seed.agekey` root:unzeen 0640 или systemd `LoadCredential=`). В `.env.example` поменять пример пути;
- в README (threat model) честно: «pool wallet DB holds the viewing key and memos; it lives on an encrypted volume; operator trust».

Не рекомендую обнулять memo в `wallet.sqlite` вручную: при `memo=NULL` pre-release `zcash_client_sqlite` перезапросит tx (Enhancement), а схему библиотеки мы не контролируем.

### MEDIUM

**N3 · `core/ledger/src/lib.rs:25-26` + `core/scanner/src/service.rs:159` + `infra/docker-compose.yml:11-23` · Значения строк попадают в логи через DETAIL ошибок Postgres.**
В `tokio-postgres 0.7.18` `DbError: Display` печатает `DETAIL` (проверил исходник, `error/mod.rs:311-321`), а `warn!(error = %format!("{e:#}"))` выводит всю цепочку источников. Нарушение CHECK (`balances.held_zat >= 0` при рассинхроне settle) даёт строку `Failing row contains (\x<anon_pubkey>, <available>, <held>, …)`. Unique-конфликт даёт `Key (note_ref)=(…)`. Тот же DETAIL Postgres по умолчанию пишет в stderr контейнера, то есть в docker json-file.
*Исправление:*
- в compose: `command: ["postgres", "-c", "log_error_verbosity=terse", "-c", "log_min_error_statement=panic", "-c", "log_connections=off", "-c", "log_disconnections=off"]`;
- в приложении логировать только `SQLSTATE` (`e.as_db_error().map(|d| d.code().code())`), а не `Display`. То же правило дать API-серверу и релейеру.

**N4 · `core/ledger/src/lib.rs:185-206`, `core/scanner/src/sync.rs:38,58-62,228-240` · Мгновенная и вечная заморозка при временном `mined_height = NULL`.**
`rewind` откатывает на `REORG_MARGIN = 10` блоков. Если после этого проход прерван по `MAX_RESTARTS` («deferring»), `apply_wallet_notes` всё равно запускается, и зачисленные депозиты из откатанных блоков выглядят `Unmined`. Получаем `reorged = TRUE` и `frozen` у невиновных. Когда нота снова замайнена, разморозки нет.
*Исправление:*
- не вызывать `apply_wallet_notes`, если `sync` вернулся с недосканом (`SyncReport.complete = false`);
- замораживать, только если `NULL` держится ≥ N проходов или блоков (колонка `unmined_since_tip`);
- авто-разморозка, если нота снова замайнена с ≥ K подтверждений и у ключа нет других `reorged`;
- тест на этот сценарий.

**N5 · `core/migrations/0001_ledger.sql:22,36,52,75` · HMAC `note_ref` обесценен соседними колонками.**
У `deposits` рядом с `anon_pubkey` хранятся `mined_height`, `created_at`, `amount_zat`, плюс `ledger_ops.created_at`. Ironwood — новый пул с малым трафиком, так что высота блока почти однозначно указывает на tx. Вместе с логом lightwalletd (H1: IP отправителя ↔ txid) утечка одной БД реестра даёт IP ↔ anon_pubkey ↔ действия.
*Исправление:*
- после `credited` + 100 блоков (окно reorg) обнулять `mined_height`;
- `created_at`/`updated_at` у deposits и ledger_ops огрублять до часа (`date_trunc`);
- у `actions` хранить `solanaTx` ≤ 24 ч (как в M9).

Это продолжение M9, но теперь привязано к конкретным колонкам.

**N6 · `core/protocol/src/api_auth.rs:62-68`, API.md:183-191, `web/lib/crypto/keys.ts:18`, `web/lib/api/client.ts:116` · HTTP-подпись не привязана к сети (M8(б) не сделан).**
Ключ выводится одинаково для обеих сетей. Если юзер восстановит ту же фразу в слоте Mainnet (UI это позволяет), у него будет один anon_pubkey на devnet и mainnet. Подписанный запрос к одному экземпляру тогда принимается другим в течение 60 с, если пути совпадают. Плюс фронт подписывает `call.path`, а запрос шлёт на `apiUrl + path`. Если API сети за префиксом (`/devnet/api/…`), подписанное расходится с request-target, а прокси, срезающий префикс, делает подписи сетей идентичными.
*Исправление (дёшево, пока нет сервера):*
- добавить в сообщение строку `<chain_id hex>` после `unzeen/api/v1`, обновить векторы в core и web;
- в API.md зафиксировать, что API каждой сети живёт в корне своего origin (поддомены), без префиксов.

Отдельно для лида: стоит ли выводить anon-ключ по пути с индексом сети (`m/44'/133'/<net>'/0'`), чтобы одна фраза не давала одну идентичность в обеих сетях. Решение протокольное, менять только сейчас.

**N7 · `core/ledger/src/lib.rs:278,313-336` · Действия без hold обходят `frozen` и минимум.**
При `hold_zat = 0` (sell, claim, withdraw_token, order_cancel, chat) нет ни проверки `frozen`, ни `MIN_ACTION`. API.md:210 обещает `balance_frozen` на любое новое действие. Учёта токенов (holdings, hold токенов для sell/withdraw_token, H5) в схеме нет вообще.
*Исправление:*
- в `submit_action` всегда делать `SELECT frozen FROM balances WHERE anon_pubkey=$1 FOR UPDATE` в той же транзакции;
- миграция `0002`: `token_balances(anon_pubkey, mint, available, held)` с тем же условным UPDATE, sell и withdraw_token держат токены.

**N8 · `web/app/verify/page.tsx:10-11,45` · В UI осталось «The pool publishes a viewing key».**
Это прямо противоречит C1 и ARCHITECTURE. Судьи читают `/verify`. Плюс риск, что кто-то «реализует как написано».
*Исправление:* заменить на Merkle-sum обязательств, публичные vault и attested-резерв ZEC (как в FRONTEND.md:41). Зона frontend.

**N9 · `adapters/src/config.ts:27`, `adapters/.env.example:7`, `adapters/src/keys.ts:17-19` · Ключи vault и creator-master в каталоге репо на `~/Desktop`.**
По умолчанию `adapters/keys/`. Фактически каталог 0755 (`mkdirSync(mode)` действует только при создании), файлы 0600, открытым текстом. `creator-master.hex` управляет creator fees всех запусков. Core уже уехал в `~/.unzeen` из-за риска iCloud, adapters — нет.
*Исправление:*
- по умолчанию `$UNZEEN_HOME/<cluster>/solana`, на существующий каталог делать `chmod 700`;
- до mainnet шифровать (age, как сид core) или хотя бы класть на тот же зашифрованный том, что в N2.

**N10 · `adapters/src/pumpfun.ts:377-378` · При недоступности деталей tx суммы = 0.**
`result()` возвращает `tokenAmount: 0n, solAmount: 0n`, если `fetchTx` не вернул tx. Релейер, который зачисляет holdings из `TxResult`, запишет юзеру 0 токенов, при этом settle hold пройдёт.
*Исправление:* флаг `amountsKnown: false` (или отдельная ошибка `pending_details`). Релейер не делает settle, пока не перечитает tx.

**N11 · `web/next.config.ts` · Нет CSP и security-заголовков, хотя секрет лежит в памяти JS.**
*Исправление:*
- `Content-Security-Policy: default-src 'self'; script-src 'self'; connect-src 'self' <API/WS хосты сетей>; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
- `Referrer-Policy: no-referrer`, `Permissions-Policy` (camera только для `/portfolio`, если сканер QR), `X-Content-Type-Options: nosniff`.

От расширений браузера CSP не спасает (в UI честно: «use a clean browser profile»), но XSS и supply-chain закрывает.

### LOW

- **L-1 · `web/lib/crypto/session.ts:134-137` · Устаревший signer после lock.** Signer держит ссылку на тот же `Uint8Array`, а `wipe` заполняет его нулями. После lock старый signer подписывает нулевым ключом. Это не утечка, но баг с непонятными 401. *Исправление:* внутри `sign()` проверять, что слот ещё unlocked и ключ тот же, иначе бросать `locked`.
- **L-2 · `session.ts:19,117` · Автоблокировка 30 мин с момента unlock, не по бездействию и не по скрытию вкладки.** Для Mainnet: 10 мин бездействия и lock, если вкладка скрыта > 5 мин.
- **L-3 · `web/components/key/key-app.tsx:503,527` · Слова фразы в state `RevealPhrase` до размонтирования.** `PhraseGrid` прячет слова при `visibilitychange`, но они остаются в DOM-дереве React. *Исправление:* очищать `words` по `visibilitychange` и через 60 с.
- **L-4 · `web/lib/crypto/vault.ts:89` · `iterations` берётся из localStorage без нижней границы.** *Исправление:* отвергать `< 600_000`.
- **L-5 · `key-app.tsx:427-433` · Копирование anon ID в буфер.** Universal Clipboard и облачный буфер Windows — третья сторона. Анон-ID юзеру почти не нужен. *Исправление:* убрать кнопку или предупреждать.
- **L-6 · `core/scanner/src/main.rs:182-194` · Cap логов librustzcash обходится более специфичной директивой** (`RUST_LOG=zcash_client_backend::sync=info` сильнее `zcash_client_backend=warn`). *Исправление:* в `serve` игнорировать `RUST_LOG` и брать фиксированный allowlist (`warn,unzeen_scanner=info,unzeen_ledger=info`).
- **L-7 · `service.rs:131-143` · `changes={credited:1}` с меткой времени в каждом проходе.** Читатель логов узнаёт моменты зачислений. *Исправление:* на mainnet печатать агрегат раз в час.
- **L-8 · `ledger/tests/ledger_pg.rs:42-51` · Postgres-тесты молча пропускаются без `DATABASE_URL`.** «44/44» может включать пропуски. *Исправление:* `REQUIRE_PG=1` в CI, при нём падать.
- **L-9 · `ledger/src/lib.rs:468-477` · `refund_pending` не сохраняет refund-получателя.** Выплату придётся восстанавливать из `wallet.sqlite`. Фронт и так шлёт `target_kind=0`, поэтому проще убрать refund из v1 совсем: истёкшее всегда зачислять.
- **L-10 · `adapters/src/keys.ts:110-120` · Счётчик creator не атомарен между процессами.** Два процесса релейера могут выдать одного creator двум запускам и тем самым связать их. *Исправление:* lock-файл (один процесс релейера) или счётчик в Postgres.
- **L-11 · `decide.rs:103` · Тихий откат на часы сервера, если нет времени блока.** *Исправление:* счётчик `block_time_fallback` в логе прохода.

### Для релейера (кода ещё нет, учесть при написании)
- **Выбор vault — случайный на каждое действие, не «липкий» на anon-ключ.** Иначе vault становится публичным псевдонимом юзера: create-tx публично связывает vault и свежего creator (`pumpfun.ts:170-176`, vault = payer + user), а последующие buy/sell того же vault по тому же mint образуют кластер.
- Связь creator ↔ vault в create-tx неустранима и допустима (vault пула публичны по Verify). Свежий creator защищает от связи «запуски одного юзера», только если vault выбирается случайно, а сбор fees идёт по глобальному расписанию (H7).
- Межvault-переводы SOL (как в `scripts/e2e-devnet.ts`) на mainnet допустимы: vault публичны. Но не делать их сразу после действия юзера (тайминг).
- Логи релейера: никогда не писать `action_id`/anon_pubkey рядом с `signature`. `AdapterError.cause` содержит адреса, поэтому логировать только `code`.

---

## Открытые вопросы для лида
1. **N2:** берём для VPS зашифрованный том (LUKS/gocryptfs с ручной разблокировкой после ребута)? Это влияет на uptime в судейский период до 22.11: после перезагрузки VPS нужен владелец.
2. **N6:** добавляем `chain_id` в HTTP-подпись сейчас (правка векторов core+web ~1 ч)? И отдельно: выводить anon-ключ с индексом сети в пути или оставить одну идентичность на обе сети?
3. **N7:** миграция `0002` с `token_balances` — в план backend на дни 6–8 вместе с релейером sell/withdraw_token?
4. **L-9:** убираем refund из memo v1 (всегда зачислять на баланс)? Это упрощает и бек, и фронт.
