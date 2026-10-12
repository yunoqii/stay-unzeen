# Zcash-стек: проверка перед интеграцией (день 1)

Автор: analyst · Дата проверки: **2026-10-12** (все версии, эндпоинты и замеры сняты в этот день, если не указано иное).

## TL;DR (блокеры)

1. **CRITICAL: Orchard закрыт для новых средств.** С NU6.3 (mainnet: блок 3 428 143, 28.07.2026) действует новый shielded-пул **Ironwood**: в Orchard нельзя вносить новые средства, переводы между адресами внутри Orchard запрещены (ZIP 258). Везде в доках вместо «Orchard» должен стоять **Ironwood**. Адреса UA те же, крипта та же (исправленная схема Orchard на Halo2). В librustzcash это уже есть.
2. **CRITICAL: на testnet активирован NU7** (блок 4 465 026, ~05.10.2026). Стабильный стек (`zcash_client_backend 0.24` / `zcash_protocol 0.10.6`) не знает branch id `0x77190AD9`: синк падает на полных tx, то есть **memo не прочитать**, а tx не собрать. На testnet нужны только pre-release: `zcash_client_backend =0.25.0-pre.1`, `zcash_client_sqlite =0.23.0-pre.1`, `zcash_protocol =0.11.0-pre.0`, `orchard 0.16`.
3. **HIGH: на testnet инструменты для юзерского кошелька отстают.** `zcash-devtool` main всё ещё на 0.24, NU7 там нет. Релизного zingo-cli с NU7 нет: поддержка есть только в ветке `dev` (влита 09.10). ZODL-testnet есть только в виде сборки из исходников (Android, вариант `zcashtestnet`).
4. **HIGH: фаусеты.** jinolabs на паузе из-за NU7. Работает Valar: **0.125 TAZ в сутки на IP**. Этого мало, TAZ надо запросить заранее (Discord) или намайнить.
5. **Решение для лида:** либо (A) testnet + pre-release крейты и zingo-cli из `dev`, либо (B) **mainnet с копеечными суммами**: стабильные 0.24/0.22, Ironwood поддерживается, NU7 на mainnet нет, ZODL из стора, есть `zec.rocks`. Я рекомендую B для демо, A как запасной вариант для CI и dev.
6. **Memo:** JSON `{v,op,venue,mint,min_out,anon_pubkey,sig}` занимает 281 байт (base58), то есть влезает в 512. Но если добавить `refund_ua`, `nonce` и `exp`, выходит ~576 байт и уже не влезает. Предлагаю бинарный формат на 152 байта (+43 байта сырого receiver'а для refund), обёрнутый в UTF-8 текст `unz1:<base64url>`.
7. **Lightwalletd, не Zaino.** Публичный `testnet.zec.rocks:443` живой: lightwalletd v0.5.4 поверх Zebra 7.0.0-rc.0, высота 4 492 712 = tip. Свою Zebra можно не поднимать. FROST в демо не показывать (только слайд roadmap).
8. **Задержки:** блоки testnet на практике приходят каждые 11–25 с в среднем (по спеке 75 с, mainnet 75 с). Депозит виден в mempool за секунды, в блоке примерно через 1 блок. По умолчанию librustzcash даёт тратить внешние ноты только после 10 подтверждений (~12.5 мин на mainnet).

---

## 1. librustzcash: версии и минимальный путь

### Факты (crates.io, 2026-10-12)

| Крейт | Стабильная | Дата | Pre-release (NU7) | Дата |
|---|---|---|---|---|
| `zcash_client_backend` | 0.24.0 | 2026-08-19 | 0.25.0-pre.1 | 2026-10-06 |
| `zcash_client_sqlite` | 0.22.0 | 2026-08-19 | 0.23.0-pre.1 | 2026-10-06 |
| `zcash_keys` | 0.16.1 | 2026-07-29 | 0.17.0-pre.1 | 2026-10-06 |
| `zcash_primitives` | 0.30.1 | 2026-08-19 | 0.31.0-pre.1 | 2026-10-06 |
| `zcash_protocol` | 0.10.6 | 2026-09-08 | 0.11.0-pre.0 | 2026-10-01 |
| `orchard` | 0.16.0 | 2026-09-30 | — | — |
| `zip321` | 0.9.0 | 2026-08-19 | 0.10.0-pre.1 | 2026-10-06 |
| `pczt` | 0.9.3 | 2026-08-07 | 0.10.0-pre.1 | 2026-10-06 |

Источник: `https://crates.io/api/v1/crates/<name>`.

**Ловушка с совместимостью.** `zcash_client_backend 0.24.0` и `zcash_client_sqlite 0.22.0` требуют `orchard ^0.15` (это видно в Cargo.toml опубликованных крейтов). `orchard 0.16` подходит **только** к pre-release линейке. Если поставить в Cargo «самый свежий orchard» к стабильному backend, получим две копии orchard и ошибки типов.

Два согласованных набора:

```toml
# Набор B — mainnet (стабильный)
zcash_client_backend = { version = "0.24.0", features = ["lightwalletd-tonic-tls-webpki-roots", "orchard", "sync"] }
zcash_client_sqlite  = { version = "0.22.0", features = ["orchard"] }
zcash_keys           = { version = "0.16.1", features = ["orchard"] }
zcash_primitives     = "0.30.1"
zcash_protocol       = "0.10.6"
orchard              = { version = "0.15", default-features = false }
zip321               = "0.9"

# Набор A — testnet после NU7 (точные пины, API ломается между pre)
zcash_client_backend = "=0.25.0-pre.1"
zcash_client_sqlite  = "=0.23.0-pre.1"
zcash_keys           = "=0.17.0-pre.1"
zcash_primitives     = "=0.31.0-pre.1"
zcash_protocol       = "=0.11.0-pre.0"
orchard              = "0.16"
zip321               = "=0.10.0-pre.1"
```

Изменения API в 0.25-pre (из CHANGELOG): `create_proposed_transactions` и `create_pczt_from_proposal` теперь принимают `clock: &impl Clock` и `rng: &mut impl CryptoRng`. Переход на `rand 0.10` / `rand_core::Rng`. Действует проверка срока действия UA по ZIP 316 Revision 2 (`Error::RecipientAddressExpiry`), это касается refund UA при выплатах.

### Ironwood в librustzcash (проверено по исходникам)
- `zcash_client_backend 0.24.0` и `0.25.0-pre.1`: в `src/decrypt.rs` есть `decrypt_orchard_protocol_bundle::<IronwoodVersion, _>` с `orchard::ValuePool::Ironwood`; в `proto/compact_formats.rs` есть `ironwood_actions` и `ironwood_commitment_tree_size`; есть модуль `data_api/zip318.rs` (миграция Orchard→Ironwood).
- Фича называется `orchard` и покрывает «Orchard-семейство», то есть Orchard и Ironwood вместе.

### Минимальный путь для пула
1. **Ключи.** `UnifiedSpendingKey::from_seed` (ZIP 32), из него UFVK и UA с shielded-receiver'ом. Пулу нужен spending key, потому что он делает выплаты. Режим «только UFVK» (`import_ufvk` / `init_fvk`) подходит для аудиторского viewing key из roadmap.
2. **Скан.** `zcash_client_backend::sync::run` (фича `sync`) или вручную: `GetLatestBlock` → `update_chain_tip` → `suggest_scan_ranges` → `GetBlockRange` → `scan_cached_blocks`. Compact-блок содержит только 52 байта шифртекста, этого хватает, чтобы распознать «нота наша» и её сумму, но **memo там нет**.
3. **Memo (ZIP 302).** Для найденных tx вызываем `GetTransaction(txid)` → `decrypt_and_store_transaction` (или `decrypt_transaction`). `DecryptedOutput::memo()` возвращает `MemoBytes`, это 512 байт. Как раз этот шаг и падает на testnet со стабильным стеком (см. блокер 2).
4. **0-conf (опционально).** `GetMempoolStream` отдаёт сырые tx из mempool. Их можно trial-decrypt'ить той же `decrypt_transaction`, чтобы показать статус `seen` за секунды.
5. **Отправка с memo.** `zip321::TransactionRequest` (`Payment` с `memo`) → `propose_transfer` → `create_proposed_transactions` → `SendTransaction`. Комиссия по ZIP 317 рассчитывается внутри.

### Где смотреть код (zcash-devtool, github.com/zcash/zcash-devtool, коммит `5a26ee85` от 2026-08-28)
- `src/commands/wallet/sync.rs`: полный цикл синка (subtree roots, скан диапазонов, обработка reorg через `rewind`).
- `src/commands/wallet/enhance.rs`: `get_transaction` → `decrypt_and_store_transaction`, то есть получение memo.
- `src/commands/wallet/list_tx.rs`: вывод tx вместе с memo.
- `src/commands/wallet/send.rs`: `TransactionRequest` → `propose_transfer` → `create_proposed_transactions` → `send_transaction`, с memo.
- `src/commands/wallet/init.rs`, `init_fvk.rs`, `import_ufvk.rs`: создание кошелька и импорт UFVK.
- `src/remote.rs`: список серверов; `ZEC_ROCKS_TESTNET = testnet.zec.rocks:443`.
- `doc/walkthrough.md`: команды вида `cargo run --release -- wallet -w <dir> init --name X -i <identity> -n test`.
- **Важно:** devtool на `main` зависит от `zcash_client_backend 0.24.0` (`Cargo.toml:48`), поэтому на testnet после NU7 он не работает. Код годится как образец, а запускать его можно только на mainnet.

**Риск.** Pre-release API нестабилен: между `-pre.0` и `-pre.1` уже были ломающие изменения. Под NU7 нет готового образца: devtool его не поддерживает.
**Рекомендация.** Собрать `core/` вокруг `sync::run` + `decrypt_and_store_transaction` + `propose_transfer`, повторяя устройство devtool. Пины ставить точные (`=`). Вынести выбор сети в feature/конфиг, чтобы можно было переключаться между наборами A и B.

---

## 2. lightwalletd vs Zaino; публичные эндпоинты; Zebra

### Факты
- **lightwalletd**: v0.5.5 (2026-10-10), v0.5.4 (2026-08-27). Проект зрелый, Go, ECC.
- **Zaino** (`zainod`): 0.10.x, крейты 0.x. Ломающие релизы выходят раз в ~2 недели (0.9.0 от 29.08, 0.10.0 от 12.09, 0.10.1 от 29.09, `zaino-state 0.11.0` от 12.10). Совместимость с lightwalletd gRPC заявлена в README, но сам README говорит о гейтах «dev → rc → stable».
- **testnet.zec.rocks:443 работает.** Я сделал gRPC `GetLightdInfo` 2026-10-12 16:18 UTC: `ECC LightWalletD v0.5.4`, `chainName=test`, `blockHeight=4492712`, `estimatedHeight=4492715`, backend `/Zebra:7.0.0-rc.0/`, `consensusBranchId=77190ad9` (NU7). Сервер синхронизирован и отдаёт данные Ironwood (так же пишут в zingolib#2859). Mainnet `zec.rocks:443`: lightwalletd v0.5.3, Zebra 6.3.0, branch `37a5165b` (NU6.3).
- **Zebra**: v6.4.2 (2026-09-25), **v7.0.0-rc.0 (2026-10-02)**. NU7 для testnet есть в PR #11554 «fix(nu7)!: prepare Testnet activation» (влит 01.10), поэтому **для testnet нужен zebrad ≥ 7.0.0-rc.0**. Версии 6.x на testnet уйдут на неправильную ветку.
- **Диск и время.** По книге Zebra (`book/src/user/requirements.md`) testnet занимает ~10 GB. Последний снапшот ZF (`snapshots.zfnd.org/testnet/snapshots.json`) весит **11.3 GiB**, высота 4 468 596, от 2026-10-07. При распаковке нужно примерно вдвое больше места, то есть ~25 GB. Минимум по требованиям: 4 GB RAM. Время полного синка testnet с genesis в документации не указано; моя оценка — от нескольких часов до суток, **не подтверждено**. Плюс lightwalletd строит собственный кэш compact-блоков.
- **Подозрение на снапшот:** в метаданных `zebrad_version: 6.3.0`, а высота 4 468 596 уже после активации NU7 (4 465 026). Ежедневных снапшотов после 07.10 нет. Снапшот мог быть снят с ноды, которая осталась на ветке без NU7. **Не подтверждено.** Проверять так: сравнить хеш блока на высоте >4 465 026 с `testnet.zec.rocks`.

### Риск
Своя связка Zebra + lightwalletd на testnet означает 1–2 дня возни с NU7 и снапшотом, а ядру это ничего не даёт. Зависимость от `testnet.zec.rocks` — это один сторонний сервер без SLA.

### Рекомендация
- В разработке и демо использовать **публичный lightwalletd** (`testnet.zec.rocks:443` или `zec.rocks:443`, `na.zec.rocks` и т.д.). Адрес эндпоинта держать в конфиге.
- В `infra/` оставить docker-compose `zebrad:7.0.0-rc.0` + `lightwalletd:v0.5.5` как «self-hosted» вариант для README. Это плюс в глазах судей, но не блокер.
- **Zaino не брать**: слишком быстро меняется. Упомянуть в README как направление.
- Приватность: пул ходит к lightwalletd, и оператор сервера видит IP пула и его `GetTransaction(txid)`. По этим запросам можно понять, какие tx интересны пулу. Для MVP это приемлемо, а в README нужно честно написать «self-host или Tor». В `zcash_client_backend` есть фича `tor`.

---

## 3. Фаусет и testnet-кошелёк юзера

### Факты
- `https://zcashfaucet.jinolabs.xyz/` пишет: *«Drips are paused for the testnet NU7 upgrade. Zallet … has no NU7 release yet»*. В обычном режиме он выдаёт 0.1 TAZ в сутки.
- **`https://faucet.testnet.valargroup.dev` работает (HTTP 200):** 0.125 TAZ в сутки, один раз на IP за 24 ч. Принимает UA, Sapling и transparent адреса. Баланс фаусета подгружается через JS, я его не проверял.
- `faucet.zecpages.com` и `testnet.zecfaucet.com` не отвечают (таймаут или нет DNS). На zecpages до сих пор ссылается `zodl-android/docs/Setup.md`.
- **Кошелёк юзера для тестов:**
  - `zingo-cli`: последний релиз `zingolib_v6.0.0` от 2026-09-08 вышел до NU7 и **на testnet сломан** (issue zingolabs/zingolib#2859 открыт: «every testnet wallet fails … invalid consensus branch id 0x77190ad9»). Поддержка NU7 влита в `dev` 09.10 (PR #2878; в `dev/Cargo.toml` стоит `zcash_client_backend =0.25.0-pre.1`). То есть **собирать нужно из `dev`**.
  - `zcash-devtool`: на testnet не работает (см. п.1).
  - ZODL Android: вариант `zcashtestnetDebug` собирается из исходников (`docs/Setup.md`, `app/src/zcashtestnetFoss*`). В релизных APK только mainnet. SDK 5.1.0 (2026-10-07) уже на NU7 pre-release крейтах. Что приложение 3.16.0 реально синкается с testnet, **не проверено**.

### Риск
На демо нужно несколько TAZ, а 0.125 TAZ в сутки на IP — это очень мало. Любая сборка из `dev` может сломаться в любой день.

### Рекомендация
- **Сегодня же** запросить TAZ у Valar и попросить крупную сумму в Zcash Discord / R&D. Как запасной вариант — майнинг на своей Zebra (на testnet действует правило min-difficulty).
- Для тестов юзера использовать zingo-cli из `dev`, **зафиксировав коммит**.
- Сильно склоняюсь к варианту **B (mainnet, ~0.01–0.05 ZEC на сделку)**: ZODL из стора, стабильные крейты, живой демо-флоу «сканирую QR в настоящем кошельке». Solana-сторона всё равно mainnet-ориентирована (pump.fun).

---

## 4. ZODL, ZIP-321 и размер memo

### Факты
- ZIP 321 (`zips/zip-0321.rst`): `memo=<base64url без паддинга>`, декодированный memo **≤ 512 байт**, разрешён только для shielded-получателя.
- ZIP 302: если memo начинается с `0xFF`, это произвольные бинарные данные; `≤ 0xF4` означает UTF-8 текст.
- Размер memo в Ironwood/v6 тот же: 512 байт на output. Memo-бандлы ZIP 231 со статусом **Draft**, на них не опираться.
- ZODL (форк Zashi, `zodl-inc/zodl-android` 3.16.0, `zodl-ios`): разбирает ZIP-321, при multi-recipient URI fail-closed (zodl-ios#1849). Открытые темы по безопасности: zodl-project#60, zodl-android#2217. Отображает ли ZODL **бинарный** (не UTF-8) memo из URI и разрешает ли его отправить, **по документации не подтверждено**. Был баг с отдельными символами в memo из QR (zodl-android#1678, закрыт в 2024).
- Testnet в ZODL: см. п.3, только сборка из исходников.

### Расчёт размеров (python, фактические длины)
| Вариант | Байт |
|---|---|
| JSON compact, pubkey/sig в base58, mint 44, `min_out` u64 строкой | **281** |
| То же, pubkey/sig в hex | 341 |
| JSON + `refund_ua` (~230 симв.) + `nonce` + `exp` | **~576 → не влезает** |
| Бинарный core | **152** (base64url-текст: 203 симв.) |

### Предлагаемая компактная кодировка `unz1`
```
off len  поле
0   1    magic 0x55 ('U')
1   1    version (1)
2   1    op: 1 buy, 2 sell, 3 create, 4 withdraw
3   1    venue: 1 pumpfun, 2 meteora-dbc, 3 jupiter
4   32   mint (raw pubkey) | для create — sha256(meta), сама meta через /api/intents
36  8    min_out (u64 LE) | для sell — amount
44  32   anon_pubkey (ed25519)
76  8    nonce (u64, анти-replay/идемпотентность)
84  4    expiry (unix sec, u32)
88  1    refund_kind: 0 none, 1 raw shielded receiver (43 байта), 2 sol addr (32)
89  0/43/32 refund / withdraw_to
..  64   sig = ed25519(anon_sk, "unzeen/v1" || chain_id || все байты выше)
```
Максимум 152 + 43 = **195 байт**. Хватает с запасом.

**Обёртка.** В memo кладём UTF-8 текст `unz1:` + base64url(бинарь), ~270 символов. Так memo проходит в любом кошельке, где поддерживаются только текстовые memo, и юзер видит его в истории как непонятную строку, а не как ошибку. В URI это значит `memo=base64url(utf8("unz1:..."))`, ~360 символов. Сам URI получится ~500–600 символов, это QR версии примерно 15–20. Если класть сырой 512-байтный JSON, вышло бы ~690 символов только на memo, и такой QR труднее сканировать.

### Риск
- Отправлять refund как полную UA строкой расточительно, а при UA Revision 2 с истёкшим сроком выплата упадёт с `RecipientAddressExpiry`.
- Подпись без `chain_id`, `nonce` и `expiry` открывает возможность replay/двойного исполнения при повторной обработке после reorg/rescan.
- В `docs/API.md` поле `PaymentRequest.memo` — строка без описания формата.

### Рекомендация
Принять `unz1` как формат v1 и описать его в `docs/API.md`: `memo` = готовая UTF-8 строка, `zip321Uri` строит бек через крейт `zip321`. Сканер по `nonce` делает идемпотентную обработку (unique index). В первую очередь проверить ZODL вручную: отправку по URI с текстовым memo длиной ~300 символов.

---

## 5. FROST для Orchard/Ironwood (roadmap)

`frost-core 3.0.0` и `frost-rerandomized 3.0.0` вышли 2026-04-23. Но `reddsa 0.6.0` (2026-09-25) **удалил фичу `frost`**: в CHANGELOG написано «FROST ciphersuites will be moved to the frost repository». Отдельного релиза RedPallas-FROST пока нет (крейта `frost-redpallas` на crates.io нет). ZF `frost-tools` (frostd, frost-client, zcash-sign) обновлялся 2026-10-02, но всё ещё сидит на `frost-core 2.2`, `reddsa` из git, **форке orchard** (`conradoplg/orchard`, фича `unstable-frost`) и `zcash_client_backend 0.24.0-rc.1`. При этом `zcash-sign` строит tx из плана YWallet. Со стеком NU7/pre-release это несовместимо. В `zcash_keys` есть фича `unstable-frost`, а в devtool есть PCZT-флоу (`pczt create/sign/combine/send`), так что правильный путь в будущем — **PCZT + внешний FROST-подписант**. **Вывод:** собрать живую t-of-n трату пула в демо за 16 дней нереально. Максимум — офлайн-демо 2-of-3 подписи RedPallas на `reddsa 0.5.2 --features frost` без on-chain части. Я бы и этого не делал. В README и на слайде: «Roadmap: FROST t-of-n spend authority via PCZT (ZF frost-tools)».

---

## 6. Задержки

### Факты
- Целевой интервал блока **75 с** (`zcash_protocol::consensus::SECONDS_PER_BLOCK = 75`), одинаковый для mainnet и testnet после Blossom.
- **Замер testnet** (gRPC `GetBlock` к testnet.zec.rocks, поле `time`):
  - блоки 4 492 640–4 492 700: среднее **24.6 с**, медиана 18 с, p90 51 с, максимум 92 с;
  - 4 479 850–4 480 000: среднее 24.2 с, медиана 18 с;
  - 4 469 900–4 470 000: среднее 10.7 с, медиана 7 с.

  Testnet заметно быстрее mainnet и сильно скачет (min-difficulty).
- **Подтверждения** (ZIP 315, `zcash_client_backend/src/data_api/wallet.rs:444-470`): по умолчанию trusted = 3, untrusted (внешние входящие) = **10**. Есть политика с 1/1. Политику учёта депозита в реестре выбираем сами, а вот **тратить** депозит (на refund или выплату) по умолчанию можно только после 10 подтверждений.
- Латентность «депозит → видно в сканере»:
  - mempool (`GetMempoolStream` + trial-decrypt): **~1–5 с** после broadcast. Оценка, не замер;
  - 1 подтверждение: testnet ~10–25 с (медиана 7–18 с), mainnet ~75 с. Сверху добавляется период опроса сканера и `GetTransaction` для memo, это ещё ~1–3 с;
  - 10 подтверждений: testnet ~2–4 мин, mainnet ~12.5 мин.

### Риск
Если исполнять сделку на 0-conf, возможен double-spend или reorg, и тогда пул потратит SOL без реального депозита. Если ждать 10 подтверждений, демо выйдет медленным. Есть и риск для приватности: «депозит → сделка через ровно N блоков» даёт корреляцию по таймингу (см. ARCHITECTURE «задержки и батчинг»).

### Рекомендация
- Статусы `seen` (mempool), `confirmed` (≥ K) и `executed`.
- K задаётся в конфиге: в демо/testnet **K = 1–2**, на mainnet для прода **K ≥ 3** при малых суммах (≤ лимита) и 10 для крупных.
- Исполнение — со **случайной задержкой**, батчами по эпохам (например раз в N блоков). Задержка добавляется к ожиданию подтверждений, а не заменяет его.
- Для выплат: держать «горячий» запас у пула из своих (trusted) нот, чтобы refund не ждал 10 подтверждений депозита.

---

## Открытые вопросы для лида
1. **Сеть для демо: testnet (A) или mainnet с малыми суммами (B)?** От этого зависят пины крейтов и вся работа backend в дни 1–2. Я рекомендую B для демо и A для CI.
2. Переименовать «Orchard» в «Ironwood» в `docs/ARCHITECTURE.md`, `docs/STACK.md`, `CLAUDE.md` и на фронте (лендинг, тексты). Это нужно сделать до начала кода.
3. Принять формат memo `unz1` (п.4) и внести его в `docs/API.md`? Сюда же относится `create`: meta (имя, символ, картинка) в 512 байт не влезает, поэтому её нужно передавать через `/api/intents`, а в memo класть только хеш. Это ещё и связывает IP с intent: нужно решить, приемлемо ли это.
4. Кто и когда добывает TAZ (если выбран A) и вручную проверяет ZODL-testnet?
5. Ставим ли свою Zebra + lightwalletd вообще, или README честно пишет «публичный lightwalletd, self-host — опция»?

## Источники (проверено 2026-10-12)
- crates.io API: `https://crates.io/api/v1/crates/{zcash_client_backend,zcash_client_sqlite,zcash_keys,orchard,zcash_protocol,zcash_primitives,zip321,pczt,frost-core,frost-rerandomized,reddsa,zainod}`; исходники крейтов с `static.crates.io` (CHANGELOG, Cargo.toml).
- zcash_protocol 0.11.0-pre.0 CHANGELOG: «sets the NU7 activation height to 4465026 on testnet», branch id `0x77190AD9`.
- ZIP 258 (NU6.3 / Ironwood): https://github.com/zcash/zips/blob/main/zips/zip-0258.md; ZIP 318 (миграция), ZIP 229 (v6 tx), ZIP 231 (Draft), ZIP 302, ZIP 321, ZIP 315.
- The Block, 28.07.2026: https://theblock.co/post/409934/zcash-ironwood-upgrade-launching-new-shielded-pool-after-orchard-vulnerability
- Cake Wallet, Ironwood migration: https://docs.cakewallet.com/cryptos/zcash/ironwood-migration
- KuCoin, обзор NU6.3: https://www.kucoin.com/blog/zcash-ironwood-nu6-3-shielded-pool-migration
- zingolib#2859 (NU7 ломает testnet-кошельки): https://github.com/zingolabs/zingolib/issues/2859; PR #2878 (NU7 deps, влит в dev 2026-10-09).
- zcash-devtool: https://github.com/zcash/zcash-devtool (main @ 5a26ee85, `Cargo.toml`, `src/remote.rs`, `src/commands/wallet/*`, `doc/walkthrough.md`).
- lightwalletd releases: https://github.com/zcash/lightwalletd/releases; Zaino: https://github.com/zingolabs/zaino/releases; Zebra: https://github.com/ZcashFoundation/zebra/releases, PR #11554.
- Zebra requirements/snapshots: https://github.com/ZcashFoundation/zebra/blob/main/book/src/user/requirements.md, https://snapshots.zfnd.org/testnet/snapshots.json
- Живые gRPC-запросы к `testnet.zec.rocks:443` и `zec.rocks:443` (`GetLightdInfo`, `GetBlock`), 2026-10-12 ~16:18 UTC.
- Фаусеты: https://zcashfaucet.jinolabs.xyz/ (пауза), https://faucet.testnet.valargroup.dev (работает); список: https://zechub.wiki/using-zcash/faucets
- ZODL: https://github.com/zodl-inc/zodl-android (releases 3.16.0, `docs/Setup.md`), https://github.com/zodl-inc/zodl-android-wallet-sdk (CHANGELOG 5.1.0, PR #32), zodl-ios#1849, zodl-android#2217, zodl-project#60.
- FROST: https://github.com/ZcashFoundation/frost, https://github.com/ZcashFoundation/frost-tools (Cargo.toml), reddsa CHANGELOG 0.6.0.
