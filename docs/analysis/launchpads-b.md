# Лаунчпады, часть B: Printr, Meteora DBC (quote ≠ SOL), Stoxes, Lesgo, meme.fun, Raydium LaunchLab + дизайн «пара не к SOL»

Автор: analyst. Проверено **12–13.10.2026**. Что проверял:
- RPC-запросы `getAccountInfo` и `getSignaturesForAddress` к `api.{mainnet-beta,devnet}.solana.com`, плюс выборка транзакций программ (лог-инструкции);
- исходники программы DBC на GitHub (`MeteoraAg/dynamic-bonding-curve`, main, последний коммит 09.09.2026);
- тарболы npm: `@meteora-ag/dynamic-bonding-curve-sdk@1.5.13` (уже в `adapters/`), `@raydium-io/raydium-sdk-v2@0.2.74-alpha`, `@printr/sdk@0.6.1`;
- IDL LaunchLab (`raydium-io/raydium-idl`), API Raydium `launch-mint-v1(-devnet).raydium.io`;
- фронтенд-бандлы stoxes.fun и meme.fun, где не нашлось документации;
- Jupiter `/swap/v1/program-id-to-label`.

Всё, что не подтверждено первоисточником, помечено **«не подтверждено»**.

---

## TL;DR

**Вывод.** Больше площадок и пары не к SOL проще всего получить без новых чужих программ. Нужно обобщить наш DBC-адаптер на произвольный SPL quote (USDC, USD1) и добавить **один** новый адаптер: Raydium LaunchLab со **своей** platform config. Это открывает SOL и USD1 на mainnet, SOL и USDC на devnet. meme.fun дешёвый, но малоактивный: брать с оговоркой. Printr, Stoxes и Lesgo не стоят отдельного кода: торговлю их токенами в основном закрывает Jupiter, а сторонний create через них неприватен или невозможен.

| Площадка | Программа | Свой контракт? | Сторонний create/buy/sell | Devnet | Quote-токены | Creator: свежий адрес / сбор | Трудозатраты | Вердикт |
|---|---|---|---|---|---|---|---|---|
| **Meteora DBC, quote ≠ SOL** | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | наш config | да, permissionless (уже работает для SOL) | да (keeper миграции — только mainnet) | **любой SPL Token**; Token-2022 только без расширений (кроме metadata) и с нулевым transfer fee, иначе нужен token badge от оператора Meteora | да, `poolCreator` подписывает create, сбор — `claimCreatorTradingFee` (для не-SOL отдельный вариант) | **1,5–2,5 дня** | **делать** (USDC + USD1) |
| **Raydium LaunchLab** | `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj` (devnet `DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6`) | своя platform config, **permissionless** | да: SDK v2 (alpha) + IDL; `creator` в `initialize_v2` **не подписант** | **да**, программа + configs SOL/dUSDC | только quote из GlobalConfig Raydium: mainnet **WSOL, USD1** (+ закрытый «Anon»), devnet WSOL, dUSDC. Свой quote добавить нельзя | да; claim подписывает creator; vault fees по `[creator, quote_mint]` | **2,5–3,5 дня** | **делать** |
| **meme.fun** | `MEME4gfGe6itEpxgM1xaBVmiFF5XuCTc4oVXUE5w56F` (Anchor) | свой | да: публичный IDL и доки «program integration», без API-ключа; Jupiter маршрутизирует («MemeFun») | **да**, тот же program ID | только SOL (WSOL) | creator — **подписант и плательщик**, сбор `claim_creator_fees` | **1–1,5 дня** | **с оговоркой** (мало объёма, без миграции) |
| **Printr** | `T8HsGYv7sMk3kTnyaRqZrbRPuntYzdh12evXBkprint` (обёртка над DBC + LayerZero OFT) | свой + DBC | только через их HTTP API (`api-preview`), tx собирает Printr, creator подписывает | **нет** | на Solana, по данным интегратора, WSOL; другие не подтверждены | creator-ключ подписывает `/print` и claim | 2–3 дня + риски | **не делать** (торговля через Jupiter, не подтверждено) |
| **Stoxes (stoxes.fun)** | свои закрытые программы `G6pqD8zt…`, `56jNCsAp…`, `CDiyNb5y…` + LaunchLab | свой | нет SDK/доков/IDL, «Mainnet is gated» | нет | SOL, xStocks (Token-2022, issuer-controlled) | creator fees на X-хэндл (`StoxesFunHandleVault`) | — | **не делать** |
| **Lesgo (lesgo.fun)** | platform на LaunchLab + DBC с config на каждый запуск + своя burn-программа `H6Gdk44W…` | частично | API внутренний (`/api/launch/build`), загрузка требует подписи кошелька | не подтверждено | LaunchLab: SOL/USDC/акции; DBC: «любой SPL» | creator fees частично уходят в «holder pot» через их burn-программу | — | **не делать** отдельно, его техника = наши DBC + LaunchLab |

**Рекомендация (подробно в конце):**
1. DBC quote ≠ SOL (USDC, USD1).
2. Адаптер LaunchLab со своей platform config (SOL + USD1).
3. meme.fun — если останется день.

Printr, Stoxes и Lesgo не делать: «торгуются через Jupiter» писать в README только после живой котировки. Обязательное условие для пар не к SOL: **реестр остаётся в лампортах**. Своп SOL→quote делается в той же tx с одного vault, quote-«пыль» не хранится как позиция пользователя (см. «Дизайн quote ≠ SOL»).

---

## 1. Meteora DBC: quote-токены и расширение нашего адаптера

### Факты
| Что | Значение | Источник |
|---|---|---|
| Правило quote mint | `is_supported_quote_mint`: **любой mint программы SPL Token** проходит без условий. Token-2022 проходит, если это не native mint 2022, transfer fee = 0, а из расширений есть только `MetadataPointer` / `TokenMetadata`. Иначе нужен **token badge**, который создаёт **оператор Meteora** (`create_token_badge`, подписант — operator) | `programs/dynamic-bonding-curve/src/utils/token.rs:216-258`, `instructions/operator/ix_create_token_badge.rs` (GitHub main, 13.10) |
| То же в доках | «SPL Token quote mints are always accepted… Token 2022 quote mints with other extensions, such as Permanent Delegate, need a badge… Meteora operator-created». Badge не разрешает ненулевой transfer fee | docs.meteora.ag/core-products/dbc/token-2022-support.md |
| Проверка конкретных mint (RPC, 13.10) | USDC `EPjFWdd5…Dt1v` — SPL; USDT — SPL; **USD1 `USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB` — SPL**; JUP, BONK — SPL. PYUSD — Token-2022 с TransferFee/TransferHook/PermanentDelegate, badge **нет**. **xStocks** (TSLAx, AAPLx, NVDAx) — Token-2022 с PermanentDelegate, Pausable, TransferHook, ScaledUiAmount; **badge у DBC есть** | RPC + PDA `["token_badge", mint]` |
| Где задаётся quote | `quote_mint` — аккаунт `create_config`. **Один config = один quote mint.** Пул — PDA `(quote_mint, base_mint, config)` | `ix_create_config.rs:26`, SDK `deriveDbcPoolAddress(quoteMint, baseMint, config)` |
| Decimals quote | `tokenQuoteDecimal` в `buildCurveWithMarketCap` (у нас 9 для SOL) | SDK d.ts |
| Автомиграция (keepers, только mainnet) | SOL 10, **USDC 750**, **USD1 750**, JUP 1500, MET 1500, JupUSD 750, TRUMP 100, VIRTUAL 42 000. Stock Tokens — от 750 USD-эквивалента. Также любые Jupiter Verified токены с organic score > 50 и notional > 750 USD. Остальные — вручную через migrator.meteora.ag | docs.meteora.ag/core-products/dbc/migration-and-liquidity.md |
| Creator fee не в SOL | SDK: `ClaimCreatorTradingFeeWithQuoteMintNotSolParams` (fees приходят токеном quote на ATA получателя) | SDK d.ts:6247 |
| Живое подтверждение | Lesgo пишет, что запускает DBC с «Any token» (любой SPL) как quote, по config на запуск | lesgo.fun/docs |

### Что поменять в нашем адаптере (`adapters/src/meteora.ts`)
SOL зашит в нескольких местах:
- `meteora.ts:146` — `tokenQuoteDecimal: 9`;
- `:434` — `poolAddress()` выводит PDA от `NATIVE_MINT`;
- `:520` — `throw venue_unavailable` для не-SOL config;
- `:903` — `dbcPoolVaults()` с `NATIVE_MINT`;
- `:245` — `dbcPriceAndCap` возвращает `priceSol` / `marketCapSol` в единицах quote;
- `:254` — `dbcQuoteBuy(lamportsIn)`;
- `:637` — `requireSol(lamportsIn + …)`;
- `:668` — временный wSOL-аккаунт;
- `:727` — `lamportDelta` как «сумма сделки».

Минимальный план:
1. **Второй config на каждый quote** (`pnpm meteora:config --quote USDC|USD1`): та же форма кривой, но в quote-единицах. Например, старт ~3 000 USD и выпуск ~9 000 USD, тогда `migrationQuoteThreshold` (~9 000 USDC) больше 750 и keeper её мигрирует. `tokenQuoteDecimal: 6`. Адреса — `METEORA_DBC_CONFIG_<NET>_<QUOTE>`.
2. **Реестр mint → (venue, config, quote_mint)** в БД (`tokens`), а не `this.configAddress`. `poolAddress(mint)` берёт quote из реестра. Внешние DBC-пулы чужих config по-прежнему идут через Jupiter.
3. **Адаптер работает в quote-единицах, наружу отдаёт лампорты.** `TxResult.solAmount` = чистая дельта лампортов vault за всю tx (своп-нога + сделка, без ренты и network fee). Новые поля: `quoteMint`, `quoteAmount`. Подробности — в «Дизайн quote ≠ SOL».
4. `Quote`: оставить `priceSol` / `marketCapSol` (пересчёт через курс SOL/quote, см. ниже) и добавить `priceQuote`, `quoteMint`.
5. Creator fees для не-SOL пулов: `claim` → тут же своп quote→SOL в той же tx. Тогда `creator_claimable` остаётся в лампортах (ledger и Verify не трогаем).
6. Devnet: USDC от Circle на devnet для DBC — это просто SPL, но ликвидного пула SOL/USDC на devnet нет. Нужен свой devnet-mint `dUSDC` и свой пул DAMM v2 SOL/dUSDC (ликвидность наша) для своп-ноги. Mainnet-прогон — один раз.

**Не делать:** xStocks как quote, хотя badge у DBC есть.
- Эмитент может поставить mint на паузу или забрать токены через PermanentDelegate — как у нашего vault, так и у пула.
- ScaledUiAmount усложняет цену, TransferHook требует дополнительных аккаунтов.
- Условия xStocks исключают US-лиц: юридический риск для открытого демо.

**Трудозатраты:** 1,5–2,5 дня, включая скрипт config, реестр quote, своп-ногу, claim + своп, тесты на devnet со своим dUSDC.
**Вердикт: делать** (USDC и USD1; «любой SPL» — тот же код, но в UI не обещать).

---

## 2. Raydium LaunchLab (база stonk.fun, LetsBonk, Lesgo, Stoxes)

### Факты
| Что | Значение | Источник |
|---|---|---|
| Program ID | mainnet `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`, devnet `DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6` (executable, devnet-транзакции 13.10). Graduation → CPMM `CPMMoo8L…` (devnet `DRaycpLY…`) | docs.raydium.io/reference/program-addresses, RPC |
| Исходники | **Закрыты** («LaunchLab source is not publicly available»). IDL `raydium_launchpad.json` v0.2.0 в `raydium-io/raydium-idl` | там же, GitHub |
| SDK | `@raydium-io/raydium-sdk-v2` **0.2.74-alpha** (08.10.2026, единственный тег — alpha). Модуль `raydium.launchpad`: `createLaunchpad`, `buyToken`, `sellToken`, `buyTokenExactOut`, `sellTokenExactOut`, `createPlatformConfig`, `claimCreatorFee`, `claimMultipleCreatorFee`, `getRpcPoolInfo`; низкоуровневые `initializeV2`, `buyExactInInstruction`, `sellExactInInstruction`. web3.js v1 (совместимо с нашим стеком), тянет axios, lodash | npm tarball |
| Global config (quote) | Ключ — пара `(curve_type, index)`, **одна quote на config**. Создаёт **только админ Raydium или делегированная authority** (иначе `InvalidOwner`). **Свой quote добавить нельзя** | docs.raydium.io/products/launchlab/global-config.md |
| Существующие configs (API, 13.10) | mainnet: `6s1xP3hp…` **WSOL** (min fundraising 24 SOL, по умолчанию 85 SOL); `EPiZbnrT…` **USD1** (min 5 000, по умолчанию 12 500 USD1); `6xtK26kf…` «Anon» (только для платформ с авторизацией). devnet: `7ZR4zD7P…` и `DQe2B8w3…` dwSOL, `4wHbNkob…` **dUSDC** (`USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT`). USDC на mainnet в API **нет**. Пары stonk.fun/Lesgo/Stoxes с акциями — по-видимому, на configs с `requiresPlatformAuth`, в публичный список не попадают (не подтверждено) | `launch-mint-v1.raydium.io/main/configs`, `launch-mint-v1-devnet.raydium.io/main/configs` |
| Своя platform config | **Да, permissionless.** В IDL у `create_platform_config` единственный подписант — `platform_admin` (наш ключ), подписи Raydium нет. PDA `["platform_config", admin]` — одна платформа на admin-ключ. В API 21 платформа, включая мелкие (say.fun, DegenSafe, Wen.Dev), — подтверждает, что вход открыт | IDL, `…/main/platforms` |
| Параметры платформы | `fee_rate` ≤ 500 bps (лимит поднят 26.08.2026), `creator_fee_rate` ≤ 50 bps (до graduation). Доля LP после миграции `platform_scale + burn_scale = 1e6` (`creator_scale` = 0 для новых). `cpswap_config`, `restrict_curve_param`, `restrict_global_config`, имя/сайт/лого (on-chain, публично). Обновлять можно раз в эпоху | docs.raydium.io/products/launchlab/platform-config.md |
| create | `initialize_v2(base_mint_param, curve_param, vesting_param, amm_fee_on)`. Подписанты — **`payer` и `base_mint`**. **`creator` не подписант** («Recorded as pool_state.creator; not a signer»), как у pump.fun. Есть `initialize_with_token_2022`. Старый `initialize` всегда падает (`NotApproved`) | IDL, docs …/instructions |
| buy/sell | `buy_exact_in(amount_in, minimum_amount_out, share_fee_rate)`, `sell_exact_in(…)`, есть exact_out; подписант — `payer` (трейдер). Create + первая покупка — одной tx через SDK (`createLaunchpad` с `buyAmount`) | IDL, SDK |
| Creator fee | До graduation копится в `creator_fee_vault` = PDA **`[creator, quote_mint]`**: все запуски одного creator на одном quote — в одном vault. `claim_creator_fee` подписывает **creator**. После graduation fees CPMM уходят `platform_cp_creator` или `pool_creator` | docs …/accounts, IDL |
| Jupiter | Метка «Raydium Launchlab» есть: вторичка и выпуск через Jupiter | `program-id-to-label` |

### Можно ли запускать «под чужой платформой» (к части A: LetsBonk)
У платформ LetsBonk (`BuM6KDpW…`, `FfYek5vE…`, `8pCtbn9i…`) `restrictCurveParam = 0`. `initialize_v2` не требует подписи platform admin, если платформа не включила `restrict_global_config`. Значит, технически можно создать запуск с `platform_config` = LetsBonk, и он, вероятно, появится в их UI. **Не подтверждено**: показ в UI и наличие у них off-chain фильтра. Проверить можно бесплатно через `simulateTransaction` на mainnet. У StonkFun `restrictCurveParam = 1`, кривая ограничена их правилом.

### Приватность
- Platform config, `platform_fee_wallet` и имя платформы связывают **все** запуски Unzeen на LaunchLab друг с другом. Это та же модель, что у нашего DBC config, а не связь с пользователем. Имя/лого платформы публичны в API Raydium: до 28.10 назвать нейтрально или оставить пустым (правило CLAUDE.md «не публиковать детали архитектуры»).
- `creator` не подписывает create: ставим свежий HD-адрес, как в pump.fun. Fee vault `[creator, quote]` при свежем creator на запуск ничего не связывает. **Переиспользовать creator нельзя**: склеятся все запуски.
- Claim подписывает creator. Сборщик (`fee-sweeper`) должен клеймить пачками по расписанию, как уже сделано.

### Трудозатраты
2,5–3,5 дня:
- скрипт `launchlab:platform` (devnet + mainnet);
- адаптер create / buy / sell / quote / status через низкоуровневые инструкции SDK, с нашим `signTx` и ALT;
- парсинг событий (`TradeEvent` / `PoolCreateEvent` по IDL);
- `claim_creator_fee` в sweeper;
- миграции venue в БД;
- тесты на devnet (config dwSOL и dUSDC есть).

Риск: SDK alpha и закрытые исходники программы. Зафиксировать версию точно, ошибки классифицировать по IDL.
**Вердикт: делать.** Это единственный путь к USD1-парам на крупном лаунчпаде и аргумент «Raydium» в питче.

---

## 3. meme.fun

| Что | Значение | Источник |
|---|---|---|
| Что это | «Fair-launch memecoins on Solana». Своя Anchor-программа **`MEME4gfGe6itEpxgM1xaBVmiFF5XuCTc4oVXUE5w56F`**, mainnet и **devnet** (executable). **Без миграции**: «No instruction exists to create a pool… or migrate. The curve is the only venue». Двухуровневая комиссия: до 350 SOL ликвидности creator 0,98 %, протокол 0,20 %; выше — creator 0 %, протокол 0,05 %, LP 0,25 % | meme.fun/docs (бандл), RPC |
| Интеграция | Публичные доки «program integration» (`/docs/api`): «No API key, no REST gateway… Test on devnet against the same program ID». IDL — `anchor idl fetch`. Read API `GET /api/tokens`, `/api/tokens/:mint/price`, `/progress` | бандл `3xnlegnzc90m9.js` |
| Инструкции | `create_token(name, symbol, uri)`: подписанты — `mint`, `bonding_curve_token_account`, `sol_vault` (свежие keypair) и **`creator` («Payer. Recorded as the curve's creator and sole creator-fee recipient»)**. `buy(sol_amount, min_tokens_out)` и `sell(token_amount, min_sol_out)`: SOL-нога в **WSOL** (нужно заранее обернуть). Fees копятся в кривой, сбор — `claim_creator_fees` | IDL/доки в бандле |
| Quote | **Только SOL** (`wsol_mint` закреплён) | IDL |
| Mint | Token-2022, vanity-суффикс `…meme`, mint authority отозван | доки, `/api/tokens` |
| Jupiter | **Да, метка «MemeFun»**: buy/sell можно делать через нашего Jupiter-адаптера без кода | `program-id-to-label` |
| Активность | ~1000 транзакций программы за 09–13.10 (~250/день) — небольшая | RPC |

**Creator / приватность.** Creator обязан **подписать и заплатить** create. Схема: tx с fee payer = vault, сначала `SystemProgram.transfer(vault → свежий creator, rent + запас)`, затем `create_token` (+ `buy` от vault). Связь vault ↔ creator в одной tx такая же, как сейчас у DBC (там creator тоже подписывает). Остаток SOL на creator вернуть при claim. KYC и соцсетей нет (Twitter/Telegram опциональны в метаданных).

**Трудозатраты:** 1–1,5 дня (простой IDL, только SOL, торговля через Jupiter уже есть; create + buy и claim — новые).
**Вердикт: с оговоркой.** Дёшево и даёт «+1 площадка» с честной devnet-демкой. Но площадка новая, объём маленький, своп-пулов нет. Брать после DBC-quote и LaunchLab.

---

## 4. Printr

| Что | Значение | Источник |
|---|---|---|
| Что это | Омничейн-лаунчпад (12+ сетей, Solana — одна из них), токен — «telecoin» на LayerZero OFT | printr.gitbook.io/printr-docs |
| Solana program | `T8HsGYv7sMk3kTnyaRqZrbRPuntYzdh12evXBkprint` (адрес из «Contract Addresses»). Mainnet — executable, **devnet — нет**. «Printr does not publish copies of its Solana IDL» | docs `deployer-and-partner-integration.md`, RPC |
| Кривая на Solana | **Meteora DBC.** В выборке 41 tx программы Printr (13.10): 13 вызывают `dbcij3…` (`Swap`/`Swap2`), 7 — `ClaimDbcFees` + `ClaimCreatorTradingFee`; остальные — `TeleportWithLz` (LayerZero), staking. Graduation — DAMM v2 | RPC-выборка, доки |
| Активность | ~1000 вызовов программы с ~04.09 по 13.10 (~26/день) | RPC |
| Сторонний create | Только через API: `@printr/sdk` 0.6.1 (`buildToken` → `payload` → `signAndSubmitSvm`), base `https://api-preview.printr.money`, ключ необязателен (по умолчанию «public AI integration key»). Интегратор liqr: «calls Printr's /print endpoint… creator keypair signs the returned tx», **deploy fee ~0,06 SOL**. Торговля через публичный API «Currently not exposed» (FAQ) | SDK README, liqr.money/docs |
| Quote | По liqr — WSOL. Другие quote на Solana **не подтверждены** | liqr.money/docs |
| Creator fee | Пять моделей (creator, стейкеры, buyback, ликвидность, без fee). Claim подписывает creator (`claim_dbc_fees`, `distribute_telecoin_quote_fees`) | доки, liqr |
| Доступность API | `api-preview.printr.money` с нашего хоста 13.10 не отвечал (timeout) | curl |

**Приватность.** Метаданные, creator-адрес и параметры запуска уходят на сервер Printr **до** публикации on-chain. Printr видит IP сервера и момент запуска, может связать запуски одного оператора. Tx собирает третья сторона: перед подписью нужен allowlist инструкций, как у Jupiter. Это работа, а LayerZero-инструкции проверить сложно.

**Трудозатраты:** 2–3 дня + риски (нет devnet, preview-API, недоступность, закрытый IDL).
**Вердикт: не делать.** Пулы Printr — это DBC, поэтому их токены, вероятно, торгуются через Jupiter («Dynamic Bonding Curve»), но живой котировкой это **не проверено**. Наш DBC-адаптер даёт ту же кривую без посредника.

---

## 5. Stoxes (stoxes.fun)

| Что | Значение | Источник |
|---|---|---|
| Что это | Лаунчпад с «Floor Reserve»: каждый токен обеспечен выкупаемым резервом. Токен $STOXES `AfVUPhru…9999` запущен ~30.09.2026. Мультичейн (Solana + BSC, Robinhood Chain, X Layer) | x.com/stoxesfun, dropstab, бандл |
| Программы | Документации нет. В бандле: свои mainnet-программы `G6pqD8ztk5p7qEn5VR4Gqo2i5Kw8fA3b6EXS9QGd2qP3` (seeds config/reserve/maintenance/holder), `56jNCsApXtZp9nk5CmwJmenasMqJTg73XRP2qF5Vu13A` (curve/curve_sol), `CDiyNb5ya7P5BMyvzAYcy77t8uRcZNahzjnihKYrtyKD`. Все executable на mainnet, **на devnet нет**. Плюс LaunchLab + CPMM для пар с xStocks | бандл `index-BXBMhSvN.js`, RPC |
| Quote | SOL; xStocks (TSLAx, AMZNx, AAPLx, NVDAx…, `issuerControlled: true`); свой SPCX (Token-2022, pausable, permanent-delegate) | бандл |
| Статус | В тексте бандла: «This is experimental software… **Mainnet is gated**» | бандл |
| Creator fees | «без логина кошельком» — через `StoxesFunHandleVault`: fees привязаны к **X-хэндлу** | бандл, blockspot |
| Jupiter | Программ Stoxes в метках нет. Токены на LaunchLab маршрутизируются как «Raydium Launchlab», на своей кривой — нет | `program-id-to-label` |

**Приватность:** привязка fees к X-аккаунту прямо противоречит Unzeen. Активы, контролируемые эмитентом, могут заморозить или забрать.
**Вердикт: не делать.** Нет SDK, IDL и devnet, mainnet закрыт, исходники закрыты.

---

## 6. Lesgo (lesgo.fun)

| Что | Значение | Источник |
|---|---|---|
| Что это | Лаунчпад с токеном GO (`D1YZZg9d…`), 60 % выручки идёт на buyback + burn GO | lesgo.fun/docs, Phantom |
| Программы | **Своей кривой нет**: LaunchLab (Lesgo — platform config; ID в доках не указан, в публичном списке API Raydium под этим именем не найден) + Meteora DBC (**отдельный config на каждый запуск**, рента ~0,008 SOL платит creator) + своя burn-программа `H6Gdk44WWcA59Qtq9hmWuUv48oXox7y7KvEAtfbePm5S`. Graduation — Raydium CPMM / DAMM v2 | lesgo.fun/docs |
| Quote | LaunchLab: «SOL, USDC, tokenized stocks, pre-IPO tokens». DBC: «any plain SPL token», Token-2022 только без transfer fee | lesgo.fun/docs |
| Fees | LaunchLab: 1,25 % (Raydium 0,25 / платформа 0,5 / creator 0,5); Burn+Rewards — Token-2022 transfer fee 1–3 %. DBC: 2 %, claimer — их burn-программа | там же |
| Сторонний create | API внутренний: «not a general public API». `POST /api/upload` требует подписи кошельком (`lesgo:v1:mainnet:launch:<CA>:<ts>`), `/api/launch/build` возвращает неподписанные tx | там же |

**Вердикт: не делать.** Запуск «на Lesgo» = их сервер + подпись кошелька + их fee-логика (в Burn+Rewards creator fee идёт держателям). Технически Lesgo = DBC с произвольным quote + LaunchLab, то есть ровно пп. 1–2. Его токены торгуются через Jupiter (DBC/LaunchLab), не проверено живой котировкой.

---

## 7. Дизайн «запуск в паре к другому токену» (quote ≠ SOL)

### Исходные ограничения (ARCHITECTURE.md, текущий код)
- Пул держит SOL (ребаланс ZEC→SOL через 1Click), баланс пользователя — в ZEC. Курс ZEC↔лампорты считает core, `verify.rs` оценивает обязательства в лампортах.
- Одна позиция по mint лежит на одном vault (D4).
- У всех tx пула единый fee-профиль: один квантованный CU price и одинаковый tip.
- Jupiter запрашивается только при исполнении job, никогда ради котировки пользователю (`jupiter.ts`, блок «Privacy»).

### Решение: одна атомарная tx, реестр в лампортах

**Buy (и create с первой покупкой):**
```
tx (fee payer = vault, общий CU price/tip):
  1. своп SOL → QUOTE, ExactIn L лампортов, minOut = q_min   [нога A]
  2. DBC swap2 / LaunchLab buy_exact_in, amountIn = q_min, minOut = t_min   [нога B]
     (create: createPoolWithFirstBuy / createLaunchpad с buyAmount = q_min)
```
- Нога B тратит ровно гарантированный минимум ноги A, поэтому tx никогда не падает из-за нехватки quote.
- Излишек `q_actual − q_min` (≤ слиппеджа ноги A) остаётся на vault как **quote-пыль**.
- Вариант без пыли: нога A — **ExactOut** (ровно q USDC, SOL ≤ maxIn). Поддержка ExactOut зависит от пула ноги A, **проверить** на выбранном пуле.

**Sell:**
```
  1. sell_exact_in(tokens) → QUOTE, minOut = q_min    [нога B]
  2. своп QUOTE → SOL, ExactIn q_min, minOut = L_min   [нога A]
```
Пыль снова `q_actual − q_min`.

**Чем делать ногу A.** Не Jupiter, а **закреплённый пул SOL/USDC и SOL/USD1** (например, Meteora DAMM v2 или Raydium CLMM с глубокой ликвидностью), инструкции строим сами:
- котировку можно считать локально из состояния пула, которое и так читается на тике (warm set). Котировка для UI не идёт третьей стороне, правило Jupiter соблюдено;
- tx меньше и детерминирована (Jupiter-маршрут + DBC create рискуют не влезть в 1232 байта даже с ALT);
- на devnet работает свой пул SOL/dUSDC. Jupiter devnet не поддерживает.

Jupiter оставить для **вторички** чужих токенов с quote ≠ SOL: маршрут SOL→USDC→TOKEN он строит сам, одной tx.

**Учёт (ledger).**
- `TxResult.solAmount` = чистая дельта лампортов vault за всю tx (`lamportDelta + fee`, без ренты), то есть реальная цена в SOL с обеими ногами и их комиссиями. **Ledger, курс ZEC и Verify не меняются**: пользователь платит и получает лампорты, как сейчас.
- Новые поля только для ленты/UI: `quoteMint`, `quoteAmount` (из события площадки).
- Пыль принадлежит пулу, а не пользователю: потеря пользователя ≤ слиппедж ноги A, это показываем в котировке. Пыль собирается периодическим пакетным свопом QUOTE→SOL **по расписанию, не после сделок**.

### Влияние на «один vault на mint»
- **Не нарушается.** Обе ноги в одной tx того же vault, который держит позицию по mint. Quote-пыль — общий инвентарь vault, а не позиция по mint.
- Отказаться от варианта «отдельный quote-float на отдельном vault» (USDC пополняется заранее, покупка — с другого vault): две tx, два vault, гонки баланса и рост Verify, а приватности не прибавляется.
- Если tx не влезает (create + нога A), fallback — **две tx с того же vault** подряд (сначала своп, потом create). Атомарность теряется: при провале create USDC остаётся пылью и уходит в общий sweep.

### Курс и котировка в ZEC
```
quote(buy, zat) → lamports = zat × rate_buy (как сейчас)
               → q = poolA.quoteOut(lamports)  (локально, из прочитанного состояния пула)
               → tokens = venue.quoteBuy(q)
UI: «≈ X USDC ≈ Y токенов», цена токена: priceQuote; priceSol = priceQuote × (SOL/quote из пула A)
```
- Слиппедж двойной: `t_min` считаем от `q_min`, а не от ожидаемого q. В UI — одна итоговая «мин. токенов».
- `Quote.priceSol` / `marketCapSol` оставить (лента и сортировка в SOL), добавить `priceQuote`, `quote: {mint, symbol, decimals}`. **Сначала** изменение в `docs/API.md` (правило лида).

### Verify
- Обязательства не меняются: всё в лампортах/ZEC.
- Новые активы: quote-пыль (USDC, USD1) на vault. `verify-snapshot.ts` уже читает ATA всех mint пула. Достаточно добавить quote mint в список. В сумме активов пыль **не учитывать** (консервативно) или оценивать по курсу пула A с дисконтом; это нужно описать в README Verify.
- Creator fees в USDC: claim + своп в SOL одной tx, тогда `creator_claimable` остаётся в лампортах.
- Риск: у USDC и USD1 есть freeze authority (USD1 помечен Raydium как `hasFreeze`). Эмитент может заморозить ATA vault или quote-vault пула. Это low, но в модели доверия README стоит упомянуть.

### Приватность лишнего свопа
| Аспект | Оценка | Мера |
|---|---|---|
| Своп SOL→USDC рядом со сделкой | **low.** В одной tx это обычный маршрут «SOL→USDC→токен», как у любого агрегатора. Новой связи с пользователем нет: vault и так виден | одна tx; не выносить ногу A в отдельный сервис или кошелёк |
| Сумма ноги A = сумма покупки | **low.** Та же информация, что и сейчас (лампорты покупки видны) | округление сумм как сейчас; ExactOut на «круглые» USDC (50,00) ещё лучше |
| Fee-профиль | **medium**, если CU limit будет «уникальным» для quote-сделок | CU price и tip общие. `CU_TRADE_ROUTED` / `CU_CREATE_ROUTED` — фиксированные константы (как `meteora.ts:83-84`), без подгонки под симуляцию |
| Sweep пыли | **medium**, если swap пыли идёт сразу после сделки (тайминг склеивает сделки) | sweep по расписанию (раз в эпоху), пакетом по всем vault, порог по сумме |
| Котировки | **high**, если UI-котировку брать у Jupiter или 1Click per-user | только локальный расчёт из пула A, читаемого на тике для всех |
| Чужой API собирает tx (Printr, Lesgo) | **high** | не использовать (п. 4, 6) |

### Изменения по папкам (для лида: кому что)
- `docs/API.md` (лид → потом агенты): `Venue += "raydium-launchlab" | "memefun"`; `Token.quote`, `priceQuote`; `TradeEvent.quoteAmount`.
- `core/` (backend): миграция CHECK `venue` (`0002_relayer.sql:63,109,125`, `0008_fair_launch.sql:28,44`), колонки `tokens.quote_mint` / `config`. Курс SOL/quote **не нужен** в ledger, если адаптер отдаёт лампорты.
- `adapters/` (backend): обобщить `meteora.ts` (строки выше); `pool-a.ts` (закреплённый пул SOL/quote: чтение, котировка, инструкции); `launchlab.ts`; `memefun.ts`; sweeper (claim + своп, пыль). `types.ts`: `VenueId`, `TxResult.quoteMint/quoteAmount`, `Quote.priceQuote`.
- `web/` (frontend): выбор пары при запуске (SOL / USDC / USD1), отображение «за 50 USDC», предупреждение о двойном слиппедже.
- Fair-launch: v1 оставить **только SOL** (Jito-бандл + своп-нога + tlock — лишний риск к 28.10).

---

## Рекомендация

| # | Задача | Дни | Почему |
|---|---|---|---|
| 1 | DBC quote ≠ SOL: configs USDC + USD1, пул A, лампортовый учёт, claim + своп | 1,5–2,5 | Дешевле всего (адаптер уже есть). Пары к стейблам показывают, что «Launch anywhere» — не только SOL |
| 2 | LaunchLab-адаптер со своей platform config (SOL, USD1; devnet SOL/dUSDC) | 2,5–3,5 | Raydium в питче, USD1. Тот же адаптер позже даст пары к акциям, если Raydium откроет config (не наш контроль) |
| 3 | meme.fun create (+ Jupiter для торговли) | 1–1,5 | «+1 площадка» почти даром, но аудитория мала |
| — | Printr, Stoxes, Lesgo | 0 | Только строка в README «их токены торгуются через Jupiter», **после** живой котировки на mainnet |

**Судейский взгляд.**
- Сильная сторона — «одна приватная механика поверх нескольких рынков и пар». Убедительнее всего демо: create в паре к USDC на DBC и покупка того же токена через Jupiter, с подписью в ленте «unzeen купил … за 50 USDC».
- Пары к акциям (xStocks) впечатлили бы, но это compliance-риск и Token-2022 со свойствами, которые позволяют эмитенту забрать средства пула. Не брать.

**Порядок урезания** (дополнение к CLAUDE.md, если владелец согласится): meme.fun → LaunchLab USD1 (оставить SOL) → DBC USD1 (оставить USDC). Ядро и пары SOL не трогать.

---

## Открытые вопросы для лида
1. Подтвердить модель «реестр в лампортах, своп-нога в той же tx, пыль — пулу». Альтернатива — хранить баланс пользователя в quote, это сильно дороже: ledger, Verify, курс.
2. Какой пул A закрепить (DAMM v2 или CLMM SOL/USDC, SOL/USD1) и поддерживает ли он ExactOut. Задача backend: проверить на mainnet через `simulateTransaction`.
3. Имя и лого нашей LaunchLab platform config до 28.10: пусто/нейтрально или «Unzeen»? Оно публично в API Raydium.
4. Часть A: пробовать ли запуск под `platform_config` LetsBonk (технически permissionless, показ в UI не подтверждён). Проверка — `simulateTransaction` на mainnet, бесплатно.
5. Нужна ли живая котировка Jupiter по токенам Printr/Lesgo/meme.fun до того, как упоминать их в README? Рекомендую да: один ручной запрос с машины разработчика, не из релейера.
6. pump.fun: в pump-sdk 4.0.0 есть devnet USDC (`4zMMC9…DU`, см. `solana-launchpads.md`). Если pump.fun уже поддерживает пары к USDC, это дешевле LaunchLab USD1. Вопрос к части A.

## Источники (проверено 12–13.10.2026)
- Meteora DBC: https://github.com/MeteoraAg/dynamic-bonding-curve (`programs/dynamic-bonding-curve/src/utils/token.rs`, `instructions/partner/create_config/*`, `instructions/operator/ix_create_token_badge.rs`); https://docs.meteora.ag/core-products/dbc/token-2022-support.md; https://docs.meteora.ag/core-products/dbc/migration-and-liquidity.md; SDK `@meteora-ag/dynamic-bonding-curve-sdk@1.5.13` `dist/index.d.ts`
- Raydium LaunchLab: https://docs.raydium.io/reference/program-addresses ; https://docs.raydium.io/products/launchlab/global-config.md ; https://docs.raydium.io/products/launchlab/platform-config.md ; https://docs.raydium.io/products/launchlab/instructions ; https://docs.raydium.io/products/launchlab/accounts ; https://github.com/raydium-io/raydium-idl (`raydium_launchpad/raydium_launchpad.json`); https://launch-mint-v1.raydium.io/main/configs ; https://launch-mint-v1.raydium.io/main/platforms ; https://launch-mint-v1-devnet.raydium.io/main/configs ; npm `@raydium-io/raydium-sdk-v2@0.2.74-alpha`
- Printr: https://printr.gitbook.io/printr-docs (llms.txt, `for-developers/printr-sdk.md`, `for-developers/deployer-and-partner-integration.md`, `printr-v2-new-features/launch-profiles.md`); npm `@printr/sdk@0.6.1`; https://www.liqr.money/docs ; RPC-выборка tx программы `T8Hs…print`
- Stoxes: https://stoxes.fun (бандл `/assets/index-BXBMhSvN.js`); https://x.com/stoxesfun ; https://dropstab.com/coins/stoxes ; https://blockspot.io/coin/stoxes/
- Lesgo: https://www.lesgo.fun/launch ; https://www.lesgo.fun/docs ; https://phantom.com/tokens/solana/D1YZZg9dBZ7AbfknZVbaeVLto36eySwoFYEVhZrD4F4n
- meme.fun: https://meme.fun/docs , https://meme.fun/docs/api (бандлы `_next/static/chunks/22wvpra5ji6qx.js`, `3xnlegnzc90m9.js`), https://meme.fun/api/tokens
- Jupiter: https://lite-api.jup.ag/swap/v1/program-id-to-label
- RPC: `api.mainnet-beta.solana.com`, `api.devnet.solana.com` (`getAccountInfo`, `getSignaturesForAddress`, `getTransaction`, `getMultipleAccounts` для mint и token badge)
