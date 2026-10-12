# Solana-часть: лаунчпады, Jupiter, Jito, NEAR Intents, курс ZEC/SOL

Автор: analyst. Дата проверки всех фактов: **2026-10-12** (день 1). Версии npm сняты через `npm view`, наличие программ — прямыми RPC-запросами `getAccountInfo` / `getSignaturesForAddress` к `api.{devnet,testnet,mainnet-beta}.solana.com`, котировки — живыми запросами к Jupiter и 1Click.

---

## TL;DR

**Блокеров нет. Ключевые выводы, которые меняют план:**

1. **У pump.fun ЕСТЬ devnet.** Программы `6EF8…F6P` (bonding curve), `pAMM…EA` (PumpSwap), `pfee…VZ` (fees) задеплоены и активны на devnet (успешные транзакции 12.10 16:08 UTC). Риск «тесты только на mainnet» из `STATUS.md` снимается. Mainnet — только для финального прогона и видео.
2. **create + первая покупка атомарны в ОДНОЙ транзакции** и на pump.fun (`createV2AndBuyV2Instructions`), и на Meteora DBC (`createPoolWithFirstBuy`). Jito для базового «запуска без снайперов» не нужен. Jito нужен только если fair-launch покупает с нескольких vault (create-транзакция + до 4 транзакций покупки в одном бандле).
3. **Jupiter маршрутизирует токены на кривой pump.fun ДО graduation** (проверено живой котировкой) и также видит DBC, PumpSwap, DAMM v2 и Raydium LaunchLab. Это **самый дешёвый универсальный адаптер для buy/sell**. Резать его первым — ошибка, порядок урезания стоит пересмотреть (см. конец файла).
4. **NEAR Intents 1Click: ZEC только transparent** (по документации: «Partially supported — Transparent addresses only»). Testnet нет. Минимум ~0,00132 ZEC, исполнение ~7,5 минуты. Подходит **только для ребаланса пула** батчами фиксированного размера. Выплаты пользователям через 1Click делать **нельзя**: адрес получателя был бы transparent, а по правилам хакатона «утечка = дисквалификация».
5. **stonk.fun — не Meteora DBC, а Raydium LaunchLab.** Своего SDK нет, пулы создаёт кошелёк оператора. Покупать и продавать можно через Jupiter (у него есть метка «Raydium Launchlab»), а создавать токены «на stonk.fun» сторонне, по-видимому, нельзя (не подтверждено).
6. **Pyth: фид ZEC/USD есть** (`be9b59d1…bb24`), но с июля–августа 2026 Hermes требует API-ключ (живой запрос вернул 401). Без ключа цены ZEC и SOL отдаёт 1Click `/v0/tokens`.

**Риски уровня high:**
- `@pump-fun/pump-sdk` за 4 недели выпустил три мажорные версии (2.0.0 от 13.09, 3.0.0 от 07.10, 4.0.0 от 08.10), программа обновлялась примерно 7 дней назад. Версию нужно зафиксировать точно, а за 2 дня до сдачи прогнать всё заново.
- `creator` в pump.fun и pool creator в DBC публичны в блокчейне. Указать там кошелёк пользователя значит полностью его деанонимизировать. Creator всегда должен быть адресом пула.

---

## 1. pump.fun

### Факты
| Что | Значение | Источник |
|---|---|---|
| Официальный SDK | `@pump-fun/pump-sdk` **4.0.0** (опубликован 2026-10-08), репозиторий `github.com/pump-fun/pump-sdk` | `npm view`, package.json |
| SDK пула после graduation | `@pump-fun/pump-swap-sdk` **2.1.0** (2026-10-07). pump-sdk 4.0.0 тянет `^1.13.0`, так что версии нужно согласовать | `npm view` |
| Зависимости | `@solana/web3.js ^1.98.2`, `@coral-xyz/anchor ^0.31.1`, `@solana/spl-token ^0.4.13`, `bn.js`. **Это web3.js v1, не `@solana/kit`** | package.json |
| Program ID (кривая) | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` (одинаковый на mainnet и devnet; на testnet аккаунт тоже есть, но работоспособность не проверена) | `sdk.ts:138`, RPC |
| PumpSwap AMM | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` (mainnet + devnet) | `sdk.ts:156`, RPC |
| Fee program | `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` (mainnet + devnet) | `sdk.ts:164`, RPC |
| Mayhem program | `MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e` (нужен как аккаунт в `create_v2`) | `sdk.ts:160` |
| Devnet | **Есть.** Последний апгрейд ProgramData был на слоте 508 659 609 (devnet) и 454 596 459 (mainnet): оба примерно неделю назад, сети, судя по всему, синхронны. В README SDK примеры написаны для `api.devnet.solana.com`, в коде есть devnet USDC `4zMMC9…DU` | RPC, README |

### Инструкции (IDL из пакета)
- **create:** `createInstruction` / `createAndBuyInstructions` помечены `@deprecated`. Использовать `createV2Instruction` / `createV2AndBuyV2Instructions` (`create_v2`: Token-2022 mint, 16 аккаунтов, аргументы `name, symbol, uri, creator, is_mayhem_mode, is_cashback_enabled, creator_fee_bps, is_holder_reward`). Подписывают `mint` (новый keypair) и `user` (плательщик). **`creator` — отдельный аргумент, не подписант**, то есть vault платит, а creator можно поставить любым.
- **buy/sell:** актуальные инструкции `buy_v3`, `buy_exact_quote_in_v3`, `sell_v3` (17 аккаунтов, Token-2022 по умолчанию; для `create_v2`-монет передавать `TOKEN_2022_PROGRAM_ID` и в `fetchBuyState`). Для «потратить ровно X SOL» удобнее `buyExactQuoteInV3Instructions`, слиппедж задаётся через `min_tokens_out`. Ошибки слиппеджа: `TooMuchSolRequired`, `TooLittleSolReceived`, `BuySlippageBelowMinTokensOut`. Котировка: `getBuyV3TokenAmountFromQuoteAmount({global, feeConfig, mintSupply, bondingCurve, amount, curveBaseTokenBalance})`.
- **Покупка за порогом graduation:** v3 сама завершает кривую и докупает остаток из пула, который создаст миграция (событие `PostCompleteBuyEvent`).
- **После graduation:** торговля в PumpSwap через `@pump-fun/pump-swap-sdk` (`buy_v2`/`sell_v2` пула) **или через Jupiter**. `status()` адаптера определяется по `bondingCurve.complete`.
- **Compute budget:** README рекомендует ~500k CU на create + buy и 250–300k на отдельные `buy_v2`/`sell_v2` с котировкой в Token-2022.

### Может ли один vault покупать многократно
**Да.** Программа не ограничивает число покупок с одного кошелька. Первая покупка vault по конкретному mint дополнительно платит ренту за ATA (~0,0015 SOL при 170 байтах, Token-2022) и, видимо, за `user_volume_accumulator`. Для приватности учтите: `user_volume_accumulator` — PDA на кошелёк, он агрегирует объём vault. Это не новая утечка (все сделки vault и так видны по pubkey), но vault за счёт этого становится заметнее.

### Creator fee
- Ставки берутся из on-chain `FeeConfig.feeTiers` и зависят от капитализации; читать их в рантайме через `onlineSdk.fetchFeeConfig()`. **Точные текущие проценты по первоисточнику не подтверждены**: вторичный источник (blofin, 2026) даёт ~1,25% на сделку на кривой, из них 0,95% протоколу и 0,30% создателю. Официальная страница pump.fun/docs/fees не загрузилась.
- Начисление: при v3-сделках creator fee копится **в «ведре» на кривой** (`BondingCurve.creatorFee`), пока кто-нибудь не вызовет `sweep_creator_fee` (permissionless, `payer` — любой подписант). Затем `collect_creator_fee` переводит деньги из `creator_vault` на адрес `creator`. **`creator` в ней не подписант**, вызвать её может кто угодно, но лампорты уйдут только на адрес creator. После graduation то же делается через `sweepPoolCreatorFeeInstruction` и `collect_coin_creator_fee` в PumpSwap.
- Хелперы SDK: `getCreatorVaultBalanceBothPrograms(creator)`, `collectCoinCreatorFeeInstructions(creator)`. Перед collect обязательно сделать sweep, иначе ошибка `CreatorFeesNotSwept` (6095).
- Fee sharing настраивается **только один раз**, поменять потом нельзя. Не трогать.

### Стоимость create и минимальные суммы (devnet бесплатен, mainnet — оценка)
- Создание на pump.fun без комиссии платформы (вторичный источник). Платится только рента: bonding curve 166 байт = 0,00149 SOL, ATA кривой ~0,0015 SOL, mint Token-2022 с метаданными ~0,003 SOL (около 450 байт, оценка), плюс ATA и volume-аккаунт vault и комиссия сети. **Итого ориентир 0,008–0,015 SOL на create** (на 12.10 SOL стоит $108,94, это $1–2). **Не подтверждено, проверить `simulateTransaction` на devnet.**
- Минимальную сумму покупки программа не задаёт. Для mainnet-теста хватит 0,01–0,02 SOL на сделку, а на весь сквозной прогон с create, 3–5 buy, sell, withdraw — **бюджет ~0,3 SOL** (~$33).

### Риск
- **High:** SDK меняется очень быстро. Сборщики инструкций старых версий ломаются после апгрейда программы (в README это прямо сказано про `update_fee_shares`).
- **High (приватность):** `creator` публичен. Если поставить туда кошелёк пользователя или переиспользовать один creator для всех запусков одного пользователя, это деанонимизирует или связывает его запуски.
- **Medium:** devnet-монеты не видны на сайте pump.fun, поэтому эффект «виден на pump.fun» в демо даёт только mainnet.
- **Medium:** нужно хранилище метаданных (`uri`). Загрузка в IPFS-API pump.fun неофициальная. Метаданные заливать **с сервера**, а не из браузера пользователя: иначе IP пользователя окажется связан с mint.

### Рекомендация
1. Зафиксировать `"@pump-fun/pump-sdk": "4.0.0"` и `"@pump-fun/pump-swap-sdk"` в той версии, которую резолвит 4.0.0. Без `^`.
2. Разрабатывать на **devnet**. Mainnet — один прогон на 13–14 день и запись видео.
3. Create: `createV2AndBuyV2Instructions` с `user = vault`, `creator = свежий адрес под запуск, принадлежащий пулу` (HD-деривация по launch-id). Creator fee собирать батчем: sweep + collect, затем выплата создателю в shielded ZEC.
4. Buy/sell по кривой: `buyExactQuoteInV3Instructions` / `sellV3Instructions`. После graduation — через Jupiter (см. п. 4), PumpSwap SDK не тянуть, если не понадобится.

---

## 2. Meteora Dynamic Bonding Curve

| Что | Значение | Источник |
|---|---|---|
| SDK | `@meteora-ag/dynamic-bonding-curve-sdk` **1.5.13** (2026-10-10), MIT | `npm view`, README |
| Program ID | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`, **один и тот же на mainnet и devnet** (в README и проверено RPC, devnet активен) | README, RPC |
| Graduation | в DAMM v2 (`cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`), DAMM v1 для новых конфигов закрыт | README |
| Нужен ли свой config | **Да, пул создаётся только от config key.** Но создание конфига **permissionless**: «Any payer can create a config account, but the config fixes the `fee_claimer` and `leftover_receiver`». Unzeen создаёт один свой конфиг и становится «партнёром»-лаунчпадом, получая partner fee | docs.meteora.ag/core-products/dbc/accounts-and-permissions |
| create + buy в одной tx | **Да:** `createPoolWithFirstBuy(params): Promise<Transaction>` — «Build one transaction that initializes a pool and optionally appends the first buy». Есть ещё `createConfigAndPoolWithFirstBuy` (возвращает отдельные транзакции для отправки по отдельности или бандлом) | `dist/index.d.ts:6643,6759` |
| Swap | `swap` / `swap2` | d.ts |
| Комиссии | протокол забирает 20% торговой комиссии; partner и creator делят остаток по конфигу; referral получает 20% от протокольной доли | docs DBC Fees |
| Миграция | keeper-ы мигрируют автоматически **только на mainnet**, при пороге quote ≥ 10 SOL (WSOL) / 750 USDC. На devnet миграцию делать вручную: migrator.meteora.ag | docs DBC Migration |
| Creator fee | claim делает текущий pool creator (нужна его подпись) | docs DBC Accounts |

**Риск:** medium. Нужно спроектировать кривую (параметры конфига), это время, которого нет. Токены с нашим конфигом не появятся ни в одном UI лаунчпада, их видно только в агрегаторах (Jupiter, gmgn, dexscreener).
**Рекомендация:** если Meteora остаётся, брать готовый пресет кривой из примеров SDK (`docs.meteora.ag/developer-guides/dbc/typescript-sdk/examples`), конфиг создать один раз скриптом. **Не форкать Meteora «fun-launch» scaffold**: по правилам это «existing product / repackaged». Pool creator — адрес пула (см. риск приватности в п. 1).

---

## 3. stonk.fun

**Вывод: не Meteora DBC и не собственная программа, а Raydium LaunchLab** (`LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`); graduation идёт в Raydium CPMM. По описанию в DefiLlama — «A Solana launchpad to launch coins paired with anything» (пары с токенизированными акциями).
Источник — исходник адаптера DefiLlama `fees/stonkfun.ts` (github.com/DefiLlama/dimension-adapters): «The operator wallet creates the pools… `LAUNCHLAB_PROGRAM = "LanMV9sAd7…"`… Graduated launches migrate here [Raydium CPMM]». Кошелёк оператора: `5CEbueQnq1Ym2uSSx2xXds3jQAqT1BDnkA59RZobSPAG`, токен STONK `6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx`.
- Публичного SDK у stonk.fun нет (на stonkfun.xyz нет docs и github). Raydium SDK: `@raydium-io/raydium-sdk-v2` **0.2.74-alpha** (alpha).
- **Создать токен «на stonk.fun» сторонне, похоже, нельзя**: пулы создаёт кошелёк оператора. Не подтверждено.
- Buy/sell по токенам stonk.fun работают через Jupiter (метка «Raydium Launchlab» есть в `program-id-to-label`).

**Риск:** low, если не обещать stonk.fun в питче. **Рекомендация:** убрать stonk.fun из скоупа как отдельный адаптер и в README писать «любой токен, который маршрутизирует Jupiter, включая LaunchLab-лаунчпады». Отдельного кода не нужно.

---

## 4. Jupiter

| Что | Значение |
|---|---|
| API | `api.jup.ag` (по докам сейчас единый base URL), ключ **не обязателен**: «start making requests to `api.jup.ag` immediately»; без ключа **0,5 RPS**, Free plan — 1 RPS. Старый `lite-api.jup.ag` ещё отвечает (12.10), но в текущих доках не упоминается, на него не полагаться |
| Кривая pump.fun до graduation | **Да.** Живая котировка SOL→`BsbsUgeQ7MDTXP4BuEuKm5NVpgUQR5n7iLtXe2Mrpump` (кривая, `complete=false`, капитализация ~$3,6k) вернула маршрут `[("Pump.fun", CUGastRd…)]`, то же для `JEDRiTwk…pump` |
| DBC до graduation | **Да:** `dbcij3…` = «Dynamic Bonding Curve» в `/swap/v1/program-id-to-label`, в доках Meteora сказано, что Jupiter интегрирован напрямую. Живая котировка по DBC-токену не делалась |
| Другие площадки | Pump.fun Amm (PumpSwap), Meteora DAMM v2, DLMM, Raydium Launchlab, Moonit, Boop.fun |
| npm | `@jup-ag/api` 6.0.48 — опционально, достаточно `fetch` |

**Риск:** medium. (а) Свежий токен может индексироваться с задержкой (секунды–минуты), поэтому сразу после create покупать напрямую через pump.fun-адаптер. (б) 0,5 RPS без ключа хватит для демо, но не для нагрузки. (в) Jupiter работает только на mainnet.
**Рекомендация:** сделать Jupiter **основным путём buy/sell для всего, что уже существует** (любые площадки, после graduation), а прямые адаптеры pump.fun/DBC оставить для `create` и первой покупки. Это убирает необходимость в PumpSwap SDK и в отдельной логике graduation.

---

## 5. Jito bundles

| Что | Значение (docs.jito.wtf/lowlatencytxnsend, 12.10) |
|---|---|
| Endpoint | `https://mainnet.block-engine.jito.wtf/api/v1/bundles` + регионы (amsterdam, frankfurt, ny, tokyo…). **Testnet есть** (`testnet.block-engine.jito.wtf`), **devnet нет** |
| Ключ | «You no longer need an approved auth key for default sends». Лимит **1 rps на IP на регион** |
| Бандл | до **5 транзакций**, исполняются последовательно в одном слоте; «If any transaction in a bundle fails, none… will be committed» |
| Tip | минимум **1000 lamports**. Перевод на один из 8 адресов `getTipAccounts` (проверено, отвечает), **внутри основной транзакции**, а не отдельной (иначе «uncle bandit»). Tip floor на 12.10 16:23 UTC: p50 = 3,6e-6 SOL, p95 = 2,4e-5 SOL, p99 = 7,2e-5 SOL |
| Статус | `getBundleStatuses`, `getInflightBundleStatuses` (окно 5 минут) |
| npm | `jito-ts` 4.2.1 (не обновлялся с 2025-09); для JSON-RPC sendBundle достаточно `fetch` |

**Атомарный create + buy на pump.fun:** для одного покупателя бандл **не нужен**, хватает одной транзакции `createV2AndBuyV2Instructions`. Бандл нужен, если fair-launch должен (а) раздать покупку по нескольким vault (шардирование, чтобы не было одного огромного холдера) или (б) не помещается в 1232 байта: tx1 = create + buy(vault1), tx2..tx5 = buy(vault2..5), tip в последней.

**Риск:** medium. Протестировать бандл с pump.fun можно только на mainnet: на devnet нет Jito, а на testnet пригодность pump-программы не проверена. Бандлы иногда не попадают в блок, нужен retry с новым blockhash.
**Рекомендация:** fair-launch v1 = **одна транзакция** create + buy с одного vault, затем распределение долей в реестре (токены on-chain у vault). Jito-бандл по нескольким vault — улучшение на дни 11–12, если останется время.

---

## 6. NEAR Intents 1Click (ZEC → SOL)

| Что | Значение |
|---|---|
| API | `https://1click.chaindefuser.com/v0/…`: `GET /tokens`, `POST /quote` (`dry:true` — котировка без депозитного адреса), `GET /status`, `POST /deposit/submit`. OpenAPI: `1click.chaindefuser.com/docs/v0/openapi.yaml` |
| SDK | `@defuse-protocol/one-click-sdk-typescript` **0.1.26** (2026-09-22) |
| ZEC | `nep141:zec.omft.near`, 8 decimals. **Только transparent**: в docs.near-intents.org/resources/chain-support сказано «ZCash … Transparent — `t1` or `t3` prefix. ⚠️ Partially supported — Transparent addresses only» и «ZEC (Zcash, transparent only)». Так что депозитный адрес и `refundTo` — t-адреса. Zashi и Brave делают shielded→swap, но на клиенте это unshield в t-адрес |
| SOL | `nep141:sol.omft.near` |
| Testnet | **Нет** (в доках и OpenAPI ни одного упоминания testnet) |
| Минимум | живой dry-запрос на 0,001 ZEC вернул: «Amount is too low for bridge, try at least 132000», то есть **0,00132 ZEC** |
| Котировки (dry, 12.10 ~16:20 UTC, без ключа, slippage 1%) | 0,02 ZEC → 0,23170 SOL; **0,5 ZEC → 5,79367 SOL** ($632,01 → $631,16). `timeEstimate` = **452 с** |
| Комиссии | протокол 0,0001%; **без API-ключа +0,25%**; с ключом (JWT из partners.near-intents.org) обычно 0,20%; вывод ZEC на Solana 0,1% (в доке относится к выводу ZEC как токена на Solana, к нашему ZEC→SOL, вероятно, не относится) |
| Лимиты | в OpenAPI есть ответ 429 `rate-limit-exceeded`, конкретные числа не опубликованы |
| Confidential | есть параметр `confidentiality: "basic" \| "advanced"` (Confidential Intents). Работает ли он с ZEC — **не проверено** |

**Риск:** **high (приватность)**. Unshield пула в t-адрес публикует сумму и время на Zcash. Если ребаланс повторяет отдельные депозиты по сумме или времени (депозит → сразу ребаланс на ту же сумму), связь восстанавливается. Medium: testnet нет, и сквозной тест стоит реальных денег (минимальная сумма копеечная).
**Рекомендация:**
1. 1Click используется **только** для пакетного ребаланса пула: фиксированные «круглые» лоты (например, 0,5 ZEC), по расписанию и по порогу запаса SOL, без связи с конкретными депозитами.
2. **Никогда** не выплачивать пользователю через 1Click (recipient/refund — t-адрес). Выплаты пользователям — только shielded ZEC из резерва пула.
3. Для демо достаточно одного ручного ребаланса на mainnet, автоматизация не обязательна (совпадает с текущим порядком урезания).
4. Получить партнёрский JWT заранее: −0,05% и стабильнее.

---

## 7. Курс ZEC/SOL

| Источник | Статус |
|---|---|
| **Pyth** | Фид **есть**: `Crypto.ZEC/USD` id `0xbe9b59d178f0d6a97ab4c343bff2aa69caa1eaae3e9048a65788c529b125bb24`, `Crypto.SOL/USD` id `0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d` (через `hermes.pyth.network/v2/price_feeds`). **Но `GET /v2/updates/price/latest` без ключа отвечает 401**: в доках Pyth стоит баннер «Every Core user will need an API Key» (даты 31.07 и 18.08.2026 расходятся). `@pythnetwork/hermes-client` 3.1.0 |
| **1Click `/v0/tokens`** | Без ключа отдаёт `price` для ZEC (1264,02) и SOL (108,94) с `priceUpdatedAt` (12.10 16:19 UTC). Источник агрегатора не раскрыт |
| **1Click dry quote** | Реальная исполнимая цена ZEC→SOL с учётом комиссий |

**Риск:** medium. Курс определяет, сколько SOL получит пользователь за свои ZEC. Ошибка или манипуляция = потери пула.
**Рекомендация:** основной курс — 1Click dry quote на стандартный лот (ближе всего к реальной цене ребаланса). Sanity-check — Pyth (взять бесплатный ключ) или 1Click `/tokens`; при расхождении больше 2% intent отклоняется. Курс фиксируется в момент выставления `PaymentRequest` и хранится в intent вместе с `expiresAt`.

---

## Пересматривать ли порядок урезания

Текущий порядок: **Jupiter → Meteora → NEAR Intents → fair-launch**.

**Рекомендую поменять на: Meteora → Jito (multi-vault) → NEAR Intents (автоматизация) → fair-launch (tlock) → Jupiter.**

Обоснование:
- **Jupiter — самый дешёвый и самый полезный адаптер:** один HTTP-вызов покрывает buy/sell по кривой pump.fun, после graduation (PumpSwap), DBC, LaunchLab (stonk.fun). Без него придётся писать PumpSwap-адаптер и логику graduation, а это дороже. Ядро «депозит → покупка → лента → вывод» при этом не страдает: первая покупка после create идёт напрямую через pump.fun.
- **Meteora** — отдельный конфиг, кривая и ручная миграция на devnet. Вклад в оценку минимальный («pump.fun + любой токен через Jupiter» уже даёт «Launch anywhere»). Резать первым.
- **Jito** уже не нужен для атомарности (create + buy в одной tx). Резать multi-vault-бандл раньше tlock.
- **NEAR Intents:** ручной ребаланс на демо, как и было.
- **Fair-launch (tlock sealed-bid)** — самое близкое к формулировке трека («Sealed-bid auctions… price public, participants not»). Его стоит держать до последнего в упрощённой форме: tlock-заявки + одна транзакция create + buy с одного vault.

---

## Открытые вопросы для лида
1. Демо для судей: Zcash testnet + Solana **devnet** (pump.fun на devnet работает, судьи могут взять фаусетный ZEC) или mainnet? Предлагаю гибрид: интерактивный демо-URL на testnet/devnet, mainnet-прогон в видео.
2. Подтвердить переход на `@pump-fun/pump-sdk` (web3.js v1 + anchor), а не на `@solana/kit`, и указать это в `STACK.md`. Смешивать kit и web3.js v1 в релейере невыгодно.
3. Кто создаёт ключи и партнёрский аккаунт: Pyth API key, 1Click JWT, Helius (devnet + mainnet).
4. Нужна ли Meteora вообще, учитывая п. «Пересматривать ли порядок урезания»?

## Источники (проверено 2026-10-12)
- npm: `@pump-fun/pump-sdk@4.0.0`, `@pump-fun/pump-swap-sdk@2.1.0`, `@meteora-ag/dynamic-bonding-curve-sdk@1.5.13`, `@jup-ag/api@6.0.48`, `jito-ts@4.2.1`, `@defuse-protocol/one-click-sdk-typescript@0.1.26`, `@pythnetwork/hermes-client@3.1.0`, `@raydium-io/raydium-sdk-v2@0.2.74-alpha`
- https://github.com/pump-fun/pump-sdk (README и `src/sdk.ts`, `src/idl/pump.json` из npm-тарбола 4.0.0)
- https://github.com/MeteoraAg/dynamic-bonding-curve-sdk (README из тарбола 1.5.13)
- https://docs.meteora.ag/core-products/dbc/accounts-and-permissions.md , …/fees/overview.md , …/migration-and-liquidity.md , https://docs.meteora.ag/developer-guides/dbc/typescript-sdk/getting-started.md
- https://raw.githubusercontent.com/DefiLlama/dimension-adapters/master/fees/stonkfun.ts , https://api.llama.fi/protocol/stonkfun
- https://developers.jup.ag/docs/api-setup , https://lite-api.jup.ag/swap/v1/program-id-to-label , живые `/swap/v1/quote`
- https://docs.jito.wtf/lowlatencytxnsend/ , https://bundles.jito.wtf/api/v1/bundles/tip_floor
- https://docs.near-intents.org/resources/chain-support.md , …/resources/fees.md , …/1click-api/authentication.md , …/quickstart/confidential-swaps.md , https://1click.chaindefuser.com/docs/v0/openapi.yaml , живые `/v0/tokens` и `/v0/quote` (dry)
- https://hermes.pyth.network/v2/price_feeds?query=ZEC , https://docs.pyth.network/price-feeds/core/api-instances-and-providers/hermes
- Вторичные (не первоисточник): https://blofin.com/academy/education/pumpfun/pump-fun-fees-explained
