# Лаунчпады, часть A: pump.fun (пары не к SOL), stonk.fun, LetsBonk / bonk.fun, Bags, Anoncoin, Surge

Автор: analyst. Дата проверки: **2026-10-13** (день 2), если не указано иное.
Как проверял:
- IDL и README из `@pump-fun/pump-sdk@4.0.0` (уже лежит в `adapters/node_modules`);
- живые RPC-запросы к mainnet и devnet: `OnlinePumpSdk.fetchSupportedQuoteMints()`; `getProgramAccounts` по Raydium LaunchLab (все GlobalConfig и PlatformConfig); подписанты create-транзакций за последние часы;
- тарбол `@raydium-io/raydium-sdk-v2@0.2.74-alpha` (только чтение исходников, код не запускал);
- живые котировки Jupiter и 1Click (dry);
- документация Bags (`docs.bags.fm/llms.txt`) и Anoncoin (`docs.anoncoin.it/llms.txt`).

Всё, что не подтверждено первоисточником или цепочкой, помечено «не подтверждено».

---

## TL;DR

**Вывод.** Самое ценное и самое дешёвое — **пары к ZEC на pump.fun**. Программа pump.fun уже принимает ZEC-on-Solana (`A7bd…QXaS`) как quote mint. Тогда баланс пользователя в ZEC тратится на покупку в ZEC, и ни курс SOL, ни своп не нужны. Пополнять запас пула можно через 1Click: ZEC (transparent) → ZEC SPL, 0,5 → 0,49999 ZEC. Вторым делом идёт один адаптер **Raydium LaunchLab**: он сразу покрывает bonk.fun и stonk.fun, а через `platformId` — любую LaunchLab-площадку. Bags делать с оговоркой (только mainnet, централизованный API). Anoncoin и Surge как площадки для create не делать.

| Площадка | Программа (mainnet) | Create сторонним сервисом | Quote для запуска | Creator fee, свежий creator | Devnet | Трудозатраты | Вердикт |
|---|---|---|---|---|---|---|---|
| **pump.fun** | свой `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | да, SDK 4.0.0, без регистрации | **SOL, USDC (Global), 205 mint-ов из QuoteControl, включая ZEC, BONK, PUMP, STONK, xStocks; любой pump-коин глубины 0 (`maxCurveDepth=1`). USD1 нет** | creator — не подписант, свежий адрес ок; для quote из QuoteControl ставка задаётся сама, 1…300 bps | да, но только SOL и devnet-USDC | +2–3 дня на пары (ZEC, USDC) поверх готового адаптера | **делать** (ZEC — главное) |
| **stonk.fun** | Raydium LaunchLab `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`, платформы `4E876q…gZL7` (стандарт) / `6BwHHD…TESt` (reward, transfer fee) | да: create подписывают кошелёк пользователя и mint, подписи оператора нет (проверено on-chain) | любой GlobalConfig LaunchLab: ~600 штук, включая **ZEC, USDC, USD1, BONK**, xStocks | `creatorFeeRate = 0`, LP после graduation уходит платформе: создатель ничего не получает | LaunchLab devnet есть (`DRay6f…tcm6`), платформы stonk там нет | общий LaunchLab-адаптер 2–3 дня, +0,3 дня на платформу | **делать в составе LaunchLab** |
| **bonk.fun** (LetsBonk) | Raydium LaunchLab, платформа `FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1` | по программе да (`restrictGlobalConfig=0`); покажет ли UI bonk.fun токен без vanity-суффикса `…bonk`, не подтверждено | SOL; USD1 (GlobalConfig `EPiZbn…UPxBz` есть) | on-chain `creatorFeeRate=0`, награды деплоерам платятся off-chain (rewards.bonk.fun), получатель не подтверждён | см. LaunchLab | входит в LaunchLab | **делать в составе LaunchLab** |
| **Bags** | Meteora DBC `dbcij3…aqN` + Bags Fee Share V2 `FEE2tBhCKAt7shrod19QttSVREUYPiyMzoku1mL1gqVK` | только через их API: ключ по подписи кошелька (agent auth), **Twitter не обязателен**; mint генерирует сервер Bags | SOL; прочие quote — список, одобренный админом Bags (xStocks, Ondo), без ключа не проверить | creator = payer, **должен подписать** → свежий creator нужно пополнять SOL; деплоер получает 25% пула claimers | **нет** | 1,5–2 дня, только mainnet | **делать с оговоркой** (после LaunchLab) |
| **Anoncoin** | Meteora DBC → DAMM v2 (по докам; config key не проверял) | **нет**: create API «Coming Soon», вход только через X, кошелёк кастодиальный (Privy), не больше 3 монет в день на X-аккаунт | SOL | до graduation 0%, после — около 0,69% | нет | 0 (торговля через Jupiter) | **не делать create**; buy/sell — через Jupiter |
| **Surge** | своей Solana-программы нет; 16 PlatformConfig LaunchLab с именами «Surge», последняя активность — январь–апрель 2026 | — | — | — | — | 0 | **не делать**: surge.xyz показывает «Coming soon» |

---

## 1. pump.fun: какие quote поддерживает create

### Факты (on-chain, 13.10)
Документация `create_v2` в IDL 4.0.0 (`node_modules/@pump-fun/pump-sdk/src/idl/pump.json:5272`): «Remaining accounts select the quote mint (none = SOL)». Допустимы:
1. SOL;
2. mint-ы, внесённые в whitelist `Global`;
3. mint-ы из PDA `QuoteControl`;
4. **pump-коин как quote** («вложенные» кривые, `depth = Q.depth + 1 ≤ Global.max_curve_depth`).

Живой `fetchSupportedQuoteMints()` вернул:

| Сеть | SOL | Global | QuoteControl | `maxCurveDepth` | `creatorFeeConfigurable` / max bps |
|---|---|---|---|---|---|
| mainnet | да (ivqr 30 SOL) | **USDC** `EPjF…Dt1v` (ivqr 4292 USDC) | **205 mint-ов**: **ZEC `A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS`** (ivqr 2,7189 ZEC), BONK `DezX…B263`, PUMP `pumpCm…Dfn`, STONK `6GmAF…UNgx`, около 60 xStocks (`Xs…`), метки tokenized-акций, WIF и др. | 1 | true / **300** |
| devnet | да (ivqr 1 SOL) | devnet-USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | нет | 1 | false / 0 |

- **USD1 (`USD1ttGY…EmuB`) у pump.fun нет**, JUP и USDT тоже нет. Вторичные источники пишут про запуск «Custom Pairs» 09.09.2026 (Bankless, EdgeX). Официальный пост не нашёл.
- Пары к ZEC и USDC реально торгуются. Пример — транзакции через buyback-ATA pump.fun для ZEC (`5bp5CH…4V1Z`) и USDC (`6oCkp6…TNE`) за последние минуты.
- **Jupiter маршрутизирует USDC-кривые pump.fun** (живая котировка SOL→`7qC3…pump`: `Byreal SOL→USDC` + `Pump.fun USDC→coin`, один tx). По ZEC-коину pump.fun удалось проверить только уже мигрировавший (`BZFY…B96W`, маршрут DLMM).
- Creator fee для quote из QuoteControl (а ZEC — именно такой) **задаёт создатель**: `creator_fee_bps` в диапазоне `1..=300` (живое `max_configurable_creator_fee_bps = 300`). Для SOL и USDC аргумент игнорируется, действует расписание `FeeConfig`. Вторичные источники пишут «0,05–1%»; on-chain разрешено до 3%. Для quote из QuoteControl запрещён `is_mayhem_mode`.
- Comission и creator fee начисляются **в quote-токене** (ATA creator vault в этом mint). Сбор: `sweep_creator_fee` + `collect_creator_fee*`, по-прежнему permissionless. В README прямо сказано: для pump-коинов как quote нужно передавать `extraQuoteMints`.
- CU: token-quoted create и первый buy тяжёлые, «roughly 200–240k CU each». README советует ~500k на create + buy.

### Текущий код
`adapters/src/pumpfun.ts:630-632` явно отклоняет всё, что не SOL:
```ts
if (!isLegacyQuoteMint(normalizeQuoteMint(bondingCurve.quoteMint))) {
  throw new AdapterError("bad_request", "only SOL-quoted pump.fun curves are supported");
}
```
`pumpfun.ts:855` жёстко прописывает `quoteMint: NATIVE_MINT` в create. Интерфейс `adapters/src/types.ts` (`lamportsIn`, `solAmount`, `priceSol`) и `Venue` в `docs/API.md:138` рассчитаны только на SOL.

### Вердикт: **делать, начиная с ZEC**
Это лучший ход для судей ZECATHON: «мемкоин в паре к ZEC, купленный из shielded ZEC». Цена покупки выражена в той же валюте, что и баланс. Курсового риска пула нет, второго свопа нет.

---

## 2. Как устроены пары не к SOL (общая механика для pump.fun / LaunchLab / DBC)

| Вопрос | Ответ |
|---|---|
| Quote mint | Фиксируется при create: pump.fun — `remaining accounts` у `create_v2`; LaunchLab — через выбранный `GlobalConfig` (`getPdaLaunchpadConfigId(program, quoteMint, curveType, index)`); DBC — `quoteMint` в нашем config. Сменить его потом нельзя |
| ATA | У vault нужна ATA quote-токена (SPL Token для USDC, ZEC SPL, USD1; Token-2022 для части xStocks). Это **разовая рента ~0,002 SOL на vault на каждый quote**. Для pump.fun quote-ATA создают и кривая, и creator vault, и buyback (builder-ы v3 создают их идемпотентно) |
| Где vault берёт quote | **(A) Запас quote на vault** (рекомендую): пул держит остаток ZEC SPL или USDC, пополняет его пачками по расписанию, перед сделкой своп не делается. **(B) Своп SOL→quote в той же tx** (Jupiter `swap-instructions` + buy): атомарно, но tx больше (нужна ALT, она уже есть, `adapters/src/alt.ts`), +150–250k CU, ещё одна комиссия пула и price impact, а сумма в quote заранее неизвестна, значит слиппедж нужно считать по двум ногам. **(C) Отдельная tx свопа перед покупкой** — **не делать**: две связанные по времени tx с одного vault дают новый отпечаток |
| Курс для котировки в ZEC | SOL-пары: ZEC/SOL (как сейчас). USDC/USD1: ZEC/USD (1Click `/v0/tokens` или Pyth), стейблкоин ≈ 1. **ZEC SPL: 1:1** за вычетом стоимости пополнения (1Click 13.10: 0,5 ZEC → 0,49999166 ZEC SPL, `withdrawFee` 834 зат, около 452 с). Ликвидность ZEC SPL на Solana: ~$4,8 млн, 1 SOL→ZEC через Jupiter — impact 0,08% |
| Покупки через Jupiter (уже существующие токены) | Jupiter сам строит SOL→quote→coin в одной tx (проверено для USDC-кривой pump.fun). Отдельный своп не нужен. Но **ZEC-кривые LaunchLab Jupiter вернул как «not tradable»** (2 из 2 проверенных; похоже на флаг спама, а не на отсутствие поддержки). Для LaunchLab-пар не к SOL нужен прямой адаптер |
| Что это даёт приватности | **Нейтрально или в плюс.** Вариант (A): пополнение запаса идёт пачками и не связано с конкретными депозитами по времени. ZEC SPL пополняется прямо из Zcash через 1Click, то есть **без SOL-ноги**. Но t-адрес на стороне Zcash остаётся (тот же риск, что у ребаланса в `solana-launchpads.md` §6): лоты фиксированные. Минус: малый набор анонимности — если пары к ZEC запускает один-два пользователя Unzeen, сам выбор пары сужает круг. Это ~low, ведь адрес все равно vault |
| Что это даёт стоимости | (A): одна рента ATA на vault и quote плюс около 0,002% на пополнение ZEC через 1Click против ~0,13% на ZEC→SOL. Выходит **дешевле SOL-пар**. (B): +1 hop (обычно 0,01–0,3%) и CU |
| Единый fee-профиль | Token-quoted tx требуют больше CU. По ARCHITECTURE priority fee квантован, но **compute-unit limit должен быть единым на класс tx**, иначе по CU limit видно тип пары (low, см. находки) |
| Вывод выручки | sell возвращает quote-токен на vault → реестр зачисляет ZEC по курсу (у ZEC SPL 1:1). Creator fees копятся в quote-токене и собираются в тот же запас |

---

## 3. stonk.fun

- **Программа:** Raydium LaunchLab `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`, graduation в CPMM `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`. Старые «прямые» запуски шли в CLMM (Bitquery). Официальные PlatformConfig (decoded on-chain, `claimWallet = 5CEbueQnq1Ym2uSSx2xXds3jQAqT1BDnkA59RZobSPAG`):
  - `4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7` — стандарт; `feeRate` 1%, `creatorFeeRate 0`, `platformScale 100%`, `restrictGlobalConfig 0`, **`restrictCurveParam 1`**;
  - `6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt` — reward-запуски (Token-2022 transfer fee 1–3%), те же параметры.
- **Поправка к `solana-launchpads.md` §3.** Там сказано, что «пулы создаёт кошелёк оператора, сторонне создать нельзя». Для **запусков на кривой это неверно**. Две create-транзакции 13.10 (`eLczvNP7…` в 07:47 UTC и `2oFMCkre…` в 06:50 UTC) подписаны только кошельком пользователя и mint-keypair: `InitializeWithToken2022`, платформа `4E876q…`. Кошельки-создатели — обычные трейдеры (торгуют pump.fun-коинами). Оператор подписывал только старые CLMM-«direct» запуски.
- **Quote:** создатель выбирает актив. Платформа принимает любой GlobalConfig LaunchLab (`restrictGlobalConfig 0`). On-chain их около 600, включая ZEC (`E2fd24QycuwszEK8WyU8CgtCfp5bUkTMenUthzgShJxA`, >10 000 tx за 10,5 ч — похоже на ботов), USDC (`8gj14w…xiRw`), USD1 (`EPiZbn…UPxBz`), BONK (`7G6Gg6…hVtA`). Публичный API Raydium (`launch-mint-v1.raydium.io/main/configs`) показывает только SOL, USD1 и «Anon» — **список надо брать из цепочки**.
- **`restrictCurveParam = 1`:** параметры кривой обязаны пройти `PlatformCurveRule` для выбранного config. Порог graduation stonk.fun пересчитывает из фиксированной суммы в $ на момент запуска. Точные правила **не проверял**: читать аккаунт `PlatformCurveRule` (`getPdaPlatformCurveRule`) и подбирать `totalFundRaisingB` под него.
- **Creator fee:** нулевой и на кривой, и после graduation (LP заблокирован на платформу). Для Unzeen claim здесь не нужен.
- **Раскрывает:** `payer` (vault), `creator` (не подписант, может быть свежим), mint, platform, quote. Требований KYC или соцсетей на уровне программы нет. Комиссию за запуск в UI stonk.fun берёт фронт. Если создавать напрямую через программу, её нет. **Покажет ли сайт stonk.fun такой токен — не подтверждено** (Bitquery и боты индексируют по platform config, так что вероятно покажет).
- **Риск:** по имени платформы ориентироваться нельзя — в LaunchLab **десятки PlatformConfig с именем «StonkFun»** (имя задаёт кто угодно). Захардкодить проверенные ID.
- **Вердикт: делать в составе LaunchLab-адаптера** (это просто константа `platformId`). Пара к ZEC здесь тоже доступна.

## 4. LetsBonk / bonk.fun

- **Программа:** Raydium LaunchLab. Основная платформа — `FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1` (Bitquery: «the LetsBonk.fun Platform address»; on-chain активна, 1000 tx за 3 ч 13.10). Decoded: `feeRate 1,25%`, `creatorFeeRate 0`, `burnScale 99,9999%`, `restrictGlobalConfig 0`, `restrictCurveParam 0`. Вторая с тем же claimWallet — `4xR4cD…8nPT`, последняя активность 23.09.
- **Сторонний create:** по программе разрешён (ни allow-list, ни curve-rules). Две оговорки: (1) токены bonk.fun по традиции получают vanity-адрес `…bonk`. Попадёт ли в UI bonk.fun токен без суффикса, **не подтверждено**; суффикс из 4 символов перебирается за секунды–минуты. (2) Официального API или SDK для запуска у bonk.fun нет: используем `@raydium-io/raydium-sdk-v2` или собственный сборщик инструкций.
- **Quote:** SOL и **USD1** («Project Wings» с WLFI, crypto.news). GlobalConfig USD1 на mainnet существует (`EPiZbn…`), активность по нему низкая. Порог graduation USD1 «обычно 12 500 USD1» — данные вторичные, **не подтверждено**.
- **Creator fee:** on-chain `creatorFeeRate = 0`. Награды деплоерам начисляются раз в сутки в USD1/SOL off-chain (rewards.bonk.fun, «the more tokens you bond…»). **Кому именно платят — payer или creator — не подтверждено.** Если payer, награда уйдёт на vault, а не на свежий creator. Для приватности это не утечка, но привязать её к запуску из реестра будет сложнее.
- **Вердикт: делать в составе LaunchLab** (SOL сразу, USD1 вторым шагом — пул обязан держать запас USD1. 1Click USD1 на Solana поддерживает: `nep141:sol-0x9364…omdep.near`).

### Общий адаптер Raydium LaunchLab (для stonk.fun + bonk.fun + любой платформы)
- SDK `@raydium-io/raydium-sdk-v2` **0.2.74-alpha** (08.10.2026, alpha; в доке Raydium предупреждение, что интерфейс кривой меняется между минорными версиями) → **пинить точно**. Можно не тащить весь SDK: перенести 4 сборщика из `src/raydium/launchpad/instrument.ts` (`initializeWithToken2022`/`initializeV2`, `buyExactInInstruction`, `sellExactInInstruction`, `claimCreatorFee`) и математику `Curve.buyExactIn/sellExactIn`. Это библиотечный код с MIT-лицензией, правилам хакатона не противоречит; в README указать источник.
- **Devnet есть:** программа `DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6`, GlobalConfig SOL (`7ZR4zD…`, `DQe2B8…`) и devnet-USDC `USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT`. **Это не тот devnet-USDC, что у pump.fun** (`4zMMC9…`). Платформ stonk/bonk на devnet нет: для тестов создать свою (`createPlatformConfig`, одна на кошелёк).
- `initialize*`: `payer` подписывает, **`creator` — не подписант** (`instrument.ts:83-84`), так что свежий creator можно не пополнять, как и на pump.fun.
- `claimCreatorFee`: **creator обязан подписать** (`instrument.ts:1039`). Fee vault ведётся **по паре creator + quote mint и общий для всех запусков creator-а** (docs Raydium «per-creator, per-quote-mint vault»). Значит, переиспользование creator склеивает запуски в один vault. На stonk и bonk ставка 0, но на других платформах она есть.
- Jupiter знает метку «Raydium Launchlab» для SOL-кривых. Для quote не к SOL на него не полагаться (см. §2).
- **Трудозатраты:** 2–3 дня на backend (create/buy/sell/quote/status, парсинг события сделки, claim), +0,3 дня на каждую платформу, +0,5 дня на quote не к SOL поверх общей механики §2.

## 5. Bags

- **Программы** (docs.bags.fm/principles/program-ids): Meteora DBC `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`, DAMM v2 `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`, Bags Fee Share V2 `FEE2tBhCKAt7shrod19QttSVREUYPiyMzoku1mL1gqVK` (V1 `FEEhPb…ywi` — legacy). LUT `Eq1EVs15EAWww1YtPTtWPzJRLPJoS6VYP9oW9SbNr3yp`. Все ID — **только mainnet-beta**, про devnet в документации ни слова.
- **Доступ:** REST `https://public-api-v2.bags.fm/api/v1/`, заголовок `x-api-key`, лимит 5000 запросов в час на пользователя и IP. Ключ можно получить через dev.bags.fm или **через agent auth: подпись challenge ed25519-ключом кошелька** (`POST /agent/v2/auth/init` → `/callback`), возможна MFA. **Привязка к X/Twitter для ключа и для запуска не нужна**: «When launching your token via API, you can choose any wallet address… your token page will display only the wallet address». SDK `@bagsfm/bags-sdk` 1.4.4 (23.08.2026, MIT).
- **Поток:** `create-token-info` (загрузка картинки и метаданных; **mint генерирует сервер Bags**) → fee-share config (обязателен с v2; claimers — по соцсети или кошельку, без claimers creator получает 10 000 bps) → `create-launch-transaction` (tx **уже подписан mint-ом на стороне Bags**) → подпись launch-кошельком → отправка.
- **Creator:** launch-кошелёк = payer config = creator. **Он обязан подписать и заплатить**, то есть свежий creator нужно пополнять SOL. С сентября 2026 payer дополнительно получает «deployer share» — 25% пула claimers (`/fee-share/deployer/*`). Claim-транзакции частично подписаны спонсором Bags («sponsor pays fee, owner co-signs»).
- **Quote:** по умолчанию SOL. «Custom quote» на DBC или DAMM v2 — только mint-ы, которые «must first be saved by a Bags administrator» (xStocks, Ondo). Список отдаёт `GET /token-launch/supported-quote-tokens?flow=dbc`, нужен ключ. **ZEC и USDC в нём не проверены** (ключ не заводил, чтобы не создавать аккаунт без решения лида).
- **Что видит Bags (приватность):** IP сервера и API-ключ Unzeen, метаданные и **время каждого запуска до публикации**, адрес mint. Для пользователя утечки нет: запросы идут с сервера, а анонимный ключ пользователя Bags не видит. Но Bags оказывается доверенной стороной, которая видит все запуски Unzeen под одним ключом. On-chain их и так склеивает пополнение creator-ов из пула.
- **buy/sell:** напрямую через DBC-пул или Jupiter. Trade API Bags добавляет «Bags treasury fee transfer» — **не использовать**. Наш `adapters/src/meteora.ts:433` выводит пул только из **нашего** config (`deriveDbcPoolAddress(NATIVE_MINT, mint, this.configAddress)`), поэтому пулы Bags и Anoncoin он не видит. Обобщение — поиск пула по base mint — около 0,5 дня; либо через Jupiter.
- **Трудозатраты:** 1,5–2 дня (HTTP-клиент, пополнение creator, claim через их API). Тестировать только на mainnet.
- **Вердикт: делать с оговоркой** — после LaunchLab, только SOL-пары. Демо только на mainnet, адаптер помечен как «через API третьей стороны».

## 6. Anoncoin

- **Программа:** по документации — кривая Meteora (DBC) с graduation в DAMM v2 при 420 SOL (до 21.03.2026 — 500 SOL). Config key и program ID в доках не указаны, **не проверял**. Платформенный токен — `D25bi7oHQjqkVrzbfuM6k2gzVNHTSpBLhtakDCzCCDUB`. PlatformConfig LaunchLab «anoncoin» (`E9WEBD…RYtuw`) почти неактивен, его принадлежность не подтверждена.
- **Create сторонним сервисом — нет.** `POST /services/v2/create-coin-tx` — «🚧 Coming Soon — This endpoint is not yet live». Ключ API выдаётся только залогиненному пользователю, а вход «only via X (Twitter)». Кошелёк кастодиальный (Privy, лимиты на вывод). Не больше 3 монет в сутки, «tied to your X account's follower count». На странице монеты видны число подписчиков и теги «Followed by» — **деанонимизирующий канал по замыслу продукта**.
- **Quote:** SOL. **Creator fee:** до graduation 0%, после — ~0,69% (динамически снижается).
- **Приватность для Unzeen:** все запуски Unzeen шли бы с одного X-аккаунта и одного кастодиального кошелька Anoncoin. Anoncoin видит всё, а по подписчикам связывает запуски между собой. Это противоречит модели (свежий creator на каждый запуск).
- **Вердикт: create не делать.** Купить или продать токены Anoncoin можно через Jupiter (DBC/DAMM v2 он маршрутизирует). Отдельного кода не нужно.

## 7. Surge

- surge.xyz и app.surge.xyz 13.10 отдают «Coming soon | SURGE». Описание — «AI Native Protocol… web3 liquidity», мультичейн ICM-лаунчпад (BSC, Base, Solana), публичный запуск был 10.01.2026 (вторичный источник).
- В LaunchLab 16 PlatformConfig с именами «Surge», «SURGE», «surge.xyz» (например, `285bzH…Fc43`, `Dm1VpW…YRLw`, `CrKhcU…YRww`). Последняя активность — 19.01–07.04.2026, потом ничего. Какой из них официальный, не подтверждено.
- Публичных доков, API и SDK не нашёл.
- **Вердикт: не делать.** Если продукт оживёт, это всё равно LaunchLab и подключится константой `platformId`.

---

## Находки по серьёзности

**high**
1. `adapters/src/pumpfun.ts:630-632`, `:855` — адаптер жёстко ограничен SOL-quote. Чтобы запускать пары к ZEC и USDC, нужно параметризовать quote mint и quote token program (их отдают `fetchBuyState`/`resolveQuoteMint`) и передавать `quoteMint` в create. Сначала меняется контракт: `docs/API.md:138` (`Venue`) и `adapters/src/types.ts` (`lamportsIn` → `quoteIn` + `quoteMint`, `priceSol` → `priceQuote` + `quoteMint`).
2. Приватность, LaunchLab: creator fee vault ведётся **по паре creator + quote mint и общий для всех запусков creator-а**. Повторный creator склеивает запуски одного пользователя в одном vault. Исправление: свежий HD-creator на каждый запуск, как на pump.fun (`CreateOptions.creatorIndex`), и тест, что индекс не переиспользуется.
3. Приватность, Bags: creator обязан подписать и заплатить. Пополнять его нельзя с vault, который потом покупает этот же токен (иначе vault ↔ creator ↔ запуск, а через первую покупку ещё и сумма). Исправление: отдельный ключ-«фондер» пула, круглые фиксированные суммы, пополнение заранее пачкой, а не в момент запуска.
4. `solana-launchpads.md` §3 устарел: stonk.fun **не** требует оператора для запусков на кривой (см. §3 выше). Рекомендацию «убрать stonk.fun из скоупа» пересмотреть.

**medium**
5. Имена платформ LaunchLab задаёт кто угодно: десятки фейковых «StonkFun», «letsbonk.fun», «SURGE». Исправление: захардкодить проверенные `platformId` (`4E876q…`, `6BwHHD…`, `FfYek5…`) и сверять `claimWallet` при старте.
6. Devnet-USDC у pump.fun (`4zMMC9…`) и у Raydium (`USDCoct…`) — **разные mint-ы**. Конфиг quote должен быть отдельным для каждой площадки и сети, а не одной переменной `USDC_MINT`.
7. ZEC-кривые LaunchLab Jupiter отдаёт как «not tradable». Для LaunchLab-пар не к SOL нельзя рассчитывать на Jupiter как на путь buy/sell — нужен прямой адаптер.
8. `adapters/src/meteora.ts:433` выводит пул только из своего config, поэтому токены Bags и Anoncoin (чужой DBC config) им не торгуются. Исправление: искать пул по base mint (`getProgramAccounts` с memcmp или из события создания) либо отдавать в Jupiter.
9. Пары к ZEC: эмитент ZEC SPL (`A7bd…`, mint authority `FvULawNPGBbuwYus74ECaQoV1oH9Tk6XPN7VPN51NYds`) **не установлен**. Jupiter помечает его как verified, 1Click поддерживает как `1cs_v1:sol:spl:A7bd…`, 133 тыс. холдеров. Это мостовой актив с риском эмитента. В Verify резерв в ZEC SPL учитывать отдельной строкой.

**low**
10. Единый fee-профиль: token-quoted tx требуют ~200–240k CU на ногу. Если CU limit выставлять по факту, он раскроет тип пары или операции. Исправление: фиксированный CU limit на класс операции (например, 500k для create, 300k для buy/sell) на всех парах.
11. bonk.fun: vanity-суффикс `…bonk` и получатель off-chain наград не подтверждены. Перед обещанием «видно на bonk.fun» сделать один mainnet-запуск.
12. pump.fun на devnet: QuoteControl пуст, ZEC-пары тестируются **только на mainnet**. На devnet проверять USDC-пару (`4zMMC9…`) как суррогат для кода token-quote.

---

## Рекомендация (с учётом «ничего не урезаем»)

Порядок работ backend (дни — оценка для одного агента):
1. **pump.fun, пары к ZEC (+ USDC):** 2–3 дня (адаптер 1; creator fee в quote 0,5; запас quote на vault и пополнение ZEC SPL через 1Click 0,5–1; ledger и курсы 0,5). Frontend: выбор пары в форме запуска, отображение «/ZEC» в ленте — 0,5 дня. **Это главный козырь для судей**: «Zcash-paired memecoins, bought with shielded ZEC».
2. **Raydium LaunchLab: bonk.fun + stonk.fun:** 2–3 дня + 0,3 дня на платформу. Сначала SOL, потом ZEC и USD1 через общую механику §2. Devnet есть.
3. **Bags (SOL, mainnet):** 1,5–2 дня. Сначала получить ключ через agent auth (решение лида, см. вопрос 2).
4. **Anoncoin, Surge:** create не делать. Их токены торгуются через Jupiter, в README — «любой токен, который маршрутизирует Jupiter».

Изменения контракта (сначала в `docs/API.md`):
- `Venue` += `"launchlab"` с полем `platform: "bonkfun" | "stonkfun"`, += `"bags"`.
- `quoteMint` / `quoteSymbol` в `TokenSummary`, `Trade`, `CreateRequest`.
- Суммы сделок — в единицах quote с `quoteDecimals`, а не в lamports.
- `PoolInfo.quotes[]`: доступные quote для каждой площадки и сети и курс к ZEC.

Если сроки всё же поджимают: ZEC-пары на pump.fun не резать (самая дешёвая и сильная фича); первым кандидатом на перенос будет Bags (только mainnet, сторонний API).

---

## Открытые вопросы для лида
1. Пары к ZEC через ZEC SPL `A7bd…`: принимаем мостовой актив с неустановленным эмитентом как quote и как часть резерва (Verify)? Альтернатива — только USDC, но тогда теряется нарратив.
2. Заводить API-ключ Bags через agent auth (подпись ключом пула)? Без ключа нельзя проверить список custom quote и сделать сквозной тест.
3. Какой вариант снабжения quote выбираем: запас на vault (A, рекомендую) или своп в той же tx (B)? От этого зависят relayer и ребаланс.
4. Нужно ли, чтобы токены Unzeen показывались в UI bonk.fun и stonk.fun? Если да, нужен один mainnet-запуск для проверки (бюджет ~0,05 SOL) и, возможно, vanity-суффикс `bonk`.
5. Ставка creator fee для пар к ZEC на pump.fun (1…300 bps, задаётся при create): даём выбор пользователю или фиксируем одну на всех запусках, чтобы ставка не стала отпечатком создателя? Рекомендую фиксированную.

---

## Источники (проверено 2026-10-13)
- `@pump-fun/pump-sdk@4.0.0`: `src/idl/pump.json` (create_v2, строки 5272–5313), README («Quote mints», «Updates») — локально в `adapters/node_modules`; живые `OnlinePumpSdk.fetchSupportedQuoteMints/fetchGlobal/fetchQuoteControl` на `api.mainnet-beta.solana.com` и `api.devnet.solana.com`
- `@raydium-io/raydium-sdk-v2@0.2.74-alpha` (npm pack): `src/raydium/launchpad/{instrument,layout,pda}.ts`, `src/common/programId.ts`, `src/api/url.ts`
- On-chain `getProgramAccounts` по `LanMV9…` (GlobalConfig dataSize 371, PlatformConfig dataSize 944); `getSignaturesForAddress`/`getTransaction` по `4E876q…`, `FfYek5…`, `EPiZbn…`, `E2fd24…`, buyback-ATA pump.fun
- https://launch-mint-v1.raydium.io/main/configs , https://launch-mint-v1-devnet.raydium.io/main/configs
- https://docs.raydium.io/products/launchlab/code-demos.md , https://docs.raydium.io/products/launchlab/creator-fees , https://docs.raydium.io/products/launchlab/platforms , https://docs.raydium.io/raydium/launchlab/for-builders/launching-a-token
- https://docs.bitquery.io/docs/blockchain/Solana/stonkfun-api/ , https://docs.bitquery.io/docs/blockchain/Solana/letsbonk-api/
- https://github.com/chainstacklabs/pumpfun-bonkfun-bot
- https://docs.bags.fm/llms.txt , …/how-to-guides/launch-token , …/how-to-guides/launch-token-non-sol-quote , …/principles/program-ids.md , …/principles/rate-limits.md , …/faq/how-to-get-api-key.md , …/faq/linking-wallets.md , …/how-to-guides/agent-authentication.md , …/changelog/changelog ; npm `@bagsfm/bags-sdk@1.4.4`
- https://docs.anoncoin.it/llms.txt , …/getting-started/x-signup-and-username.md , …/apis/api-key.md , …/apis/create-token.md , …/platform-mechanics/anonymous-creator.md , …/platform-mechanics/bonding-curve.md , …/platform-mechanics/fees.md
- https://surge.xyz , https://app.surge.xyz (оба «Coming soon»); https://ourcryptotalk.com/news/surge-platform-public-launch/ (вторичный)
- Jupiter: `https://lite-api.jup.ag/swap/v1/quote` (живые), `https://lite-api.jup.ag/tokens/v2/search`
- 1Click: `https://1click.chaindefuser.com/v0/tokens`, `POST /v0/quote` (dry, ZEC → `1cs_v1:sol:spl:A7bd…`)
- Вторичные: https://www.bankless.com/read/news/pump-fun-launches-custom-pairs-for-tokenized-stocks.md , https://pro.edgex.exchange/en-US/news/article/pumpfun-adds-tokenized-stocks-new-token-launches , https://crypto.news/bonk-fun-integrates-usd1-stablecoin-through-raydium/ , https://rewards.bonk.fun/ , https://cryptonews.com/news/bonkfun-slashes-creator-fees-zero-launchpad-war/
