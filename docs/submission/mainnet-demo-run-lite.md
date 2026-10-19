# Mainnet-прогон LITE: минимальный бюджет (внутренний план)

Дата: 2026-10-19. Автор: analyst. Код сверен на HEAD `d878fb8`, только чтение. На mainnet ничего не отправлялось. Полный план: `docs/submission/mainnet-demo-run.md` (дальше просто «полный план»). Порядок шагов, пре-флайт, гарды, откат и «не показывать» берём оттуда. Здесь только то, что меняется.

**Вывод.** Минимальный путь на mainnet (депозит ZEC → баланс → create → buy → sell → withdraw → Verify) на Solana и на hood укладывается в **≈0.030 ZEC** из ZODL (вариант L1, нужна одна правка кода hood) или в **≈0.046 ZEC** без правок кода (вариант L0). Сгорит **≈$5–6** вместо $15–20. Почти всё остальное остаётся оборотным капиталом пула: его можно вернуть, либо он сразу возвращается выводом на камеру. Главное, что раздувало бюджет: лот 0.06 ZEC на hood под funder с запасом 0.022 ETH. Второе: шаг пополнения creator зашит в код, 0.01 ETH (`adapters/src/evm/pons/adapter.ts:179`).

Курсы (`GET https://api-mainnet.169-58-209-71.sslip.io/api/rates`, 19.10): ZEC $1138.19, SOL $104.46, ETH $2409.32, ZEC/SOL 10.896, ZEC/ETH 0.4724.

---

## 1. Проверенные минимумы и цены (19.10)

### 1.1 NEAR 1Click (живые dry-котировки `POST https://1click.chaindefuser.com/v0/quote`, без JWT, slippage 100 bps, тело как в `core/scanner/src/oneclick.rs:158`)
| Лот ZEC | → SOL | → ETH (hood, `nep141:hood.omft.near`) | Потеря in→out USD |
|---|---|---|---|
| 0.00100 | отказ: «Amount is too low for bridge, try at least 132000» | то же | — |
| 0.00132 (минимум = `MIN_LOT_ZAT`) | 0.014188 | 0.000612 | ≈1.2 % / 1.7 % |
| 0.003 | 0.032502 | 0.001404 | ≈0.4 % / 0.8 % |
| 0.005 | 0.054207 | 0.002348 | ≈0.36 % / 0.47 % |
| 0.010 | 0.108482 | 0.004703 | ≈0.30 % / 0.31 % |
| 0.035 | 0.380021 | 0.016486 | ≈0.21 % / 0.16 % |

`timeEstimate` 452–454 с. Минимум 132 000 zat одинаков для SOL и ETH, валидация в коде есть (`rebalance.rs:176`). Спред на малых лотах около 0.3–0.5 %, в долларах это центы.

### 1.2 Robinhood Chain (RPC `https://rpc.mainnet.chain.robinhood.com`)
- `eth_gasPrice` = base fee = **0.02046 gwei** (блок 92 700 328).
- `launchFee()` фабрики Pons `0x7eD5…EC7e` = **0.0005 ETH**, `launchEnabled = true` (eth_call 19.10).
- Create+buy ≈4.56M gas ≈ 0.00009 ETH ($0.23) (`docs/analysis/robinhood-chain.md:166`). Buy/sell ≈ $0.01 [не подтверждено симуляцией].
- **Но:** Arbitrum требует на балансе `gasLimit × maxFeePerGas + value` заранее. При пуловом `maxFeePerGas` 0.2 gwei (`HOOD_MAX_FEE_WEI` по умолчанию) и gasLimit create ≈5.5M нужно ≈0.0011 ETH сверху. Это определяет минимальный запас газа у creator.
- На Pons идут живые запуски: 197 логов фабрики за последние 50k блоков (≈1.4 ч).

### 1.3 pump.fun на mainnet (4 свежие tx `CreateV2` через публичный RPC, 19.10: `4qnNbhRkn6zB…`, `DMTZHoyuMcsF…`, `5K8pT4DLmkbb…`, `4UMRe1Mash3t…`)
- Create без покупки: рента **0.0058–0.0071 SOL** (mint Token-2022 ≈0.0027, кривая 0.0015, ATA кривой 0.0015, ещё один аккаунт 0.0015) + комиссия сети 0.00001. Протокольной комиссии за create нет: списание с плательщика = рента + fee.
- Первая покупка vault по mint: ATA ≈0.0015 SOL, плюс разово на vault аккумулятор(ы) объёма ≈0.0013–0.002.
- Наш create ещё создаёт и расширяет **ALT своего vault** (`adapters/src/alt.ts`, `pumpfun.ts:881`), потому что create+buy ≈1476 байт. Оценка ренты ≈0.006–0.010 SOL [не подтверждено: размер таблицы зависит от числа fee recipients и tip-аккаунтов]. На devnet весь create оценивали в ≈0.02 SOL (`adapters/src/relayer/executors.ts:84`).
- Торговая комиссия pump.fun 1.25 % (`core/ledger/src/curve.rs:68`). Sender tip 5000 lamports на tx, priority — центы.
- ATA vault при полной продаже **не закрывается** (в адаптере нет closeAccount): рента ATA и ALT на деле сгорают. Теоретически их можно вернуть, но кода для этого нет.

### 1.4 Минимумы и дефолты в коде, которые мешают малым лотам
| Что | Где | Значение | Влияние на lite |
|---|---|---|---|
| `MIN_DEPOSIT_ZAT` | `core/api/src/config.rs:633`, `core/scanner/src/service.rs:64` | 0.001 ZEC | не мешает |
| `MIN_ACTION_ZAT` | `config.rs:634` | 0.001 ZEC | buy ≥ 0.001. **Sell тоже ≥ 0.001 по оценке** (`actions.rs:926`): чтобы продать 50 %, buy должен быть ≥ ≈0.0023 ZEC |
| D10 шаг | `core/api/src/rate.rs:214,217` | 0.001 SOL / 0.0001 ETH | min initial buy = 1 шаг (≈0.0001 / ≈0.0002 ZEC) |
| `CREATE_FEE_ZAT` | `config.rs:774` | 0.001 ZEC | покрывает ренту create (≈0.010 SOL ≈ 0.0009 ZEC); не менять |
| `UNZEEN_NOW_FEE_ZAT` | `config.rs:773` | 0.00005 ZEC | мелочь |
| `WITHDRAW_ZEC_FEE_ZAT` | `config.rs` | 0.00015 ZEC | мелочь |
| `WITHDRAW_TOKEN_GAS/COST_LAMPORTS` | `config.rs` | 0.002 + 0.0021 SOL (hood 0.00005 + 0.00001 ETH) | уходят на свежий адрес владельца (дроп + ATA) |
| `CREATE_SOL_HEADROOM` | `adapters/src/relayer/executors.ts:87` | **0.035 SOL** + initial buy на vault | vault под create должен держать ≥0.036 SOL. Именно это задаёт минимум лота Solana |
| `BUY_SOL_HEADROOM` | `executors.ts:17` | 0.005 SOL + сумма buy | — |
| `RELAYER_NEW_MINT_RESERVE_LAMPORTS` | `adapters/src/relayer/runtime.ts:254` | 0.1 SOL | **не блокирует**: если ни у одного vault нет резерва, берётся самый богатый (`vaults.ts:166`). Фраза полного плана S3 «vault < 0.1 SOL: новый mint не закрепится» неверна |
| `UNZEEN_REBALANCE_FEE_MARGIN_ZAT` | `rebalance.rs:163` | 0.001 ZEC | на lite снизить (§3) |
| `UNZEEN_REBALANCE_KEEP_LAMPORTS` (Solana) | `rebalance.rs:127` | **0.01 SOL** остаётся на адресе ребаланса | на lite снизить до 0.001 |
| `MIN_FUND_LAMPORTS` | `adapters/src/rebalance.rs:32` | 0.01 SOL | не мешает |
| hood `FUND_STEP_WEI` (доли vault) | `adapters/src/evm/relayer/pool-state.ts:99` | 0.001 ETH, округление **вниз** | на 2 vault нужно ≥0.002 ETH к раздаче |
| hood `fundVaults` gas reserve | `pool-state.ts:139` | 2M × maxFee = 0.0004 ETH | учесть в keep |
| hood `fundStepWei` (funder→creator) | `adapters/src/evm/pons/adapter.ts:179` | **0.01 ETH, env нет** | creator получает минимум 0.01 ETH на любой create |
| hood `creatorGasReserveWei` | `adapter.ts:178` | 0.002 ETH, env нет | — |
| `HOOD_FUNDER_*_WEI` | `adapters/src/evm/funders.ts:46` | 0.02 / 0.011 / 0.005 | с правкой кода хватает 0.0026; без правки 0.0101 |
| Пороги ключей аттестаций | `adapters/scripts/attest-keys.ts:37`, `relayer-run.ts:99`, `relayer-hood.ts:83` | 0.001 SOL / 0.0002 ETH | пополнять 0.002 SOL / 0.0003 ETH |

**Блокер hood, найден по коду:** торговать на hood можно только токенами, созданными через Unzeen. `hood_price_guard` (`core/api/src/actions.rs:200`) требует строку в `tokens` со свежей ценой. На hood её пишут только `writeCreate` (`adapters/src/evm/relayer/queue.ts:310`) и `writeTokenPrices` по `mint_vaults` (`pool-state.ts:265`). Индексатора у hood нет. Купить чужой Pons-токен = `stale_price`. Отсюда вывод: **create на hood обязателен**, иначе нечего покупать. [Вывод из кода, на mainnet не проверялся.]

---

## 2. Бюджет

### 2.1 Переводы владельца
| # | Откуда → куда | L1 (с правкой кода hood) | L0 (без правок) | ≈USD L1 / L0 |
|---|---|---|---|---|
| 1 | ZODL → UA пула Solana, **без memo** (оборотный) | **0.0085 ZEC** | 0.0085 ZEC | 9.7 / 9.7 |
| 2 | ZODL → UA пула Solana, QR с memo (`/pay`, на камеру) | **0.005 ZEC** | 0.005 ZEC | 5.7 / 5.7 |
| 3 | ZODL → UA hood-пула, без memo | **0.012 ZEC** | 0.028 ZEC | 13.7 / 31.9 |
| 4 | ZODL → UA hood-пула, QR с memo | **0.004 ZEC** | 0.004 ZEC | 4.6 / 4.6 |
| 5 | внешний SOL → ключ `verify` | 0.002 SOL | 0.002 SOL | 0.2 |
| 6 | внешний ETH (4663) → ключ `attest` | 0.0003 ETH | 0.0003 ETH | 0.7 |
| | **Итого ZEC** | **0.0295 ZEC** | **0.0455 ZEC** | **33.6 / 51.8** |
| | **Итого внешний кошелёк** | 0.002 SOL + 0.0003 ETH | то же | 0.9 |

Для сравнения, полный план: 0.145 ZEC + 0.01 SOL + 0.001 ETH ≈ $178.

### 2.2 Что куда уходит (L1)
| Статья | Сумма | ≈USD | Судьба |
|---|---|---|---|
| Solana: рента create (mint, кривая, ATA кривой) | ≈0.007 SOL | 0.7 | **сгорит** |
| Solana: ALT vault под create | ≈0.006–0.010 SOL [не подтверждено] | 0.6–1.0 | **сгорит** (кода закрытия нет) |
| Solana: ATA vault ×2 (T2, T1) + аккумуляторы объёма ×2 | ≈0.0065 SOL | 0.7 | **сгорит** |
| Solana: комиссии кривой 1.25 %, сеть, tip | ≈0.001 SOL | 0.1 | **сгорит** |
| Hood: `launchFee` + газ всех tx | ≈0.0006 ETH | 1.5 | **сгорит** |
| Zcash: комиссии (4 отправки ZODL, 2 tx ребаланса на t-адрес, 2 выплаты) | ≈0.0009 ZEC | 1.0 | **сгорит** |
| 1Click спред (~0.3–0.5 % от ≈$23) | — | 0.1 | **сгорит** |
| **Сгорит всего** | | **≈$4.7–5.5** | |
| Вывод ZEC на камеру (S-вывод + H-вывод) | ≈0.0021 + 0.0026 ZEC | 5.3 | сразу возвращается владельцу |
| SOL на vault после прогона + 0.001 на адресе ребаланса | ≈0.044 SOL | 4.6 | оборотный, оператор выводит после судейства |
| ETH на hood: vault ≈0.002, остаток creator ≈0.0018, адрес ребаланса ≈0.0008, funder ≈0.0001 | ≈0.0047 ETH | 11.3 | оборотный, оператор |
| ZEC-излишек пулов (потраченный «пользователем» ZEC) | ≈0.003 + 0.0015 ZEC | 5.1 | оборотный, оператор (`send` после 22.11) |
| Свежий адрес вывода токена (дроп 0.002 SOL + ATA 0.002) | ≈0.004 SOL | 0.4 | у владельца (ATA вернётся после закрытия) |
| Под ценовым риском: половина T1 у владельца, залоченные initial buy T2/Pons | ≈0.0135 SOL + 0.0001 ETH | ≈1.7 | мемкоин |

L0 отличается только hood: +0.016 ZEC оборотного. Из них ≈0.0094 ETH останется на creator, а это деньги оператора, они не сгорают. Сгорит столько же.

---

## 3. Env-переопределения

### 3.1 `~/.unzeen/main.env` (Solana-mainnet), поверх полного плана §1.3
| Переменная | Значение | Зачем |
|---|---|---|
| `UNZEEN_REBALANCE_LOT_ZAT` | `800000` | 0.008 ZEC → ≈0.0868 SOL → по ≈0.043 на 2 vault (create требует ≥0.036, buy T1 ≥0.032). Абсолютный минимум 700000, но без запаса на курс |
| `UNZEEN_REBALANCE_MAX_LOT_ZAT` | `1000000` | кап под lite |
| `UNZEEN_REBALANCE_FEE_MARGIN_ZAT` | `30000` | ZIP-317 на t-выход ≈15000; дефолт 100000 заставил бы слать лишнее |
| `UNZEEN_REBALANCE_KEEP_LAMPORTS` | `1000000` | вместо 0.01 SOL. Рента-экзампт адреса уже вычитается в `prepare` |
| `UNZEEN_REBALANCE_MIN_FREE_LAMPORTS` | `0` | **полностью выключает автотриггер** (`free >= 0` → Enough). Значение 50000000 из примера наоборот **включает** его, как только SOL vault < 0.05, а в lite это так с первой минуты |
| `UNZEEN_REBALANCE_MAX_PER_DAY` | `1` | как было |
| `UNZEEN_ALLOW_MAINNET_REBALANCE` | `1` только на прогон | как было |
| `UNZEEN_VENUES` | `pumpfun` | LaunchLab, Meteora, Bags, Jupiter вырезаны (§4) |
| `UNZEEN_SCENARIOS`, `UNZEEN_CHAT` | не задавать | вырезано |

Не менять: `MIN_ACTION_ZAT`, `CREATE_FEE_ZAT`, `UNZEEN_CONFIRMATIONS_JITTER`, `UNZEEN_CREATOR_LOCK_SECS`, `RELAYER_NEW_MINT_RESERVE_LAMPORTS` (на lite он ни на что не влияет).

### 3.2 `~/.unzeen/hood.env`
| Переменная | L1 (с правкой) | L0 (без правки) | Зачем |
|---|---|---|---|
| `UNZEEN_REBALANCE_LOT_ZAT` | `1150000` | `2750000` | out ≈0.0054 / ≈0.0129 ETH |
| `UNZEEN_REBALANCE_MAX_LOT_ZAT` | `1500000` | `3000000` | в примере не задан (дефолт 0.5 ZEC) |
| `UNZEEN_REBALANCE_FEE_MARGIN_ZAT` | `30000` | `30000` | |
| `UNZEEN_REBALANCE_KEEP_LAMPORTS` (wei) | `3100000000000000` (0.0031) | `10600000000000000` (0.0106) | = funder target + газ перевода + 0.0004 gas reserve `fundVaults`. Раздаётся ≈0.0022 → по 0.001 на 2 vault |
| `UNZEEN_REBALANCE_MIN_FREE_LAMPORTS` | `0` | `0` | выключить автотриггер (пример ставит 0.001 ETH) |
| `HOOD_FUNDER_TARGET_WEI` | `2600000000000000` | `10100000000000000` | ровно одно пополнение creator + газ (`funders.ts:pick`: нужно `value + 100k×maxFee`) |
| `HOOD_FUNDER_LOW_WEI` | `2550000000000000` | `10050000000000000` | должно быть < target |
| `HOOD_FUNDER_LOT_WEI` | `100000000000000` | `100000000000000` | 0.0001: пополнение ровно до target |
| `HOOD_CREATOR_FUND_STEP_WEI` *(новая, §5)* | `500000000000000` | — | creator получает 0.0025 вместо 0.01 |
| `HOOD_CREATOR_GAS_RESERVE_WEI` *(новая, §5)* | `1500000000000000` | — | ≥ gasLimit create 5.5M × 0.2 gwei = 0.0011 + запас |
| `HOOD_VAULTS` / `HOOD_FUNDERS` | `2` / `1` | то же | |
| `HOOD_MAX_FEE_WEI` | не трогать (0.2 gwei) | то же | меньше 0.1 gwei кэш всё равно не опустится (`FEE_HEADROOM` 4 × base 0.02) |

Порядок денег hood L1. 1Click → `rebalance-0` (≈0.0054). `topUpOnArrival` → funder 0.0026. `fund_vaults` раздаёт 0.002 (две доли по 0.001). Create: funder → creator 0.0025, creator платит `launchFee` 0.0005 + initial buy 0.0001 + газ. Гонку «funder или fund_vaults первым» закрывает keep: при любом порядке денег хватает обоим.

### 3.3 web
`/pay` по умолчанию подставляет **0.1 ZEC**, пресеты 0.1/0.5/1 (`web/components/pay/top-up.tsx:28,94`). На съёмке сумму вводить руками (0.005 / 0.004) и сверять в ZODL перед отправкой. Если сканировать QR, не проверив сумму, уйдёт 0.1 ZEC. Опционально (frontend): пресеты для mainnet из env. Без этого обойтись можно.

---

## 4. Шаги: что оставляем, что режем

| Полный план | Lite | Сумма / примечание |
|---|---|---|
| S1 оборотный ZEC 0.040 | **оставить**, 0.0085 | не на камеру |
| S2 ребаланс ZEC→SOL | **оставить**, `rebalance plan --force --now` | лот 0.008 |
| S3 проверка vault | оставить | ожидание ≈0.043 SOL на vault |
| S4 `/key`, S5 `/pay` | **оставить**, депозит 0.005 | снимаем |
| S6 create pump.fun T2 | **оставить**, initial buy = минимум (1 шаг) | сгорит ≈$2 (рента + ALT + ATA). Без него нет сцены «dev anonymous, rules enforced», а это ядро питча |
| S7 buy T1 (чужой активный токен) | **оставить один buy 0.0025 ZEC в режиме Now** (переключатель Delayed→Now в кадре) | панель безопасности на живом токене впечатляет сильнее, чем пустой T2. Цена: +ATA и аккумулятор ≈$0.35. Дешевле вариант buy по T2, без новой ренты, но панель будет пустой |
| S8 buy T2 ради creator fee | вырезать | |
| S9 sell 50 % T1 | **оставить** | ≈0.0012 ZEC ≥ `MIN_ACTION` |
| S10 limit_buy | вырезать на mainnet (показать на devnet) | |
| S11 Jupiter | вырезать. Почти бесплатно (+0.001 ZEC, +ATA ≈$0.2), если понадобится B-roll: vault после create тянет | |
| S12a/b/c LaunchLab / Meteora / Bags | **вырезать** | каждый create ≈0.02–0.035 SOL ренты и headroom плюс partner-ключи |
| S13 сценарий | вырезать | |
| S14 smart withdraw T1 | **оставить 1 часть** (2 части: ещё ≈0.004 SOL, тоже уходят на адрес владельца, почти бесплатно) | |
| S15 withdraw ZEC | **оставить** | ≈0.0021 ZEC |
| S16–S17 sweep / claim | вырезать: объёма на claim нет | |
| S18 Verify | **оставить** | `verify` = 0.002 SOL |
| S19 stats-snapshot | по желанию | |
| H1 оборотный | **оставить**, 0.012 (L1) / 0.028 (L0) | |
| H2–H3 ребаланс + funder | **оставить** | |
| H4 ключ + `/pay` | **оставить**, 0.004 | |
| H5 create Pons | **оставить** (обязательно, иначе нечего покупать: §1.4, блокер) | initial buy = 1 шаг 0.0001 ETH |
| H6 buy + sell | **buy 0.0015 ZEC, sell 100 % купленного** | vault держит 0.001 ETH: на buy 0.0007 + газ хватает. Продажа 50 % не проходит `MIN_ACTION` |
| H7 withdraw токена | **вырезать** (продали всё). Вернуть можно так: buy 0.0025, sell 50 %, вывести остаток. Тогда раздача на vault 0.004 и лот +0.0045 ZEC (≈$5, оборотные) | |
| H8 withdraw ZEC, H9 Verify v3, H10 аудит логов | **оставить** | `attest` = 0.0003 ETH |

Время: ≈3–4 ч вместо 5–7.

---

## 5. Правка кода (только для L1; делает backend, не analyst)

**Файл `adapters/src/evm/runtime.ts:54`.** Сейчас `new PonsAdapter({ executor, keyring, funders, deployment })`: `creatorGasReserveWei` и `fundStepWei` берутся из дефолтов `adapter.ts:178–179` (0.002 / 0.01 ETH), env для них нет.

Сделать:
1. Читать `HOOD_CREATOR_FUND_STEP_WEI` (дефолт `10000000000000000`) и `HOOD_CREATOR_GAS_RESERVE_WEI` (дефолт `2000000000000000`) тем же парсером, что `weiEnv` в `funders.ts:53` (целое > 0, иначе ошибка старта). Передать в `PonsAdapter`.
2. Валидация на старте: `HOOD_CREATOR_GAS_RESERVE_WEI ≥ 5_600_000 × maxFeePerGas` (upfront-газ `launchAndBuy` при текущем пуловом кэше). Иначе отказ с понятной ошибкой: на Arbitrum tx creator отвергнется как «insufficient funds for gas * price + value».
3. Предупреждение на старте (WARN, не ошибка), если `HOOD_FUNDER_TARGET_WEI < ceilToStep(launchFee + reserve, step) + 100_000 × maxFee`: funder не сможет оплатить ни одного create.
4. Тесты: дефолты не меняются; env подхватывается; невалидные значения дают ошибку старта; `fundCreator` с шагом 0.0005 даёт 0.0025 при initial buy 0.0001.
5. Строки в `infra/deploy/env/hood.env.example` (закомментированные, с дефолтами) и одна строка в RUNBOOK.

Приватность: перевод funder → creator остаётся круглым (кратным 0.0005). Он раскрывает только «launchFee + initial buy + резерв», округлённое вверх, а initial buy и так виден в самой tx `launchAndBuy`. Новой утечки нет. Шаг должен быть единым для пула (env), а не вычисляться под каждый create. Так и есть.

Без правки (L0) всё работает, просто нужно на 0.016 ZEC больше оборотного капитала. Он не сгорает: ≈0.0094 ETH остаётся на creator, ключ у пула.

---

## 6. Риски lite
- **Курс.** Лоты рассчитаны впритык (Solana vault ≈0.043 при требовании create ≥0.036). Если ZEC/SOL упадёт больше чем на ≈10 %, поднять `UNZEEN_REBALANCE_LOT_ZAT` до 900000 и прислать без memo на 0.001 больше. Перед прогоном пересчитать: `unzeen-scanner rebalance quote` (main.env и hood.env).
- **1Click REFUNDED** на малом лоте: шилд стоит ещё ≈0.0001 ZEC, процедура из полного плана §4.2. Второй лот: `MAX_PER_DAY=2` и ещё один перевод без memo.
- **Размер ALT** не проверен. Если create упадёт с `insufficient_sol` на vault ≈0.043, значит ALT + рента > 0.043 − initial. Тогда второй лот 0.003 ZEC.
- **Автотриггер.** После прогона снять `UNZEEN_ALLOW_MAINNET_REBALANCE`. Иначе через 24 ч ребаланс может сам потратить ZEC-излишек: потраченный «пользователем» ZEC — это излишек пула, `reserve_short` его не остановит. `MIN_FREE=0` тоже страхует.
- **pump.fun T1** может выпуститься с кривой (graduate) между buy и sell. Брать токен в середине кривой.

## 7. Альтернатива (нужно согласие владельца, это отход от варианта A)
Пополнить vault напрямую с внешнего кошелька (≈0.09 SOL + ≈0.005 ETH ≈ $21) и не делать ребаланс. Тогда из ZODL уходит только 0.009 ZEC (два депозита). Плюсы: нет ожидания 1Click и нет риска refund. Минусы: публичная связь кошелька оператора с vault (vault и так публичны через Verify, к пользователям она не ведёт). Главное: пропадает история «деньги входят только как ZEC». По сумме капитала выигрыш мал, по сгоранию выигрыша нет. **Не рекомендую.**

## Открытые вопросы лиду
1. L1 (правка кода hood, ≈0.030 ZEC) или L0 (без правок, ≈0.046 ZEC)? Правка небольшая, около часа у backend с тестами, но её надо снова отдать на ревью.
2. Solana buy: чужой T1 с живой панелью безопасности (+$0.35) или T2, без новой ренты, с пустой панелью? Рекомендую T1.
3. Hood: сделка «buy → sell 100 %» без вывода токена устраивает? Вывод токена на hood: +0.0045 ZEC оборотных.
4. Пресеты `/pay` (0.1 по умолчанию): дать frontend-задачу или снимать с ручным вводом?

Источники (проверено 19.10.2026): живые `POST https://1click.chaindefuser.com/v0/quote` (dry), `GET https://api-mainnet.169-58-209-71.sslip.io/api/rates`, `eth_gasPrice`/`eth_getBlockByNumber`/`eth_call launchFee()`/`eth_getLogs` на `https://rpc.mainnet.chain.robinhood.com`, `getSignaturesForAddress`/`getTransaction` по `TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM` на `https://api.mainnet-beta.solana.com`.
