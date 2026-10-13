# Robinhood Chain как вторая сеть Unzeen: ресёрч

Автор: analyst. Дата проверки всех фактов: **2026-10-13** (день 2), около 08:00–08:30 UTC. Только ресёрч, код проекта не трогал.
Методика: живые JSON-RPC запросы (`curl`, `cast`) к mainnet и testnet, верифицированные исходники с **Sourcify** (`sourcify.dev/server/v2/contract/4663/...`), dry-котировки 1Click, официальные доки Robinhood, Flap, Uniswap, Blockscout. Где утверждение взято из вторичного источника или не проверено, это помечено **[не подтверждено]**.
Правило: **любая утечка = дисквалификация**.

---

## TL;DR

1. **Сеть живая и подходит.** Robinhood Chain: Arbitrum Orbit (Nitro v3.12.1) L2 на Ethereum. Chain ID **4663** (testnet **46630**), газ в ETH. Блоки идут каждые **~0,1 с**, base fee **0,02 gwei**. Публичный mainnet открыт **01.07.2026** (слова владельца подтверждаются; генезис-блок от 30.04.2026). Секвенсер **FCFS**: публичного мемпула нет, Timeboost выключен (метод отсутствует), приоритетные комиссии не работают. Бандлов (аналога Jito) нет, но и не нужны: атомарность достигается одной транзакцией контракта.
2. **Лаунчпады есть, их много** (по данным Birdeye, 95 штук и 850k токенов за 92 дня). Для интеграции годятся два:
   - **Pons V2.** Лидер по объёму. Исходники верифицированы, контракты permissionless: `launchToken`, `launchAndBuy(..., recipient)`, `curve.buy(quoteIn, minOut, recipient)`, `curve.sell`. Получатель создательских комиссий (`creatorFeeRecipient`) задаётся параметром, так что свежий адрес создателя возможен. Graduation в Uniswap v4. **Testnet-деплоя нет.**
   - **Flap.** Есть официальная документация для интеграторов, **есть testnet-деплой** (версия старее). Graduation в Uniswap V2. Portal — upgradeable proxy с админскими блокировками.
   Официального SDK нет ни у одного из двух, работать придётся через ABI и viem.
3. **NEAR Intents 1Click поддерживает сеть** (`blockchain: "hood"`, нативный ETH `nep141:hood.omft.near`). Живая котировка: 0,5 ZEC → 0,24259 ETH, ~454 с, минимум 0,00132 ZEC. В официальной таблице chain-support сети нет, хотя API работает. ZEC по-прежнему только transparent, поэтому как на Solana: **только ребаланс пула**.
4. **Главные новые риски.**
   - (a) Реестр и БД хранят суммы в `BIGINT`/`u64`. Токены с 18 decimals (1e27 базовых единиц) **не влезают**, нужна миграция ядра.
   - (b) Секвенсер принадлежит регулируемому брокеру и **фильтрует транзакции по санкционным спискам**. Админы Flap и Pons могут блокировать адреса или переназначать получателя комиссий. Это риск живучести и цензуры, не приватности.
   - (c) Блоки по 0,1 с с точными метками времени делают сетевую корреляцию в режиме Now сильнее, чем на Solana.
5. **Оценка:** полный паритет — **backend ~12–15 дней, frontend ~4–5 дней**. Минимальная версия (только Pons, buy/sell/create/withdraw, Verify, облегчённая панель безопасности) — **backend ~5–6, frontend ~2**.
   **Вердикт: до 28.10 не делать.** К моменту, когда Solana-часть будет готова и протестирована (~день 14), до сдачи остаётся 2–3 дня, а критерий хакатона «Working beats ambitious». Robinhood Chain — первая сеть после хакатона. В README достаточно одной строки roadmap.

---

## 1. Сеть

| Параметр | Значение | Как проверено |
|---|---|---|
| Тип | Arbitrum Orbit (Nitro) L2, расчёты на Ethereum. «Built with Offchain Labs», лицензия AEP | `web3_clientVersion` = `nitro/v3.12.1-rc.2+70fa99a-20260929`; ArbitrumDAO factsheet |
| Mainnet | Chain ID **4663** (`0x1237`). Генезис 30.04.2026 16:52 UTC (блок 1), **публичный запуск 01.07.2026** | `eth_chainId`, `eth_getBlockByNumber(1)`, factsheet ArbitrumDAO |
| Testnet | Chain ID **46630** (`0xb626`), расчёты на Sepolia | `eth_chainId` |
| Газ-токен | ETH (на обеих сетях) | docs.robinhood.com/chain/connecting |
| Время блока | **~0,1 с** (1000 блоков за 103 с) | два `eth_getBlockByNumber` |
| Base fee | **0,02006 gwei** на mainnet (минимум `ArbGasInfo.getMinimumGasPrice` = 0,02 gwei), 0,01 gwei на testnet. `eth_maxPriorityFeePerGas` = 0 | RPC |
| Финальность | Soft — квитанция секвенсера быстрее 1 с. Batch уходит в L1 «в течение минут», полная финальность ~13 мин после постинга. Вывод через канонический мост — 7 дней. Измерено: тег `safe` отстаёт на ~7 000 блоков (~12 мин), `finalized` — на ~10 900 блоков (**~18 мин**) | docs …/transaction-finality, RPC |
| Порядок транзакций | **FCFS по времени прихода в секвенсер.** «Priority gas auctions do not exist here» | docs …/differences-from-ethereum |
| Мемпул | Публичного нет: `txpool_content` недоступен, транзакции идут прямо в секвенсер (`https://sequencer.mainnet.chain.robinhood.com`). Сразу после упорядочивания они **публично транслируются** через sequencer feed `wss://feed.mainnet.chain.robinhood.com` | docs connecting, RPC |
| MEV / Timeboost | `timeboost_sendExpressLaneTransaction` → «method does not exist» на публичном RPC и на секвенсере. Значит, Timeboost сейчас **не включён** (вывод по косвенному признаку, в документации не сказано). Фронтран по чаевым невозможен, остаётся гонка задержек за бэкран | RPC |
| Бандлы | Аналога Jito нет. Атомарность обеспечивается одной транзакцией контракта (multicall или роутер лаунчпада) | — |
| **Цензура** | «Sequencer-level screening excludes transactions tied to sanctioned addresses» | docs differences-from-ethereum |
| Account abstraction | ERC-4337 EntryPoint v0.6/v0.7/v0.8 по каноническим адресам, **EIP-7702 поддерживается**. Paymaster: Alchemy Gas Manager, ZeroDev | docs …/account-abstraction |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` задеплоен | `eth_getCode` |

**RPC.**
| Эндпоинт | Статус 13.10 |
|---|---|
| `https://rpc.mainnet.chain.robinhood.com` (официальный публичный) | работает, но **после ~10 быстрых запросов подряд отдал Cloudflare managed challenge (HTTP 403)**. Для релейера непригоден |
| `https://rpc.testnet.chain.robinhood.com` | работает |
| Alchemy (рекомендован в доках) `https://robinhood-mainnet.g.alchemy.com/v2/{KEY}`, WS `wss://…` | ключ не проверял |
| Chainstack, QuickNode, Blockdaemon, dRPC, Validation Cloud, GlobalStake, Dwellir, OrbitFlare | перечислены в доках и у вендоров |
| `https://robinhood.drpc.org`, `https://robinhood-rpc.publicnode.com` | публичные, работают, `eth_call` и `eth_getLogs` в пределах окна отвечают |

Решение «чтение и отправка у разных провайдеров» переносится один в один: например, чтение через Alchemy, отправка через Chainstack или QuickNode.

**Эксплорер.** `https://robinhoodchain.blockscout.com` (mainnet), `https://explorer.testnet.chain.robinhood.com` (testnet). На curl Blockscout UI и `/api/v2` отвечают **Cloudflare-челленджем**. Для бека есть Blockscout PRO API: `https://api.blockscout.com/4663/api/v2/...`, бесплатный ключ даёт 5 RPS и 100k кредитов в сутки. Верифицированные исходники надёжнее брать с **Sourcify**: он поддерживает 4663 и 46630.

**Testnet и фаусет.** Официальный фаусет `faucet.testnet.chain.robinhood.com` (на curl отдаёт Vercel checkpoint 429, в браузере, видимо, работает). По вторичному источнику он выдаёт тестовый ETH и симулированные Stock Tokens без требований. Ещё есть фаусеты Chainstack, QuickNode и Alchemy; им нужен баланс на mainnet. Мост из Sepolia — канонический мост Arbitrum.

---

## 2. Лаунчпады

### Ландшафт
- По данным Birdeye: «95 Robinhood Chain launchpads deployed over 850,000 tokens in 92 days, Pons и Flap — более 50%».
- Крупнейший летний лаунчпад **Noxa** 11.07 прекратил запуски, 13.07 сайт лёг (CoinDesk 15.07). **Vlad.fun** приостановился из-за «internal integrity issue».
- Ещё упоминаются hood.fun, Robinlaunch, Bags, Spawn, RobinFun, RealFun, Bow.fun, launchpad.meme. Их **не изучал**: в основном это маркетинговые страницы.

### Pons V2 — основной кандидат
| Что | Значение | Источник |
|---|---|---|
| Документация / SDK | **Официальных нет.** Есть сторонние гайды (Bitquery, Mobula), версии в них противоречат друг другу (V1/V2/V3). ABI и исходники — Sourcify, **верифицированы** (solc 0.8.35, viaIR) | Sourcify, Bitquery, Mobula |
| `PonsV2LaunchFactory` | `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e`. **Не proxy** (слоты EIP-1967 пусты), owner — Safe `0x263ed295dafae1d9aadd6e56c4b6f9f38ee019dd` | RPC, Sourcify |
| `PonsV2LaunchAndBuy` (router и `launchForwarder`) | `0xe33e9e479df8802cb0866d5d05258bec4cf62948` | `launchForwarder()` |
| `PonsV2MemeHook` (Uniswap v4 hook) | `0xe5e702641ea86f4ae6cc3cdaed2b886f976be044` | Sourcify |
| `PonsV2FeeEscrow` | `0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e`: `claim()`, `claimToken(token)`, `balanceOf(recipient)` | Sourcify |
| Legacy (V1) factory | `0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb` (Uniswap v3-позиции) | Bitquery, Mobula |
| Активность | 57 событий `TokenLaunched` в фабрике за последний ~1 ч | `eth_getLogs` |
| **Testnet** | **Нет**: у фабрики и роутера на 46630 нет кода | `eth_getCode` |

**Create.** Вызов `launchToken((name, symbol, logo, description, socials, creatorFeeRecipient, creatorTaxBps, buybackEnabled, expectedEconomics, salt), launchConfigId, pairToken[, snipeTaxExemptions])` с `msg.value == launchFee`. Атомарный create+buy — `LaunchAndBuy.launchAndBuy(params, configId, pairToken, quoteIn, minTokensOut, recipient, exemptions)` → `(token, curve, tokensOut)`. Сейчас `launchEnabled = true`, то есть **запуск permissionless**. `launchFee` = **0,0005 ETH**, `maxCreatorTaxBps` = 1000.

**Buy и sell** идут напрямую в контракт кривой токена (адрес берётся из `getLaunchedToken(token).curve` или события `TokenLaunched`):
- `buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable`. Получатель произвольный, поэтому vault может покупать на любой адрес. Частичное заполнение у порога graduation **не ревертится**, а возвращает остаток; `minTokensOut` в этом случае трактуется как предел цены.
- `sell(uint256 tokensIn, uint256 minQuoteOut, address recipient)` через `safeTransferFrom`, значит, нужен `approve` кривой (один раз на токен). `permit` у токена нет.
- После graduation торговля идёт в пуле Uniswap v4 (LP fee 0, все комиссии забирает hook, tickSpacing 200) через Universal Router `0x8876789976decbfcbbbe364623c63652db8c0904` или агрегатор (см. ниже).

**Quote-токены.** Нативный ETH (`address(0)`), USDG, cbBTC и **токенизированные акции** (AAPL, TSLA, NVDA, SPY и др.). Список меняет owner (Bitquery). Для нас — только ETH.

**Комиссии и экономика** (проверено на живой кривой `0xe65e…e0f9`):
- `feeBps` = 100 (1%) плюс creator tax, который задаётся при запуске (у примера 300 = 3%, максимум 10%);
- graduation на **4,2 ETH** (≈ $10,6k при ETH = $2 529);
- саплай 1e9 токенов с 18 decimals; токен — **обычный ERC-20 + Burnable без owner, весь саплай отчеканен на кривую** (исходник `PonsV2LauncherToken.sol`). Для панели безопасности это идеальный случай.

**Snipe tax.** `snipeTaxStartBps = 9900`, `snipeTaxSeconds = 3`. Первая секунда — 99%, вторая — ~6%, третья — ~0,2%, дальше 0. От налога освобождены deployer, `creatorFeeRecipient` и адреса из `snipeTaxExemptions`. Для fair-launch это готовая защита от снайперов.

**Creator.**
- `deployer` = `msg.sender` вызова фабрики (или исходный вызывающий через forwarder). Он публичен в `TokenLaunched` и `getTokenInfo()`.
- `creatorFeeRecipient` — **отдельный параметр**, поэтому **свежий адрес создателя возможен**, подпись получателя не нужна.
- Комиссии: `sweepFees` вызывает creatorFeeRecipient (curve.deployer) или оператор Pons. Затем `FeeEscrow.claim()` от имени получателя. **Получателю нужен газ.**
- Owner протокола **может переназначить получателя** (`setCreatorFeeRecipient`, onlyOwner). Это риск доверия, не приватности.

Наблюдение: UI Pons шлёт `launchAndBuy` через **неверифицированный** контракт `0x9DCCeB09…3961`, а не через `0xe33e…`, и подставляет одноразовый `deployer` без кода. Мы бы вызывали верифицированные `0xe33e…` или фабрику напрямую.

### Flap — второй кандидат (есть testnet)
| Что | Значение |
|---|---|
| Документация | **Официальная**: docs.flap.sh, есть «Robinhood Chain Integration Guide» и `llms.txt` |
| Portal (proxy) | `0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09`. Один адрес на mainnet (impl `0xf9209bdb…bd99`, `version()` = **v5.23.1**, верифицирован на Sourcify) и **на testnet** (`version()` = **v5.14.16**) |
| Create | `newTokenV5(params)` — токен без налога; `newTokenV6` — Tax Token V3. Получатель комиссий — `beneficiary` |
| Buy/sell | `swapExactInput{value}(…)`, `quoteExactInput`, также `buy`/`sell` |
| Quote-токен | только ETH |
| Graduation | ~5 ETH (80% саплая), **Uniswap V2**. Дальше действует окно anti-farmer (переводы в «чужие» пулы блокируются) |
| Админ | `halt()`, `setBlockedToken`, **`setSpammerBlockedBatch`** (блокировка адресов), upgradeable proxy. Риск, что vault пула заблокируют |
| Активность testnet | **[не подтверждено]**: выборка логов не дала событий, а длинные окна `eth_getLogs` упёрлись в таймаут |

### Вторичка и агрегатор (аналог Jupiter)
- Uniswap v4 на 4663 официально задеплоен: PoolManager `0x8366…0951`, Universal Router `0x8876…0904`, Quoter `0x8dc1…8f94`, Permit2. Плюс Uniswap V2/V3 и Ramses (по DexScreener).
- **LI.FI поддерживает 4663 для свопов внутри сети.** Живые котировки 13.10: ETH → CASHCAT через Nordstern; **ETH → токен, который ещё на кривой Pons, — через KyberSwap**. То есть агрегатор видит кривые Pons, как Jupiter видит pump.fun. Котировка есть, исполнение **не проверял**. Relay и Across тоже поддерживают 4663.

### Свой минимальный bonding-curve контракт — не рекомендую
По правилам хакатона это допустимо (код пишется в окне). Но:
- (1) теряется смысл «Launch anywhere»: токен не появится в ленте Pons и Flap, где сидят трейдеры;
- (2) это **неаудированный контракт с деньгами пользователей** на mainnet, а судьи и пользователи такого не любят;
- (3) работа на 3–4 дня (контракт, Foundry-тесты, деплой, адаптер, индексатор).
Pons и Flap permissionless, поэтому собственный контракт не нужен.

---

## 3. NEAR Intents 1Click

| Что | Значение (13.10 ~08:09 UTC, dry, без API-ключа, slippage 1%) |
|---|---|
| Поддержка сети | **Есть**: в `GET /v0/tokens` есть `blockchain: "hood"` с ETH `nep141:hood.omft.near`, WETH, USDG, USDe, а также PONS и CASHCAT |
| В официальной доке | В таблице `docs.near-intents.org/resources/chain-support` Robinhood Chain **не указана**. API впереди документации, поддержка может измениться |
| ZEC → ETH(hood) | 0,00132 ZEC → 0,000630 ETH; 0,02 ZEC → 0,009694 ETH ($24,57 → $24,51); **0,5 ZEC → 0,242587 ETH ($614,33 → $613,47)**. `timeEstimate` **454 с** |
| Минимум | «try at least 132000» = **0,00132 ZEC** (как для SOL) |
| ETH(hood) → ZEC | 0,1 ETH → 0,20372 ZEC ($252,89 → $250,30), **142 с**. На 0,001 ETH фиксированный оверхед ~$0,4 (16%) |
| Комиссии | как в `solana-launchpads.md` §6: +0,25% без ключа, ~0,20% с JWT |
| Адрес получателя | EVM-адрес с чексуммой: адрес-заглушка `0x…dEaD` отвергается («recipient is not valid»), случайный валидный проходит |
| ZEC | **только transparent** (без изменений), значит, только батч-ребаланс пула. Выплаты пользователям через 1Click запрещены |

**Что меняется в `core/scanner/src/oneclick.rs` и `rebalance.rs`:** только `destinationAsset` и тип адреса получателя. Курс ZEC/ETH тоже берётся из `/v0/tokens`: ZEC $1 227,88, ETH $2 529,29.

**Альтернативы, если 1Click уберёт `hood`:**
- 1Click ZEC → ETH на Arbitrum One (`nep141:arb.omft.near`), затем Relay или Across в 4663. Это ещё один хоп, ещё одна связка адресов и +1–2 мин;
- канонический мост из L1 (~10 мин внутрь, 7 дней наружу).

Приватность от этого не меняется: связка «t-адрес пула → адрес получения пула» видна в любом варианте. Пользователь здесь не участвует.

---

## 4. EVM-vault

**Ключи.**
- Отдельный BIP-39 сид для EVM, зашифрованный тем же способом, что и сейчас (age + `LoadCredential`, см. `adapters/src/keystore.ts`). Ed25519-сид Solana для этого не использовать.
- Деривация BIP-32 secp256k1 `m/44'/60'/0'/0/i` (`@scure/bip32`, viem `HDKey`). Индексы: vault-шарды; launch-адрес — `hash(launch_id)`.
- Только EOA. Безопасных смарт-кошельков (Safe) в MVP нет, они появятся в roadmap вместе с Squads.

**Nonce.**
- На каждый vault — мьютекс в релейере. Решение «одна позиция на mint = один vault» уже сериализует большинство операций.
- Nonce берётся через `eth_getTransactionCount(addr, "pending")` плюс локальный счётчик. На `nonce too low`/`already known` — пересинхронизация.
- У Arbitrum нет мемпула: секвенсер либо сразу принимает транзакцию (квитанция < 1 с), либо отклоняет её. Зависших транзакций и replace-by-fee практически нет. Это проще, чем Solana с blockhash expiry.

**Газ (13.10).**
- Create + первая покупка в Pons — 4,56M gas × 0,020 gwei ≈ **0,00009 ETH (~$0,23)** (по реальной транзакции `0x70c5…0738`).
- Buy или sell на кривой, по оценке, 150–300k gas ≈ $0,01 **[не подтверждено симуляцией]**.
- L1-компонента (calldata) входит в `gasUsed`, `eth_estimateGas` учитывает её сам.

**Единый fee-профиль (замена квантованного priority fee).**
- На Arbitrum чаевые ничего не покупают, а платится base fee. Поэтому **все** транзакции пула отправляются как type-2 с `maxPriorityFeePerGas = 0` и **постоянным** `maxFeePerGas` (например 0,2 gwei = 10× минимума, пересматривать раз в день, а не на каждую транзакцию).
- `gasLimit` = оценка × 1,2, округлённая вверх до корзины 100k.
- Now и Delayed на цепочке неотличимы. Отпечаток «софта Unzeen» по `maxFeePerGas` остаётся, но он один на весь пул, как и сейчас.

**Свежий адрес создателя и его финансирование.**
- Как и на Solana, launch-vault — свежий адрес пула на каждый запуск, `creatorFeeRecipient` — **тот же launch-адрес**. Отдельный адрес-получатель не нужен.
- Финансирование: фиксированная округлённая сумма (например 0,01 ETH + initial buy) с общего hot-vault. Связь «запуск ↔ пул Unzeen» публична по определению (бейдж «Unzeen launch»). Связать два запуска одного пользователя нельзя: все запуски финансирует один и тот же источник.
- Сильнее, но дороже: держать резерв предфинансированных адресов, пополняемый напрямую из 1Click (ETH приходит с адреса солвера NEAR Intents, общего для всех его пользователей) в случайное время и округлёнными суммами. Пополнять «под запуск» нельзя из-за 7,5 мин задержки и корреляции.
- EIP-7702 / 4337 paymaster убирает перевод газа, но paymaster сам становится общей меткой. Для MVP не нужно.
- **Никогда** не принимать от пользователя `creatorFeeRecipient`, `snipeTaxExemptions` и `transferCreatorFeeRecipient` на его адрес: это ончейн-деанонимизация создателя.

**Вывод токенов.**
- ERC-20 `transfer` с launch- или mint-vault на новый адрес пользователя плюс капля ETH (≈0,00005 ETH хватает на ~10 переводов при текущем газе), отдельными транзакциями, с задержкой и округлением, как на Solana.
- Адрес проверять по EIP-55 и отклонять контракты (`eth_getCode` ≠ 0x), чтобы не отправить токены в контракт.

**Подписи для Verify.** EIP-712 typed data, домен `{name:"unzeen-verify", version:"1", chainId:4663}`, структура `{snapshotId, address, blockNumber}`. Проверка в браузере — viem `verifyTypedData` или `@noble/curves/secp256k1` + `@noble/hashes/sha3`. EIP-191 `personal_sign` тоже подходит, но EIP-712 лучше читается в кошельках и сам привязан к chainId.

---

## 5. Панель безопасности на EVM

| Метрика | Как получить | Цена / провайдер |
|---|---|---|
| Owner / renounce | `owner()` (Ownable). У токенов Pons V2 owner **нет**, это видно по исходнику | 1 `eth_call` |
| Функции mint | Нужен исходник или анализ байткода. У Pons V2 фиксированный саплай (известно по исходнику). Для чужих токенов — GoPlus `is_mintable` | Sourcify / GoPlus |
| Proxy / upgradeable | Слоты EIP-1967 через `eth_getStorageAt` (impl/admin) | 2 вызова RPC |
| Honeypot / налог | Симуляция buy+sell через `eth_call` со `stateOverride`, или GoPlus `buy_tax`/`sell_tax`/`cannot_sell`. **honeypot.is не поддерживает 4663** (ответ 400 «Invalid chain»). Tax Token V3 у Flap — это налог по построению, показывать его ставку | RPC / GoPlus |
| Top-10 холдеров | Аналога `getTokenLargestAccounts` в EVM **нет**. Варианты: (1) свой индекс `Transfer` с блока запуска (у Pons и Flap токены свежие, так что это дёшево); (2) Blockscout PRO API holders (free: 5 RPS, 100k кредитов в сутки); (3) GoPlus `holders`; (4) Bitquery (платный). У GoldRush в списке эндпоинтов holders нет | — |
| История дева | В Pons `TokenLaunched` индексирует `deployer` (topic 3), так что это один `eth_getLogs` с фильтром. **Дешевле, чем на Solana** | RPC |
| Снайперы | Pons сам эмитит `SnipeTaxCharged(recipient, amount)`: готовая разметка снайперов | RPC logs |
| Прогресс кривой / graduated | Pons: `getLaunchedToken().phase` и `curve.getReserves()` против `graduationThreshold`. Flap: `getTokenV8Safe(token).status` | RPC |
| LP | У Pons LP заблокирована локером по построению (2/7 саплая уходит в sweep, 4/49 лочится). У Flap V2 migrator, сожжена ли LP — **[не подтверждено]** | — |
| Соцсети | Pons хранит `logo/description/socials` **on-chain** (`getTokenInfo()`). Внешние картинки грузить только через бек (high-риск из token-intel) | RPC |

**GoPlus поддерживает 4663**: есть в `/supported_chains`, `token_security/4663` вернул данные по CASHCAT (без ключа). DexScreener и Birdeye сеть видят.
Схема приватности та же, что в `token-intel.md`: все запросы только с бека, по тёплому набору и с приманками. Фронт к GoPlus, DexScreener и RPC напрямую не ходит.

---

## 6. Verify

- **Активы.** Список vault и launch-адресов пула (EOA). Каждый адрес подписывает EIP-712-сообщение снимка, транзакции не нужны. Балансы читаются **одним Multicall3 `aggregate3` на фиксированном блоке** (`getEthBalance` + `balanceOf` по каждому ERC-20). Блок — `finalized` (сейчас отстаёт от головы на ~18 мин), его номер = `snapshotBlock`. Для самостоятельной проверки в UI — `cast balance --block N` / `cast call <token> "balanceOf(address)" --block N`.
- **Дерево обязательств.**
  - Актив теперь идентифицируется парой `(chainId, asset)`, где asset = `"native"` или адрес ERC-20 в нижнем регистре.
  - **Ширина сумм:** токен с 18 decimals и саплаем 1e9 — это 1e27 базовых единиц. Это **больше u64 (1,8e19) и больше i64**. В листьях и узлах суммы нужно кодировать как u256 (32 байта BE), суммы в узлах хранить в u128 (максимум 3,4e38 — запас достаточный). Значит, **версия тега меняется: `unzeen/verify/v2`**.
  - В доменный тег листа и сообщения подписи добавить `chainId`, чтобы снимки Solana и Robinhood не перепутать.
- **Резерв ZEC** — без изменений (attested by operator).
- **Commitment root fair-launch и якорь Verify** можно оставить на Solana (memo-tx) или продублировать в calldata нулевой self-tx на 4663. Для MVP одного якоря достаточно.

---

## 7. Приватность: отличия от Solana

| Аспект | Solana (сейчас) | Robinhood Chain |
|---|---|---|
| Мемпул | Публичного нет, есть лидеры и SWQOS | Публичного нет. FCFS-секвенсер, через ~мс после упорядочивания транзакция публична в feed |
| Кто видит транзакцию до включения | Helius Sender / лидер | Провайдер RPC и **секвенсер (Robinhood, регулируемый брокер)**. Они видят IP **нашего сервера**, а не пользователя. Пользователь ничего не подписывает в сети |
| Фронтран | Возможен (Jito) | Невозможен по чаевым. Остаётся бэкран-гонка (на цену нашей сделки не влияет) |
| Тайминги | Слот 400 мс | **Блок 100 мс** и точные метки времени. В Now-режиме сделка ложится через ~0,1–0,3 с после HTTP-запроса, корреляция по сетевым метаданным сильнее. Значения по умолчанию Delayed/Max становятся ещё важнее; в UI Now — то же предупреждение |
| Отпечаток комиссии | Квантованный priority fee | Постоянный `maxFeePerGas`, `priority = 0`, корзины `gasLimit` (см. §4) |
| Approve | — | `approve` перед первой продажей токена с vault — одна дополнительная публичная транзакция на (vault, mint). Делать её сразу после покупки, чтобы она не выдавала момент будущей продажи |
| Цензура | Нет | **Санкционный скрининг на секвенсере** плюс админские блокировки у Flap. Если пул или 1Click-маршрут пометят, vault перестанут исполняться. Это риск живучести, утечки он не создаёт |
| Создатель | `creator` в pump.fun публичен | `deployer` и `creatorFeeRecipient` публичны, списки `SnipeTaxExempted` публичны. Те же правила: только адреса пула |
| Индексаторы | Helius, Shyft | Alchemy, Blockscout, GoPlus, GoldRush, Bitquery. Интерес к mint видят так же. Без изменений: только бек, с приманками |

Новых классов утечек со стороны пользователя нет, если сохранить правила Solana: пользователь не подписывает транзакции, суммы округляются, выводы с задержкой, creator — адрес пула.

---

## 8. Оценка в днях

### Backend
| Задача | Полная | MVP |
|---|---|---|
| EVM-ключи: HD, keystore, launch-адреса | 0,5 | 0,5 |
| Sender: fee-профиль, nonce-менеджер, квитанции, 2 провайдера | 1 | 1 |
| **Ledger/DB: измерение `chain`, `BIGINT` → `NUMERIC(78,0)`, `u64` → `u128` в Rust, курс wei/ZEC вместо lamports/ZEC** (трогает ядро) | 1,5–2 | 1,5 |
| Адаптер Pons: launch/launchAndBuy, buy, sell + approve, офчейн-котировка по `PonsV2BondingCurveMath`, status, декодер событий | 1,5–2 | 1,5 |
| Адаптер Flap (опционально, для testnet) | 1–1,5 | — |
| После graduation: Uniswap v4 через Universal Router или LI.FI | 1 | — |
| Релейер: маршрутизация по сети, вывод ERC-20 + капля ETH | 1 | 0,5 |
| Индексатор и лента «unzeen купил…» (события Pons) | 1 | 0,5 |
| Creator fees: `sweepFees` + `FeeEscrow.claim` по расписанию | 0,5–1 | — |
| Ребаланс 1Click ZEC → ETH(hood) | 0,5 | 0,25 (вручную) |
| Verify v2 (EIP-712, Multicall3, u256 в дереве) | 1 | 0,5 |
| Панель безопасности (GoPlus + RPC + свой индекс `Transfer`) | 1–1,5 | 0,5 |
| Fair-launch через `launchAndBuy` (атомарно, без бандла) | 0,5–1 | — |
| E2E на mainnet (testnet для Pons нет) | 1 | 0,5 |
| **Итого** | **~12–15** | **~5–6** |

### Frontend
| Задача | Полная | MVP |
|---|---|---|
| Переключатель сети: ось «Solana / Robinhood» отдельно от main/test, раздельное состояние | 1 | 0,5 |
| EVM-адреса (EIP-55, ENS не нужен), эксплорер-ссылки, ETH с 18 decimals в форматтерах | 0,5 | 0,5 |
| Страница токена, лента, запуск (поля Pons: creator tax, quote = ETH) | 1 | 0,5 |
| Панель безопасности: EVM-метрики (tax, proxy, owner) | 0,5–1 | 0,25 |
| Verify: проверка EIP-712 в браузере, u256 | 0,5 | 0,25 |
| Вывод: форма EVM-адреса | 0,5 | 0,25 |
| **Итого** | **~4–5** | **~2** |

**Что переиспользуется без изменений.** Весь Zcash-слой (сканер, депозиты, payouts), anon-ключи и подписанные действия, ордера (логика), чат, tlock/commitment root fair-launch, очередь и engine релейера (паттерн), клиент 1Click, оболочка UI, API-контракт (суммы уже строками). Переделать придётся слой сумм (типы) и всё, что называется `lamports*`.

---

## 9. Вердикт и минимальная версия

**До 28.10 — не делать.** Причины:
- (1) по плану Solana-часть готова к дню 13–14, после этого остаются 2–3 дня на README, видео и сдачу, а MVP на Robinhood занимает ~5–6 + 2 дня;
- (2) потребуется миграция типов сумм в ядре реестра, единственном месте, где ошибка = потеря денег или неверный Verify;
- (3) Pons нельзя протестировать на testnet;
- (4) по критериям «Working beats ambitious» вторая сеть, сделанная наполовину, снижает оценку, а не повышает её.

Для сабмита хватит строки roadmap «Launch anywhere: Robinhood Chain (Pons, Flap) next». Не раскрывать детали (правило CLAUDE.md про fair-launch и бандлы здесь тоже действует).

**Если владелец решит делать после Solana (или после хакатона), минимальная версия такая:**
1. Только **Pons V2**, только quote = ETH, только mainnet. Отдельный экземпляр бекенда `robinhood` с тем же Zcash-слоем.
2. Действия с баланса: create (`launchAndBuy`, launch-адрес = creatorFeeRecipient), buy и sell на кривой, withdraw ERC-20 на новый адрес с каплей ETH. Режимы Now, Delayed и Max — с единым fee-профилем.
3. Ребаланс ZEC → ETH(hood) вручную через 1Click батчами фиксированного размера.
4. Verify v2 (EIP-712 + Multicall3 на `finalized`).
5. Панель: owner/proxy/tax (RPC + GoPlus), прогресс кривой, снайперы из `SnipeTaxCharged`, top-10 из своего индекса `Transfer`.
6. Без Flap, без вторички после graduation (на этом этапе — «graduated, торгуйте через Uniswap»), без fair-launch, ордеров и сбора creator fees (комиссии копятся в escrow, сбор позже).

**Предварительная работа, которую стоит сделать уже сейчас** (дёшево и полезно самой Solana-части): в новых миграциях и полях API больше не заводить `BIGINT` для токенных сумм и не вшивать «lamports» в имена новых полей. Старое пока не трогать.

---

## Находки и риски (по убыванию)

**High**
1. **Переполнение сумм.** `core/migrations/0002_relayer.sql:66-89,128-129` (`token_amount`, `out_token_amount`, `lamports_in`… — `BIGINT`), `core/ledger/src/actions.rs:43-83` (`u64`). Для 18-decimal токенов (1e27) это переполнение. Исправление при портировании: `NUMERIC(78,0)` в БД, `u128` в Rust, строки в API (в API уже так). Сейчас не трогать.
2. **Цензура и админы.** Санкционный скрининг на секвенсере; у Flap есть `setSpammerBlockedBatch`/`halt`, у Pons owner может переназначить получателя создательских комиссий и менять параметры. Исправление: показывать в модели доверия README; адаптер — Pons, потому что фабрика не proxy; деньги на vault держать минимальными.
3. **Pons нельзя протестировать на testnet.** Исправление: юнит-тесты против форка mainnet (`anvil --fork-url` на 4663) плюс один mainnet-прогон на малых суммах.

**Medium**
4. У Pons нет официальной документации и SDK, сторонние доки противоречат друг другу, UI Pons использует неверифицированный роутер. Исправление: фиксировать адреса и хэши байткода в конфиге, ABI брать с Sourcify, перед вызовом проверять `expectedEconomics` (Pons позволяет закрепить параметры запуска хэшем).
5. Публичный RPC Robinhood закрывается Cloudflare после серии запросов; Blockscout UI и API — тоже. Исправление: платные или keyed провайдеры (Alchemy, Chainstack), Blockscout PRO API, Sourcify.
6. 1Click поддерживает `hood` фактически, но в официальной таблице сети нет. Исправление: фолбэк через `arb` + Relay/Across, курс брать из `/v0/tokens`.
7. Блоки по 100 мс усиливают сетевую корреляцию в Now. Исправление: те же значения по умолчанию (Delayed) и предупреждение в UI.

**Low**
8. Snipe tax 99% в первую секунду чужого запуска: если ордер пользователя сработает в окне 3 с, он потеряет почти всё. Исправление: в адаптере перед buy читать `curve.currentSnipeTaxBps(vault)` и откладывать, если > 0.
9. `approve` перед продажей — дополнительная транзакция и отпечаток. Исправление: делать сразу после первой покупки по mint.

---

## Открытые вопросы для лида / владельца

1. Подтвердите, что Robinhood Chain — **после** сабмита (рекомендация), а в README идёт только строка roadmap.
2. Если всё же делать: Pons (без testnet, mainnet-only) или Flap (есть testnet, но upgradeable и блок-листы)? Рекомендация — Pons.
3. Готов ли владелец к миграции типов сумм в ядре (`NUMERIC`/`u128`) как отдельной задаче после хакатона?
4. Нужен ли API-ключ GoPlus (лимиты бесплатного тарифа **не подтверждены**) и ключ Alchemy или Chainstack для 4663?

---

## Источники (проверено 2026-10-13)

- Живые RPC: `https://rpc.mainnet.chain.robinhood.com`, `https://rpc.testnet.chain.robinhood.com`, `https://robinhood.drpc.org`, `https://robinhood-rpc.publicnode.com` (`eth_chainId`, `eth_getBlockByNumber`, `eth_getCode`, `eth_getStorageAt`, `eth_getLogs`, `eth_call`, `timeboost_*`, `txpool_content`).
- [Robinhood Chain — Connecting](https://docs.robinhood.com/chain/connecting), [Transaction finality](https://docs.robinhood.com/chain/transaction-finality), [Gas & fees](https://docs.robinhood.com/chain/gas-and-fees), [Differences from Ethereum](https://docs.robinhood.com/chain/differences-from-ethereum), [Bridging](https://docs.robinhood.com/chain/bridging), [Account abstraction](https://docs.robinhood.com/chain/account-abstraction), [About](https://docs.robinhood.com/chain)
- [ArbitrumDAO Factsheet: Robinhood Chain Mainnet Launch](https://forum.arbitrum.foundation/t/arbitrumdao-factsheet-robinhood-chain-mainnet-launch/31041)
- [Arbitrum blog: Robinhood Chain testnet](https://blog.arbitrum.io/robinhood-chain-testnet/)
- [Sourcify API, chain 4663](https://sourcify.dev/server/v2/contract/4663/0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e) (PonsV2LaunchFactory, LaunchAndBuy, MemeHook, LaunchDeployer, FeeEscrow, Flap Portal impl)
- [Bitquery — Pons API](https://docs.bitquery.io/docs/blockchain/robinhood/pons-api/), [Mobula — Pons](https://docs.mobula.io/almanac/robinhood-launchpads/pons), [Bitquery — Flap.sh API](https://docs.bitquery.io/docs/blockchain/robinhood/flap-sh-api/)
- [Flap — Robinhood Chain Integration Guide](https://docs.flap.sh/flap/developers/token-launcher-developers/robinhood-integration-guide.md), [Flap — Deployed contract addresses](https://docs.flap.sh/flap/developers/deployed-contract-addresses.md)
- [Uniswap v4 deployments](https://developers.uniswap.org/docs/protocols/v4/deployments)
- [CoinDesk 15.07.2026 — Noxa](https://www.coindesk.com/business/2026/07/15/the-launchpad-that-fueled-robinhood-chain-s-memecoin-boom-just-gave-away-all-its-revenue), [Cointelegraph via TradingView — Vlad.fun](https://www.tradingview.com/news/cointelegraph:7b3edf0da094b:0-robinhood-chain-memecoin-launchpad-vlad-fun-halts-after-internal-integrity-issue/), [Birdeye on X](https://x.com/birdeye_data/status/2087468783753654399)
- NEAR Intents 1Click: `GET https://1click.chaindefuser.com/v0/tokens`, `POST /v0/quote` (dry); [chain support](https://docs.near-intents.org/resources/chain-support)
- [GoPlus API](https://docs.gopluslabs.io/) (`/api/v1/supported_chains`, `/api/v1/token_security/4663`), DexScreener `api.dexscreener.com/latest/dex/tokens/…`, honeypot.is (`chainID=4663` → 400)
- [Blockscout Robinhood API](https://docs.blockscout.com/robinhood-api), [GoldRush — Robinhood Chain](https://goldrush.dev/docs/chains/robinhood-chain)
- LI.FI `https://li.quest/v1/chains`, `/v1/quote` (fromChain=toChain=4663); Relay `https://api.relay.link/chains`; Across `available-routes`
- [Datawallet — testnet faucets](https://www.datawallet.com/crypto/get-robinhood-chain-testnet-tokens) (вторичный источник)
