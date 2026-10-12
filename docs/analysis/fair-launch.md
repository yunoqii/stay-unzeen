# Fair-launch: спецификация (tlock sealed bids → атомарный create+buy)

Автор: analyst. Дата: **2026-10-12** (день 7). Внутренний документ, репо приватный. **До 28.10 23:59 UTC не публиковать** (CLAUDE.md). Фичу на публичном деплое держать за флагом `PoolInfo.features.fairLaunch = false` до дедлайна: бандл фронта с tlock-js сам раскрывает идею.

Основа: ARCHITECTURE.md (Fair-launch, режимы исполнения), FEATURES.md, API.md v0.5, RELAYER.md v2, `analysis/solana-launchpads.md` (§1, §5), `analysis/now-mode.md`. Код читал: `adapters/src/pumpfun.ts` (`prepareCreate`), `core/migrations/0007_intel.sql`, `web/next.config.ts` (CSP).

---

## TL;DR

1. **drand quicknet** (`52db9ba7…e971`, период 3 с, схема `bls-unchained-g1-rfc9380`). Браузер: `tlock-js@0.9.0` со **статическим ChainClient**: браузер не ходит в drand, CSP и так это заблокирует. Сервер: `tlock_age@0.0.10` (расшифровка, без сети) и `drand-verify@0.6.2` (`G2PubkeyRfc`, проверка подписи раунда). Подпись раунда **проверять до расшифровки**, иначе подложный beacon «обнулит» все заявки.
2. **Шифруется только сумма** вместе с привязкой `launchId ‖ anonPubkey`: 64 байта, фиксированная длина. Anon-ключ сервер и так знает из подписи запроса. **Hold = номинал из фиксированной сетки** (0.05 / 0.1 / 0.25 / 0.5 / 1 / 2.5 / 5 / 10 ZEC), сумма ≤ номинала. Поэтому «недостаточных» заявок не бывает. Невалидная заявка исключается, hold снимается. Отмена возможна до `closeAt`.
3. **Исполнение: ОДНА v0-tx `createV2AndBuyV2` с ALT с одного vault**, через тот же путь отправки, что и все tx пула. Адаптер это уже умеет (`pumpfun.ts:205`), e2e на devnet пройден. **Jito в v1 не нужен:** до create mint не существует, поэтому сделать фронтран или сэндвич нечем. Jito нужен только для дробления на несколько vault, а это только mainnet (на devnet Jito нет). Это вырезается первым. ARCHITECTURE/FEATURES («Jito-бандл») нужно поправить, решение за лидом.
4. **Одна цена для всех**: `S/T` (потрачено лампортов / получено токенов). Токены делятся пропорционально `floor`, пыль остаётся пулу. Переподписка сверх `maxTotalLamports` (по умолчанию 25 % саплая) режет все заявки в одной пропорции. Кап создателя 5 % гарантирован лимитом его заявки `≤ maxInitialBuyLamports` (доказательство в §4). Лок 24 ч распространяется только на долю создателя.
5. **Публично до раунда видны только мета токена и время раунда.** Число заявок и суммы не видны никому, включая создателя. После раунда видны итог (он и так on-chain) и число заявок, если их ≥ 5 (иначе «<5»). Ciphertext'ы **не публикуются**: после раунда их может расшифровать кто угодно. Исполнение идёт в момент раунда drand и не зависит от времени запросов. По таймингу это приватнее Delayed.
6. **MVP к дням 11–12**: pump.fun, devnet + mainnet, окно 2–30 мин, одна tx, сетка hold, одна заявка на ключ, отмена, reveal, распределение, лента. Оценка: **backend ~2 дня, frontend ~1,5–2 дня**. Укладывается в 11–12, если ядро (дни 3–10) не съедет.

---

## 1. drand: сеть, библиотеки, проверка (факты на 12.10.2026)

### Сеть: quicknet
| Параметр | Значение | Источник |
|---|---|---|
| chain hash | `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971` | `GET https://api.drand.sh/<hash>/info`, 12.10 |
| public key (G2, 96 байт) | `83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a` | там же |
| period / genesis | 3 с / `1692803367` (unix сек) | там же |
| scheme | `bls-unchained-g1-rfc9380` (подпись в G1, 48 байт; unchained = подпись раунда зависит только от номера раунда) | там же |
| время раунда | `t(R) = genesis + (R − 1) · 3`; `R(t) = floor((t − genesis)/3) + 1`. Проверено: `latest = 33010614` → 2026-10-12 20:00:06 UTC | расчёт + `/public/latest` |
| relay-эндпоинты | `api.drand.sh`, `api2.drand.sh`, `api3.drand.sh`, `drand.cloudflare.com`: все `200` на `/public/latest` 12.10 | curl |
| будущий раунд | `GET /public/<R>` до наступления даёт **HTTP 425 Too Early** | curl 12.10 |
| testnet drand | Для tlock не нужен. Quicknet публичен и бесплатен, **одна и та же сеть для devnet и mainnet Unzeen** | — |

Почему quicknet: это единственная живая unchained-сеть LoE с периодом 3 с. Fastnet (`dbd506…`) выведен из эксплуатации (drand.love/blog/2023/07/03/fastnet-sunset-quicknet-new). В `tlock-js` именно quicknet возвращает `mainnetClient()`.

### Браузер: `tlock-js@0.9.0`
- npm `tlock-js` **0.9.0** (последний, modified 2025-07-30). Зависимости: `drand-client` **1.2.5** (пин), `@noble/curves ^1.4`, `@noble/hashes ^1.4`, `@stablelib/chacha20poly1305`, `buffer`. В `web` стоит `@noble/curves ^2.4`, значит в бандл попадут две копии (~+50 КБ, некритично).
- API (из `index.d.ts` пакета): `timelockEncrypt(roundNumber: number, payload: Buffer, chainClient: ChainClient): Promise<string>`. Возвращает **age armor** (`-----BEGIN AGE ENCRYPTED FILE-----`) со stanza `tlock <round> <chainhash>`.
- **Сети шифрование не требует.** `createTimelockEncrypter` вызывает только `client.chain().info()` (`drand/timelock-encrypter.js`). Значит, фронт обязан передать **статический клиент** с захардкоженным `MAINNET_CHAIN_INFO` (экспортируется как `defaultChainInfo`):
  ```ts
  const staticQuicknet: ChainClient = {
    options: { disableBeaconVerification: true, noCache: true },
    chain: () => ({ baseUrl: "", info: async () => defaultChainInfo }),
    latest: () => { throw new Error("offline") },
    get: () => { throw new Error("offline") },
  };
  ```
  Перед использованием assert'нуть `defaultChainInfo.hash === QUICKNET_HASH && public_key === QUICKNET_PK`: это защита от подмены зависимости. **`mainnetClient()` в браузере не использовать**: это запрос к `api.drand.sh` (третья сторона узнаёт IP и время заявки). CSP (`web/next.config.ts:39`, `connect-src 'self' <api>`) такой запрос всё равно заблокирует.
- Номер раунда фронт **берёт из `FairLaunch.drand.round`** (API), а не вычисляет. Таймер считается локально по формуле `t(R)`.

### Сервер (Rust, core): `tlock_age@0.0.10` + `drand-verify@0.6.2`
| Крейт | Версия | Что даёт | Замечания |
|---|---|---|---|
| `tlock_age` | **0.0.10** (2026-07-12, MIT, thibmeu/tlock-rs) | `decrypt_header(src) -> Header{round(), hash()}`, `decrypt(dst, src, chain_hash, signature)` | Feature `armor` **обязателен** (tlock-js отдаёт armor). Default feature `rfc9380` = quicknet. Сети нет: «Both encryption and decryption are performed without network access» (lib.rs). **Подпись раунда НЕ проверяет**: неверная подпись просто даёт `DecryptionFailed`. Тянет `age 0.11`, а в core уже `age 0.12.1`. Две версии уживаются в дереве, но собрать нужно заранее |
| `tlock` | 0.0.10 | IBE поверх arkworks (`ark-bls12-381 0.6`) | транзитивно |
| `drand-verify` | **0.6.2** (2023-12, Apache-2.0, noislabs) | `G2PubkeyRfc::from_fixed(PK).verify(round, b"", &sig) -> Result<bool>` для `bls-unchained-g1-rfc9380` | Сети и JSON нет, только криптография. `bls12_381 0.8` / `pairing 0.23` (в core уже 0.9/0.24, будут дубли, это нормально). Тест-вектор в крейте: quicknet round 123, sig `b75c69d0…dfc92` |
| альтернатива | `drand_core 0.0.19` | клиент + проверка | тянет `ureq`/`ring`, избыточно; HTTP у core уже есть |

Тест-векторы для CI: quicknet round **1000**, sig `b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39` (из тестов `tlock-0.0.10/src/lib.rs`), round **123** (из `drand-verify`). **Обязательный кросс-тест:** ciphertext от `tlock-js` (на раунд 1000) положить в `core/testdata/fl-vectors.json` и расшифровать в Rust. Без него день 12 уйдёт на отладку armor/stanza.

### Проверка раунда на сервере (порядок)
1. `GET https://<relay>/52db…e971/public/<R>`, relay берётся по кругу из 4. На `425` повтор через 1 с, на сетевую ошибку переход к следующему relay.
2. `round == R`, `sig` = 48 байт hex, `G2PubkeyRfc::verify(R, b"", sig) == true`. Иначе beacon отбрасывается и берётся другой relay. **Ни одна заявка не помечается invalid, пока подпись не проверена.**
3. BLS-подпись детерминирована: верная подпись раунда одна, поэтому достаточно одного проверенного источника.
4. Нет валидного beacon за `T+10 мин` → повторы раз в минуту до `T+60 мин`, затем запуск `failed` (`drand_unavailable`), все hold снимаются, комиссия создателю возвращается.

---

## 2. Протокол заявки

### Жизненный цикл запуска
```
fl_create ──(граница эпохи Delayed)──▶ open ──closeAt──▶ closed ──t(R)──▶ revealing ──job──▶ executing ──▶ launched
     │                                   │                                     │                         └──▶ failed (tx)
     │                                   └─ fl_cancel_launch (создатель) ─▶ cancelled                    └──▶ failed (no_bids / drand / rate)
```
- `closeAt` = `publishAt + windowSecs`, где `windowSecs ∈ PoolInfo.fairLaunch.windowsSecs` (по умолчанию `[120, 300, 600, 1800]`; 120 только для демо).
- `R` = `R(closeAt) + 2`: раунд **строго позже** закрытия, запас 6 с на рассинхрон часов. Заявки, пришедшие на сервер после `closeAt`, получают `409 launch_closed`. Инвариант: `closeAt < t(R)`. Он проверяется при создании запуска и в тесте.
- **Публикация запуска** (появление в `GET /api/launches`) происходит не сразу, а на ближайшей границе эпохи Delayed (30–60 с). Иначе сетевой наблюдатель свяжет POST создателя с появлением запуска (как `now`, см. now-mode.md).

### Что шифруется (plaintext, 64 байта, фиксированная длина)
```
off len поле
0   4   magic "UZFL"
4   1   version = 1
5   2   chainId (0x0202 / 0x0101)  — заявка devnet не годится на mainnet
7   16  launchId (16 байт)
23  32  anonPubkey (ed25519)        — привязка: скопированный чужой ciphertext даст «чужой» pubkey → invalid
55  8   amountZat (u64 LE)
63  1   0x00 (резерв/паддинг)
```
- Шифрует фронт: `timelockEncrypt(R, plaintext, staticQuicknet)`, затем строка armor. Длина ciphertext постоянная (64 байта payload + age header), поэтому размер не выдаёт сумму. Тело POST всё равно добивается `pad` (API v0.4).
- **Anon-ключ отдельно не шифруется.** Сервер знает его из подписи HTTP (`x-unzeen-pubkey`), и ему этот ключ нужен для hold. Шифрование ключа ничего не скрыло бы от оператора и ничего не добавило бы для публики (ciphertext не публикуется).
- **Подпись.** Отдельно plaintext не подписывается: запрос подписан anon-ключом, подпись покрывает `sha256(body)` с ciphertext. Подделать заявку от чужого имени нельзя. Копия чужого ciphertext не пройдёт проверку pubkey внутри.

### Hold: номиналы (выбранный вариант)
Сумма до раунда неизвестна, поэтому hold ставится на **номинал** `holdZat ∈ PoolInfo.fairLaunch.holdTiersZat`. Mainnet: `[0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]` ZEC. Devnet: те же числа в TAZ. Должно выполняться `amountZat ≤ holdZat`. Фронт сам выбирает наименьший номинал ≥ суммы, пользователь может поднять номинал вручную («скрыть сумму сильнее»).

| Вариант | Что узнаёт оператор до раунда | Минусы | Решение |
|---|---|---|---|
| hold = заявленный максимум (произвольный) | почти точную сумму | tlock теряет смысл | нет |
| hold = весь баланс | баланс (и так знает) | блокирует все деньги, мешает торговать | нет |
| **hold = номинал из сетки** | диапазон (номинал), сумма не известна | сумма оценивается сверху с точностью до номинала | **да** |
| залог фиксированным номиналом + доплата после reveal | номинал | доплата может не пройти (баланс потрачен) → недостаточные заявки | нет |

Следствие: **после расшифровки «недостаточных» заявок не бывает**, сумма всегда покрыта hold. Публике (и создателю) номиналы не видны. Оператору виден только номинал. В README честно написать: «оператор видит верхнюю границу заявки до раунда, точную сумму — только после раунда, как все».

### Невалидные заявки (после проверенного beacon)
| Условие | Итог | Деньги |
|---|---|---|
| `decrypt` ошибка (битый armor, не тот раунд/сеть, мусор) | `invalid` | hold → доступно |
| magic/version/chainId/launchId не совпали | `invalid` | hold → доступно |
| `anonPubkey` ≠ автор заявки | `invalid` | hold → доступно |
| `amountZat < minActionZat` или `amountZat > holdZat` | `invalid` | hold → доступно |
| валидна | `revealed` | участвует |

Невалидная заявка ни на что не влияет: она исключается **до** расчёта суммы. Штрафа нет: спам заявками блокирует только собственные деньги спамера, плюс работает rate-limit 60/мин. Статус `invalid` видит только владелец (portfolio). Наружу невалидные заявки не считаются.

Проверки **при приёме** заявки (до раунда): `decrypt_header` → `round == R` и `hash == quicknet`; armor ≤ 1 КиБ; запуск `open`; одна активная заявка на (`anonPubkey`, `launchId`), иначе `409 already_bid`; hold по номиналу ≤ `zecBalance`.

### Отмена
- `fl_cancel {launchId}` действует до `closeAt`. Hold снимается, ciphertext **удаляется** из БД. Сменить сумму можно только через отмену и новую заявку.
- После `closeAt` отмена невозможна (`409 launch_closed`): набор заявок зафиксирован.
- `fl_cancel_launch {launchId}` доступна только создателю и только до `closeAt`. Все hold снимаются, комиссия запуска возвращается. Создатель не знает число и суммы заявок, поэтому подстроить запуск под спрос он не может.

---

## 3. Исполнение

### Одна tx против Jito-бандла
| | Одна v0-tx `createV2AndBuyV2` + ALT | Jito-бандл (create+buy(vault1), buy(vault2..5)) |
|---|---|---|
| Атомарность create+buy | да (одна tx) | да (бандл all-or-nothing) |
| Сниперы до/на цене запуска | невозможны: mint создаётся этой tx | невозможны |
| Devnet | **да**, e2e пройден (STATUS, `pumpfun.ts:236`: ~1476 байт legacy → v0 + ALT) | **нет** (у Jito нет devnet; testnet pump-программы не проверен) |
| Сложность | 0: существующий `create` с `lamports_in = сумма` | новый исполнитель, tip-аккаунты, `getBundleStatuses`, лимит 1 rps/IP/регион, ретраи |
| Холдер on-chain | один vault держит до 25 % саплая | 2–5 vault |
| Отпечаток | tx как у всех (единый CU price, Helius Sender) | Jito tip отличает fair-launch, но fair-launch и так публичен |

**Решение v1: одна tx**, тот же путь отправки и тот же квантованный CU price, что у всех tx пула. Jito появляется только вместе с дроблением по vault (v2, mainnet, дни 11–12 при наличии времени). Это вырезается первым. Дробление по vault приватности почти не даёт: vault публичны и связаны (D4). Разница только в том, что в топ-10 нет одного кита. Но там и так стоит отдельная строка `unzeenPoolPct`.

**Честная формулировка для README и судей:** «никто не может купить раньше или по цене запуска». Купить **сразу после** (в том же слоте, дороже) можно. Время раунда публично, поэтому боты будут ждать. Это не снайпинг цены запуска.

### Лимиты первой покупки (pump.fun Global, прочитано on-chain 12.10 через `OnlinePumpSdk.fetchGlobal()`)
| Параметр | mainnet | devnet |
|---|---|---|
| `initialVirtualTokenReserves` | 1 073 000 000 (×10⁶) | то же |
| `initialVirtualSolReserves` | **30 SOL** | **1 SOL** (!) |
| `initialRealTokenReserves` | 793 100 000 (79,31 % саплая) | то же |
| `feeBasisPoints` / `creatorFeeBasisPoints` (Global) | 95 / 5 | 95 / 5 |
| SOL (без комиссий) на 5 % саплая | ≈ 1,466 SOL | ≈ 0,049 SOL |
| на 25 % | ≈ 9,11 SOL | ≈ 0,304 SOL |
| на 50 % | ≈ 26,18 SOL | ≈ 0,873 SOL |
| до graduation (79,31 %) | ≈ 85,0 SOL | ≈ 2,83 SOL |

Формула (constant product, без комиссий): `SOL(tok) = Vs0·Vt0/(Vt0 − tok) − Vs0`. Фактические комиссии берутся из `FeeConfig.feeTiers` (~1 %, см. solana-launchpads.md §1). Котировку брать из SDK (`getBuyV3TokenAmountFromQuoteAmount`), а не по этой формуле. **На devnet кривая в 30 раз дешевле**, поэтому все лимиты считаются из Global своей сети и не хардкодятся.

- **`maxTotalLamports`** = лампорты на `fairLaunch.maxTotalBps` саплая (по умолчанию **2500 = 25 %**) по свежей кривой. Это далеко от graduation: buy v3 за порогом сам завершает кривую и докупает в пуле миграции (solana-launchpads.md §1), в create-tx это не тестировалось, поэтому туда не идём. При переподписке (`Σ > maxTotal`) все заявки режутся в одном коэффициенте `k = maxTotal/Σ`, остаток возвращается.
- **Слиппедж собственной покупки** практически нулевой: кривая свежая, mint создаётся в этой же tx, вклиниться некому. `minOut = quote · (1 − 50 bps)`, запас на смену FeeConfig между котировкой и исполнением. `slippage` здесь означает только «программа поменяла параметры», что нужно разбирать вручную.
- **D10 (срезка 0–1 % + округление вниз до 0.001 SOL)** применять и к общей сумме, для единообразия с buy: при 1–2 участниках общая сумма ≈ сумме одной заявки.
- Курс ZEC→SOL один для всех (`lamportsPerZecBuy` из фонового кэша на момент reveal) и фиксируется в запуске. Нет курса (> 120 с) → повтор до 10 мин, потом `failed (venue_unavailable)`.
- Compute: 500k CU (как create+buy, README SDK).

### Если tx не прошла
- Применяется ровно протокол RELAYER.md §4: подпись пишется до отправки, **новая tx только после доказательства**, что старая не попадёт (`getSignatureStatuses` пусто **и** `blockHeight > lastValid`). До 3 попыток в окне 10 мин.
- **Mint keypair один на запуск** (генерируется при reveal, хранится в задании и на зашифрованном томе, как ключи vault) и не меняется между попытками. Тогда двойной create невозможен по построению: вторая tx с тем же mint упадёт, если первая всё-таки прошла. Сейчас `prepareCreate` генерирует `Keypair.generate()` на каждый вызов (`pumpfun.ts:229`). Для fair-launch нужен параметр `opts.mintKeypair`.
- Окончательный `failed` → запуск `failed`, **все hold снимаются полностью**, комиссия создателю возвращается за вычетом фактически сгоревших network fee (≈0). Пользователь видит «launch failed, funds released».
- Ошибка программы `slippage` / `venue_unavailable` (create_v2 выключен) обрабатывается так же. Повторно с новым курсом не пересчитываем: заявки были сделаны под конкретный раунд.

---

## 4. Распределение в реестре и правила создателя

### Расчёт (core, при reveal; всё в целых числах)
```
вход: валидные заявки b_i (зат), курс r (лампорт/ZEC, buy), maxTotal, D10
L_i   = floor(b_i · r / 1e8)                    // лампорт-эквивалент заявки
Σ     = Σ L_i
k     = min(1, maxTotal / Σ)                    // переподписка
e_i   = floor(L_i · k)                          // эффективная заявка
E     = Σ e_i
L_tx  = D10(E)                                  // в задание relayer: lamports_in
— после confirmed: T = out_token_amount, S = out_lamports (≤ L_tx)
t_i      = floor(T · e_i / E)                   // токены участнику
spent_i  = ceil(S · e_i / E)                    // лампорты участника
charge_i = ceil(spent_i · 1e8 / r)  ≤ b_i       // зат списать; ≤ hold_i гарантировано
release_i = hold_i − charge_i                   // вернуть на доступный баланс
dust = T − Σ t_i  (< N базовых единиц) → инвентарь пула (vault), в обязательства не входит
```
- Цена одна для всех: `S/T`. Разница из-за округлений не больше 1 базовой единицы на участника.
- Комиссия площадки входит в `S` и делится пропорционально.
- Creator fee pump.fun от собственной покупки запуска копится на свежем creator-адресе пула. **Рекомендация:** не зачислять в `claimable` создателя ту часть, что набежала с launch-tx (это ~0,05–0,3 % от денег участников), а оставить пулу. Решение за лидом, по умолчанию «пулу».
- Settler: задание `create` связано с запуском (`fl_launches.job_id`), а не с action пользователя. На `confirmed` в одной транзакции Postgres: `token_balances += t_i` для каждого участника, hold закрывается, `fl_bids.status = settled`, токен пишется в `tokens`, события `create` + `buy` идут в `trades` (как обычный create). На `failed` все hold → доступно.

### Правила создателя (API v0.5, принудительно в реестре)
- **Кап 5 %.** Заявка создателя (того anon-ключа, что сделал `fl_create`) обрезается при reveal до `b_c ≤ maxInitialBuyLamports / r`. Остаток возвращается. Почему этого хватает: кривая вогнута, `T(0)=0`, поэтому `T(E)/E ≤ T(e_c)/e_c` при `e_c ≤ E`. Отсюда доля создателя `t_c = T(E)·e_c/E ≤ T(e_c) ≤ T(maxInitialBuy) = 5 %`. Пул покупает по средней цене не ниже, чем создатель купил бы один. При приёме заявки создателя фронт ограничивает номинал (`holdZat ≤ ближайший номинал ≥ cap`), сервер обрезает при reveal.
- **Лок 24 ч** на `t_c` (запись в `creator_tokens`, как для `create.initialBuyZec`). Остальные участники не залочены.
- **Ограничение (честно):** кап и лок привязаны к anon-ключу. Создатель может заявиться с другого ключа, и это не обнаружить. Так же устроен обычный `create`. В бейдже «rules enforced» формулировка остаётся как есть: «через ключ создателя».
- **T1:** доля создателя не публикуется. `devPct = null`, бейдж `unzeen.launch = true` плюс новое правило `fair_launch_sealed_bids` в `UnzeenRule`.

---

## 5. Приватность

| Что | До `closeAt` | `closeAt` → раунд | После раунда |
|---|---|---|---|
| мета, venue, `closeAt`, `R` | публично | публично | публично |
| число заявок | **никому** (ни публике, ни создателю) | никому | публично, если ≥ 5, иначе `"<5"` |
| суммы заявок | никому, включая оператора (у оператора только номиналы) | то же | только владельцу (portfolio). Публике нет |
| сумма всех заявок | никому | никому | публично (= buy on-chain) |
| ciphertext | только сервер | только сервер | удаляется сразу после reveal, не публикуется |
| доля участника | — | — | только владельцу |
| commitment root (опц., §7) | — | публикуется в `closeAt` | публично |

Утечки и меры:
1. **(high) Живой счётчик заявок.** Если число заявок обновлять публично в момент POST, сетевой наблюдатель свяжет IP и время запроса с «это была заявка на запуск X». **Счётчик до reveal не показывать вообще.**
2. **(high) Браузер ходит в drand.** Третья сторона получает IP и время заявки. Нужны статический ChainClient, таймер по формуле и CSP. Проверить в DevTools: за время заявки не должно быть ни одного запроса не к своему API.
3. **(high) Публикация ciphertext ради проверяемости.** После раунда tlock расшифрует кто угодно, а значит станут публичны все суммы, а следом и доли (`t_i ∝ b_i`). Доля, совпавшая с последующим `withdraw_token`, связывает адрес. **Не публиковать.** Вместо этого commitment root (sha256 Merkle по `sha256(ciphertext)`) в `closeAt` плюс доказательство включения владельцу.
4. **(medium) Появление запуска сразу после POST создателя.** Публиковать запуск на границе эпохи Delayed.
5. **(medium) Мало участников.** При 1 заявке общая сумма on-chain равна сумме этой заявки, и все токены запуска в vault принадлежат одному anon-ключу. Это не раскрывает личность (то же, что обычный buy), но точное число при < 5 не показывать. Фронт предупреждает: «few bids so far is possible — your amount ≈ total».
6. **(medium) Вывод доли.** `withdraw_token` ровно на `t_i` позже связывается по сумме, если доля стала известна (например, при 1 участнике). Действуют существующие меры: округление, задержка, smart-вывод, предупреждение при совпадении с недавней «покупкой». Fair-launch-аллокацию тоже считать «недавней покупкой».
7. **(low) Тайминг исполнения.** Он задан раундом drand и не зависит от того, когда пришли заявки. Это лучше Delayed. Заявки идут тем же `POST /api/actions` с `pad`, поэтому на проводе они неотличимы от buy/sell.
8. **(low) Хранение.** `fl_bids.amount_zat`, `charge`, `tokens` затираются через 24–48 ч (D1), ciphertext сразу после reveal. В логах core нет `launchId` вместе с `anonPubkey` и суммами. Время приёма заявки огрубляется до часа (как `created_at` у jobs).
9. **(low) Номинал hold виден оператору.** В README это описано в модели доверия.

---

## 6. UX (что видит пользователь)

Компоненты уже есть: `web/components/motion/progress-ring.tsx`, `decrypt-text.tsx`, `scramble-text.tsx`.

1. **Запуск** (`/launch`): переключатель режима `Instant | Fair launch`. Для Fair задаётся окно (2/5/10/30 мин; 2 только для демо) и мета. Подсказка: «Everyone buys in one transaction at one price when the drand round fires. No one — including us — can see bids before that.» Комиссия = `createFeeZat`. Своя заявка создателя делается отдельным шагом, с подсказкой капа 5 %.
2. **Страница запуска** (`/launch/:id`), фазы:
   - **Open:** кольцо-таймер до `closeAt`. Поле суммы ZEC; номинал hold выбирается автоматически («Hold: 0.5 ZEC — hides your exact amount»). Кнопка «Seal bid». После отправки своя сумма показывается глифами `▓▒░` (scramble). Hover или удержание показывает сумму **из локального зашифрованного хранилища** (как PnL); сервер её не знает. Кнопка «Withdraw bid». Счётчика заявок нет: вместо него текст «Bids are sealed. Count revealed after the round.»
   - **Closed:** второе кольцо до `t(R)`. Под ним «drand round #R», текущий номер раунда тикает локально раз в 3 с. Опрос `GET /api/launches/:id` с тем же интервалом, что у всех зрителей страницы.
   - **Revealing → Launched:** глифы `▓▒░` превращаются в цифры через `decrypt-text`: сначала total, потом «your allocation». Показываются mint, ссылка на tx, цена `S/T` («same price for everyone»), число заявок (или `<5`), «refunded X ZEC» при переподписке или остатке. После этого обычная страница токена.
   - **Failed / Cancelled:** «Funds released», понятная причина (`no_bids`, `drand_unavailable`, `tx_failed`).
3. **Portfolio:** блок «Sealed bids» со статусом (`sealed / revealed / invalid / cancelled / settled`), hold, а после раунда сумма, токены и списано/возвращено.
4. **Verify (опц.):** commitment root запуска и кнопка «verify my bid is included» (доказательство из portfolio).

Тексты UI на английском (правило проекта).

---

## 7. Черновик для API.md (v0.6)

Изменения предлагает analyst, вносит backend по согласованию с лидом.

```ts
// PoolInfo (дополнение)
interface PoolInfo {
  features: { fullTrades: boolean; fairLaunch: boolean };   // fairLaunch=false → fl_* → 400 feature_disabled
  fairLaunch?: {
    windowsSecs: number[];          // допустимые окна, напр. [120, 300, 600, 1800]
    holdTiersZat: string[];         // номиналы hold, по возрастанию
    maxTotalLamports: string;       // кап общей покупки (из Global сети, maxTotalBps саплая)
    maxTotalBps: number;            // 2500
    minBidsForCount: number;        // 5: меньше → bids: "<5"
    drand: { chainHash: string; publicKey: string; genesis: number; period: 3; scheme: "bls-unchained-g1-rfc9380" };
  };
}

type FairLaunchStatus = "open" | "closed" | "revealing" | "executing" | "launched" | "failed" | "cancelled";

interface FairLaunch {            // публичный, без подписи, одинаков для всех
  id: string;                     // 32 hex (16 байт), он же launchId в plaintext
  venue: "pumpfun";               // v1 только pump.fun
  meta: { name: string; symbol: string; image?: string };   // image — наш /media URL
  status: FairLaunchStatus;
  publishedAt: number;            // unix мс, граница эпохи (не момент запроса создателя)
  closeAt: number;                // unix мс
  drand: { round: number; roundTime: number };   // roundTime = t(R) мс
  commitment?: { root: string };  // hex sha256, появляется при closed (опционально, §7 MVP+)
  result?: {                      // только launched
    mint: string; solanaTx: string;
    totalLamports: string;        // S
    tokenAmount: string;          // T, базовые единицы
    decimals: number;
    priceSol: string;             // S/T, UI-единицы
    bids: number | "<5";
    oversubscribed: boolean;
  };
  failure?: "no_bids" | "drand_unavailable" | "venue_unavailable" | "tx_failed";
  rules: UnzeenRule[];            // + "fair_launch_sealed_bids"
}

// SignedAction (дополнение) — тот же POST /api/actions, с pad
type SignedAction = /* ...существующие... */
  | { op: "fl_create"; venue: "pumpfun"; meta: { name: string; symbol: string; image?: string }; windowSecs: number }
  | { op: "fl_bid"; launchId: string; holdZat: string; ciphertext: string }   // armor age (tlock), ≤ 1024 байт
  | { op: "fl_cancel"; launchId: string }                                     // снять свою заявку до closeAt
  | { op: "fl_cancel_launch"; launchId: string };                             // только создатель, до closeAt

// ActionReceipt для fl_create дополнительно: { launchId: string } (видит только создатель)

// Portfolio (дополнение)
interface Portfolio {
  fairBids: {
    launchId: string;
    holdZat: string;
    status: "sealed" | "cancelled" | "invalid" | "revealed" | "settled" | "released";
    amountZat?: string;           // после reveal
    tokenAmount?: string;         // после settled
    chargedZat?: string; releasedZat?: string;
    proof?: { leaf: string; path: string[] };   // если commitment включён
  }[];
  fairLaunches: { launchId: string }[];         // созданные этим ключом (кабинет создателя)
}
```

| Метод | Путь | Ответ |
|---|---|---|
| GET | `/api/launches?status=open\|closed\|launched&limit=50` | `FairLaunch[]` (публичный, `Cache-Control: max-age=5`) |
| GET | `/api/launches/:id` | `FairLaunch` \| 404 |
| WS | `/ws/feed` | для fair-launch те же `FeedEvent` `create` + `buy` после исполнения (флаг `fair?: true` в `FeedEvent`, опционально) |

Новые коды ошибок: `launch_closed` (409: окно закрыто или запуск не `open`), `already_bid` (409: у ключа уже есть активная заявка), `bad_ciphertext` (400: header не tlock, не тот раунд/сеть, > 1 КиБ), `feature_disabled` (400, уже есть). `creator_cap` при `fl_bid` создателя с номиналом выше капа → 422.

Подпись, nonce и pad остаются как у всех действий. **Векторы:** `core/testdata/fl-vectors.json`: plaintext, ciphertext tlock-js на раунд 1000, подпись раунда 1000, ожидаемый plaintext.

---

## 8. Требования

### core (Rust) — backend
- [ ] Миграция `0008_fair_launch.sql`. `fl_launches (id, network, creator_pubkey, venue, meta, window_secs, published_at, close_at, round, status, rate, l_tx, mint_secret_ref, job_id, result..., failure)`. `fl_bids (launch_id, anon_pubkey, hold_zat, ciphertext NULL после reveal, status, amount_zat, e_lamports, tokens, charge_zat, created_at огрублён до часа)`, `UNIQUE (launch_id, anon_pubkey) WHERE status='sealed'`. Права роли релейера: **никаких** на `fl_*`.
- [ ] API: `fl_create` (hold `createFeeZat`, публикация на границе эпохи), `fl_bid` (`decrypt_header` → round/hash, номинал из сетки, hold), `fl_cancel`, `fl_cancel_launch`, `GET /api/launches[/:id]`, `Portfolio.fairBids`.
- [ ] Планировщик: `open → closed` в `closeAt` (заявки после этого → 409), сюда же опциональный commitment root. В `t(R)`: fetch beacon (4 relay, 425-ретрай) → `drand-verify` → `tlock_age::decrypt` (feature `armor`) → валидация → кап создателя → расчёт §4 → одна транзакция Postgres: статусы заявок, `INSERT relayer_jobs(op='create', lamports_in=L_tx, min_out, meta, exec_mode='now', not_before=now())`, ciphertext = NULL.
- [ ] 0 валидных заявок или `L_tx < 0.001 SOL` → `failed(no_bids)`, всё снимается, комиссия возвращается.
- [ ] Settler: ветка для job запуска (распределение §4, лок создателя, `creator_tokens`), на `failed` всё освобождается.
- [ ] Janitor: D1-затирание сумм `fl_bids` через 24–48 ч.
- [ ] Тесты: кросс-вектор tlock-js→Rust, неверная подпись beacon → **ни одной** invalid, раунд в будущем → 425 → ожидание, все строки таблицы «невалидные заявки», переподписка, кап создателя, округления (`Σ t_i ≤ T`, `charge_i ≤ hold_i`), `closeAt < t(R)`.
- [ ] Логи: без `anon_pubkey`/сумм/`launchId` в одной строке.

### relayer (TS) — backend
- [ ] Исполнитель `create` переиспользуется. Нужно добавить поле задания **`mint_secret`** (или ссылку на него) и `opts.mintKeypair` в `prepareCreate`: тот же mint на всех попытках. Секрет живёт на зашифрованном томе, в логи не попадает, после `confirmed` удаляется.
- [ ] Хелпер `maxLamportsForBps(bps)` по Global и FeeConfig сети. Нужен core для `PoolInfo.fairLaunch.maxTotalLamports` и `launchRules.maxInitialBuyLamports`: та же функция, одна реализация. Либо core считает сам по формуле с параметрами из таблицы, которую релейер обновляет.
- [ ] Ничего про заявки и anon-ключи релейер не знает (как и сейчас).
- [ ] (v2, вырезается первым) Jito-бандл на 2–5 vault, только mainnet.

### web — frontend
- [ ] `tlock-js@0.9.0` (пин) со статическим ChainClient и assert'ом hash/PK. Динамический import только на странице запуска.
- [ ] Кодек plaintext 64 байта (`UZFL`), тест-вектор совпадает с core.
- [ ] `/launch` (режим Fair), `/launch/:id` (фазы §6), блок в portfolio, локальное зашифрованное хранение своей суммы.
- [ ] Никаких запросов к drand и третьим сторонам. Таймер по формуле `t(R)`. Счётчика заявок до reveal нет.
- [ ] Флаг `PoolInfo.features.fairLaunch`: при `false` UI скрыт (публичный деплой до 28.10).

---

## 9. Риски

| Риск | Серьёзность | Мера |
|---|---|---|
| Подложный или недоступный beacon обнуляет заявки | high | `drand-verify` до расшифровки; invalid только после проверенной подписи; 4 relay; `failed` с полным возвратом через 60 мин |
| Несовместимость armor/stanza tlock-js ↔ tlock_age | high (по срокам) | кросс-вектор в CI в первый же день работ |
| Двойной create при ретрае | high | один mint keypair на запуск + протокол RELAYER §4 |
| Покупка за порогом graduation внутри create | medium | `maxTotalBps = 25 %`, переподписка режется |
| Devnet ≠ mainnet по кривой (1 vs 30 SOL) | medium | лимиты из Global своей сети, ничего не хардкодить |
| Утечка счётчика или ciphertext | high (дисквал.) | §5 п. 1–3, ревью аналитика перед включением флага |
| Публичный деплой раскрывает фичу до дедлайна | medium (правило CLAUDE.md) | флаг `features.fairLaunch=false` на публичном origin до 28.10 |
| Сибиллы создателя обходят кап | low (известно) | честная формулировка бейджа |
| `tlock_age` 0.0.x, один мейнтейнер | low | пин версии, векторы; формат age/tlock совместим с Go-референсом |
| Две версии `age`/`bls12_381` в core | low | собрать в первый день, проверить время сборки |

---

## 10. MVP для демо и порядок урезания

**MVP (дни 11–12):** pump.fun; devnet (для судей) и mainnet (видео); окна 2/5 мин; одна tx create+buy; сетка hold; одна заявка на ключ; `fl_cancel`; reveal по drand с проверкой; пропорциональное распределение; кап и лок создателя; лента; фазы UI с кольцом и `▓▒░`-reveal.

**Сценарий видео (60–80 с):** создатель запускает fair launch на 2 мин → два-три demo-ключа делают заявки (суммы в глифах) → кольцо до раунда drand → reveal → одна tx в эксплорере: create + buy → «same price for everyone» → портфели участников с долями.

**Урезать по порядку:**
1. Jito и дробление по vault (v2, только mainnet). Уже вне MVP.
2. Commitment root и доказательство включения (красиво для судей, но не ядро).
3. `fl_cancel_launch` создателем.
4. Meteora DBC (`createPoolWithFirstBuy`) для fair-launch.
5. `fl_cancel` заявки (оставить «нельзя отменить», UI предупреждает).
6. Режим mainnet для fair-launch (только devnet в демо, а mainnet показать обычным create).

Сам fair-launch по CLAUDE.md идёт последним в порядке урезания. Если резать его целиком, ядро не страдает.

**Что впечатлит судей (трек Private Markets: «sealed-bid»):** настоящий tlock с проверяемым раундом drand (номер раунда и ссылка на beacon на странице), никто не знает суммы, даже оператор, одна on-chain tx, одна цена. Commitment root (п. 2) делает это проверяемым: если к дню 12 останется полдня, его стоит вернуть.

---

## 11. Оценка трудозатрат

| Кто | Задача | Дни |
|---|---|---|
| backend/core | миграция, 4 op API, GET launches, portfolio | 0,5 |
| backend/core | планировщик, drand fetch и проверка, tlock расшифровка, кросс-векторы | 0,5 |
| backend/core | расчёт распределения, settler, кап и лок, тесты | 0,5–0,75 |
| backend/relayer | `mintKeypair`, хелпер лимитов, e2e devnet | 0,25 |
| **backend итого** | | **~1,75–2** |
| frontend | tlock-js статический клиент, кодек, вектор | 0,25 |
| frontend | `/launch` режим Fair + `/launch/:id` фазы, кольца, reveal | 1–1,25 |
| frontend | portfolio-блок, локальное хранение суммы, флаг | 0,25–0,5 |
| **frontend итого** | | **~1,5–2** |
| analyst | ревью приватности перед включением флага | 0,25 |
| (v2) | Jito multi-vault | +1–1,5 (только mainnet) |
| (опц.) | commitment root + proof | +0,5 (бек 0,25 + фронт 0,25) |

Бек и фронт идут параллельно, если API (§7) зафиксировать в API.md до дня 11. Фронт мокает `FairLaunch`.

---

## Открытые вопросы для лида / владельца
1. **Jito.** Подтвердить v1 без Jito (одна tx) и поправить формулировку в ARCHITECTURE/FEATURES («атомарный create+buy одной tx; Jito-бандл — при дроблении по vault»).
2. **Число заявок после reveal:** точное при ≥ 5 и `"<5"` иначе (рекомендация) или не показывать вовсе.
3. **Номиналы hold:** утвердить сетку (и отдельно для devnet).
4. **`maxTotalBps`:** 25 % (рекомендация) или меньше.
5. **Creator fee с launch-tx:** оставлять пулу (рекомендация) или зачислять создателю.
6. **Commitment root:** включать в MVP или в «если останется время».
7. **Публичный деплой до 28.10:** fair-launch за флагом `false` (рекомендация).

## Источники (проверено 2026-10-12)
- drand quicknet info / latest / 425: `https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/info`, `/public/latest`; `https://api.drand.sh/v2/beacons`; relay `api2/api3.drand.sh`, `drand.cloudflare.com`
- Fastnet sunset / quicknet: https://drand.love/blog/2023/07/03/fastnet-sunset-quicknet-new/
- tlock-js: https://github.com/drand/tlock-js, npm `tlock-js@0.9.0` (исходник `index.js`, `drand/defaults.js`, `drand/timelock-encrypter.js` из `npm pack`)
- drand-client: npm `drand-client@1.2.5` (пин в tlock-js), последний 1.4.2
- tlock-rs: https://github.com/thibmeu/tlock-rs, crates `tlock@0.0.10`, `tlock_age@0.0.10` (исходник `src/lib.rs`, `src/internal.rs`, `Cargo.toml`), https://docs.rs/tlock_age/0.0.10
- drand-verify: https://github.com/noislabs/drand-verify, crate `drand-verify@0.6.2` (`src/verify.rs`, `G2PubkeyRfc`)
- pump.fun Global: on-chain через `@pump-fun/pump-sdk@4.0.0` `OnlinePumpSdk.fetchGlobal()` на `api.mainnet-beta.solana.com` и `api.devnet.solana.com`
- Jito: https://docs.jito.wtf/lowlatencytxnsend/ (по `analysis/solana-launchpads.md` §5)
- Не подтверждено документацией: точные текущие ставки FeeConfig pump.fun (брать из SDK в рантайме), поведение buy v3 за порогом graduation внутри create-tx (не тестировалось, поэтому кап 25 %).
