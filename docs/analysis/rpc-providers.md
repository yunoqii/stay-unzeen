# RPC-провайдеры Solana: сравнение под профиль Unzeen

Автор: analyst. День 6. Дата проверки всех фактов: **2026-10-12**. Источники в конце. **[не подтверждено]** — не удалось проверить по документации или живым запросом.

Связанные документы: `docs/analysis/token-intel.md` (метрики и схема warm set + декои), `docs/analysis/now-mode.md` (единый priority fee, без Jito для Now), `docs/STATUS.md` (решение по Helius от 12.10).

---

## TL;DR

1. **Поток всей программы pump.fun в 1,5–4 раза больше заложенного.** Замер 12.10 (`logsSubscribe` на публичном mainnet WS, 90 с + 60 с, ~19:20 UTC): **8–16M tx/сутки**, из них успешных 2,1–4,1M. Логи дают **9,4–22 ГБ/сутки**, это **5,6–13M кредитов Helius в месяц только на логи**. Оценка 1,8–5,4M не держится. При этом логов **недостаточно**: строка `Program data:` с событием есть лишь в **33–65 %** успешных tx. Для полного индекса нужны полные транзакции (Helius `transactionSubscribe` или Yellowstone gRPC). Это ещё ~5–20M кредитов в месяц, то есть **не помещается в Developer (10M) надёжно**.
2. **Индекс всей программы не делать.** Для MVP поток не нужен вовсе: лента «unzeen купил» строится из нашей БД. Для свечей и прогресса тёплых токенов хватит `accountSubscribe` на PDA `bonding_curve`: это стандартный WS, есть на всех тарифах, около 50–150 тыс. кредитов в месяц.
3. **Рекомендация до дня 9 и, скорее всего, до конца хакатона: $0/мес, два провайдера с разделением «чтение / исполнение».**
   - **Helius Free.** Только две вещи: `getPriorityFeeEstimate` фоном (accountKeys = только программы площадок) и отправка mainnet-tx через **Helius Sender, тир SWQOS-only**. Sender не тратит кредиты, 50 rps с ключом, чаевые 0,000005 SOL **на каждой tx пула, во всех режимах**.
   - **Shyft Free.** Все чтения: warm set, top-10, декои, `accountSubscribe` кривых. Безлимитные кредиты, 10 rps, mainnet + devnet. В политике прямо сказано: «we do not save the IP-addresses of requests to our blockchain nodes».
   - **Что это даёт.** Ни один провайдер не видит одновременно «что мы смотрим» и «что мы купили». Helius видит только оценки комиссий и отправки, Shyft — только чтения.
   - **Запасной вариант.** Один Helius Free с урезанной частотой снимков, ≤ 0,8M кредитов (бюджет в §4).
4. **Если владелец хочет флаговые функции** (полная лента, Dev/Whales, история дева), то **вариант B: поток только по кривым warm set**.
   - Самый простой путь: **Helius Developer $49**. `transactionSubscribe` по списку кривых — это ~0,3–3M кредитов, влезает. Код уже под Helius.
   - Дешевле в месяц и приватнее: **Triton** (gRPC по трафику, ~$16–25/мес на вариант B). Но нужен депозит **$125 в стейблкоинах** (невозвратный, на 12 месяцев) и +0,5–1 день backend на gRPC-клиент. За 1,5 месяца (хакатон + судейство до 22.11) Triton и Helius Developer стоят примерно одинаково.
   - Дешевле $49 при той же простоте ничего нет. QuickNode, Chainstack, Ankr, Syndica и Shyft Build для нас хуже или дороже (таблица ниже).
5. **Утечки данных пользователя третьей стороне нет** ни при одном варианте: все запросы к RPC идут с сервера, фронт к RPC не ходит (проверено: в `web/` нет RPC-URL). Провайдер видит **активность пула**: IP VPS, ключ аккаунта владельца, mint, которые мы читаем, подписанные tx за секунды до попадания в блок. Поэтому важны срок хранения логов и разделение чтения и отправки (§3).

---

## 1. Наш профиль нагрузки

| Компонент | Что нужно | Объём (оценка) |
|---|---|---|
| Релейер | `sendTransaction`, `getSignatureStatuses`/`signatureSubscribe`, `getLatestBlockhash`, `getAccountInfo` кривой | ~10 вызовов на действие; при 1–5 тыс. действий в месяц ≈ 50 тыс. вызовов |
| Priority fee | фоновая оценка раз в 15–30 с (now-mode N-6), accountKeys = только программы | 86–173 тыс. вызовов/мес |
| Warm set (token-intel §2) | `getAccountInfo`, `getMultipleAccounts`, `getTokenLargestAccounts` по расписанию | 0,4–1,3M вызовов/мес (50–100 токенов, 5–30 мин) |
| Декои холодного CA | пачка K=8 на тик, только при непустой очереди | 0,05–0,7M/мес |
| **Итого RPC** | | **≈ 0,6–2,2M вызовов/мес** |
| Поток, вариант «кривые warm set» | `accountSubscribe` на PDA (свечи, прогресс) **или** `transactionSubscribe`/gRPC по кривым (трейдеры, Dev/Whales) | 1,5–5 ГБ/мес (account) / ~15–150 ГБ/мес (tx) **[оценка, не замерено]** |
| Поток, вся программа `6EF8…` | полные tx без failed | **240–1000 ГБ/мес** (2,1–4,1M успешных tx/сутки × 4–8 КБ) |
| Devnet | всё то же, но поток pump.fun на devnet ~30 tx за 18 мин (замер 12.10) | пренебрежимо |

### Живой замер (12.10.2026, публичный `wss://api.mainnet-beta.solana.com`, `logsSubscribe({mentions:[6EF8…]}, confirmed)`)

| Окно | Уведомлений | Успешных | Байт | Экстраполяция в сутки | Успешных с `Program data:` |
|---|---|---|---|---|---|
| 90 с, ~19:20 UTC | 7 981 | 2 200 | 9,75 МБ | 7,7M tx / 9,4 ГБ | 725 / 2 200 = **33 %** |
| 60 с, 19:25 UTC | 11 059 | 2 841 | 15,4 МБ | 15,9M tx / 22,2 ГБ | 1 861 / 2 841 = **65 %** |

Дополнительно `getSignaturesForAddress(6EF8…)` по 5 000 подписям: 73 слота, из них 1 198 успешных. Это 15–27M tx в сутки всего и 3,5–6,5M успешных.

Ограничения замера:
- окно короткое, вечер по UTC, суточный профиль не снят;
- публичный WS мог терять сообщения;
- размер полной tx (7,7 КБ JSON) взят по 4 образцам.

**Вывод:** 70–80 % трафика программы — упавшие tx ботов. `logsSubscribe` их **не фильтрует**: фильтр `mentions` берёт ровно один ключ и не умеет `failed:false`. Helius `transactionSubscribe` и Yellowstone gRPC фильтруют упавшие tx на сервере.

---

## 2. Сравнительная таблица

Цены — на наш объём: **P1** = MVP (≈1,5M RPC-вызовов + поток по кривым warm set), **P2** = + полный поток программы (240–1000 ГБ/мес).

| Провайдер | Цена P1 | Цена P2 | RPS | Devnet | WS / gRPC | Enhanced / DAS / история | Priority fee API | Логи и приватность | Оплата | Годится на 16 дней |
|---|---|---|---|---|---|---|---|---|---|---|
| **Helius Free** | $0, если ≤ 1M кредитов (стандартный RPC = 1 кредит). На 1,5M **не влезает** → урезать частоту (§4) | — | 10 rps; `sendTransaction` 1/с (без staked); Sender 50/с с ключом, 0 кредитов | да | стандартный WS (`logsSubscribe`, `accountSubscribe`) на всех тарифах, 2 кредита за 0,1 МБ; `transactionSubscribe` — нет. LaserStream gRPC devnet: в доке кредитов «все тарифы», в доке лимитов у Free «—» (**противоречие**) | DAS 2 rps, 10 кредитов; gTFA — нет | **да**: `getPriorityFeeEstimate` 1 кредит, только mainnet (devnet — «Method not found», проверено backend 12.10) | собирает IP и «RPC method calls»; **хранит до 20 недель**; Helius Blockchain Technologies Inc., право Делавэра | USDC (ссылка на оплату / агент); карта — **[не подтверждено]** | **да, уже подключён** |
| **Helius Developer** | $49 | $49 + перерасход $5/M: оценка 7–22M кредитов → **$49–110** | 50 rps; `sendTransaction` 5/с, staked | да | `transactionSubscribe` (Enhanced WS); LaserStream gRPC только devnet | DAS 10 rps; gTFA (10 кредитов за 100 tx) | да | как Free | как Free | да |
| **Helius LaserStream mainnet** | — | Business **$499** | — | да | gRPC | — | — | как Free | — | нет (цена) |
| **Triton One** | ~$15–16/мес ($10 за 1M вызовов + $0,08/ГБ), **депозит $125** (невозвратный, 12 мес.) | + $19–80 трафик gRPC → **$35–96/мес** | общий пул: 1200 запросов / 10 с на IP; `getProgramAccounts` ниже | **да** (Mainnet, Testnet, Devnet в доке). gRPC на devnet — **[не подтверждено]** | WS (Whirligig), Yellowstone gRPC (Dragon's Mouth), Fumarole | DAS есть; gTFA нет | улучшенный `getRecentPrioritizationFees` с перцентилем | **лучшая явная политика**: на общих сервисах сбор только против абьюза, «do not identify or de-anonymize individual end-users», **хранение 4 недели**; на выделенных — режим Max Privacy (параметры не пишутся). Triton One Limited, юрисдикция не указана **[не подтверждено]** | **стейблкоины** (депозит) | да, но +0,5–1 день на gRPC-клиент (для Node нужен их клиент); отмена подписки — месяц уведомления |
| **QuickNode** | Build **$49** (80M кредитов; любой Solana-метод = **30 кредитов** → 2,7M вызовов); Free trial 10M = 333 тыс. вызовов — мало | gRPC — аддон **$499/мес** → **$548+** | 15 (trial) / 50 (Build) | да **[не подтверждено в этом проходе]** | WS — тарификация **[не подтверждено]**; gRPC — аддон | аддоны | `qn_estimatePriorityFees`, платный аддон, цена **[не подтверждено]** | IP, время доступа и т. д.; **«in general we keep your information for seven years»**; Quiknode Inc., Флорида | **крипта да** | технически да, по цене и приватности хуже |
| **Alchemy** | Free 30M CU: `getMultipleAccounts`/`getTokenLargestAccounts`/`sendTransaction` по 20 CU, `getAccountInfo` 10, `getTransaction` 40 → ≈ 27M CU, на грани; PAYG $0,45–0,525/M CU → **~$14** | gRPC $75/ТБ → **$32–89** | Free 15 rps (300 CU/с) | Free: «All mainnets & testnets» | WS по трафику 0,0002 CU/байт (дёшево); Yellowstone gRPC только PAYG | DAS; `getTransactionsForAddress` 100 CU (в таблице есть, работу не проверял) | `getPriorityFeeEstimate` 10 CU | **политика не прочитана**: редирект на SPA legal.alchemy.com **[не подтверждено]**; Alchemy Insights Inc. (Делавэр), право Калифорнии | не указано | запасной для gRPC по трафику; до прочтения политики не брать |
| **Chainstack** | Developer $0 (3M RU, **5 rps mainnet**) / Growth **$49** (20M RU, 50 rps). **`getTokenLargestAccounts` на Global-нодах = 0 rps (только выделенные)** → top-10 не посчитать | Growth $49 + Yellowstone **$49** (без лимита событий) = **$98 фикс**; WS — **1 RU за каждое уведомление** (поток программы = сотни миллионов RU) | см. слева | RPC да; **gRPC только mainnet** | WS, gRPC (≤ 200 ключей на фильтр, ≤ 5 account-фильтров) | archive 2 RU | стандартный | обрабатывает **IP, HTTP-заголовки и тело запроса**; срок «as long as necessary», не указан; Chainstack Pte Ltd, Сингапур | крипта да | нет как основной (нет top-10); gRPC $98 — запасной для P2 |
| **Shyft** | **Free $0**: безлимитные кредиты, 10 rps, 1 `sendTransaction`/с, staked; gRPC нет | Build **$199** (gRPC, 100 rps) | 10 / 100 | **да** (`devnet-rpc.shyft.to`) | WS да (лимиты WS на Free **[не подтверждено]**); gRPC с Build | свои API; DAS **[не подтверждено]** | стандартный | **«we do not save the IP-addresses of requests to our blockchain nodes»**; есть «log file 12 months» (что в нём — не уточнено); SHYFT, Бангалор, Индия | карта (Stripe), крипта через тикет | **да для чтений** (5 мин на ключ) |
| **Syndica** | — | — | — | — | — | — | — | — | — | **нет**: по Chainstack, RPC и ChainStream закрыты 14.02.2026 (первоисточник Syndica не найден) |
| **Ankr** | 500 кредитов = **$0,00005 за вызов** → 1,5M ≈ **$75** | WS: $0,00005 за **каждое** уведомление → сотни $/сутки | — | **[не подтверждено]** | WS, gRPC ($0,50/ГБ) | — | — | Ephemeral Activity Data (включая IP) удаляется **в течение 30 дней**; политика от 03.03.2023 | токен ANKR (PAYG) | нет (цена) |
| **Публичный RPC + свой индекс** | $0 | $0, но поток всей программы через публичный WS — это 10–22 ГБ/сутки на один IP, на грани лимитов | 100 запросов / 10 с на IP, 40 / 10 с на метод, 40 соединений | да (на devnet частые 429, см. STATUS) | `logsSubscribe` (только 1 ключ, без фильтра failed); полных tx нет | — | `getRecentPrioritizationFees` (минимум, часто 0) | политика оператора **[не найдена]**; Solana прямо пишет «не для продакшена» | — | только для замеров и CI |

---

## 3. Модель угроз для RPC-провайдера

**Что провайдер НЕ получает ни в одном варианте:** IP пользователя, anon-ключ, связь пользователя с действием. Все запросы идут с сервера; фронт к RPC не ходит (проверено: в `web/` нет RPC-URL, только флаги и моки). Утечки пользовательских данных третьей стороне здесь нет.

**Что провайдер получает:**

| # | Что видит | Серьёзность | Исправление |
|---|---|---|---|
| R1 | **Намерение до исполнения**: «прочитали mint X» → «отправили buy X с vault» через 30–60 с. Если чтение и отправка идут через одного провайдера, связка живёт у него в логах (у Helius до 20 недель) | **high** (уже T3 в token-intel) | Warm set по расписанию + декои (token-intel §2) **и** разные провайдеры для чтения и отправки (Shyft / Helius) |
| R2 | **Набор подписок раскрывает интерес.** Если подписка на кривую mint X появляется сразу после поиска по CA или перед покупкой, это то же намерение. Подписки WS видны провайдеру | **high** | Менять набор подписок только на границе тика, вместе с декоями. Добавление в warm set ≠ немедленная подписка |
| R3 | **Подписанная tx до попадания в блок** (секунды): может фронтранить. Через Sender SWQOS-only tx уходит в один SWQOS-путь, без Jito | medium | Слиппедж ≤ `SLIPPAGE_BPS`; для Now — единый priority fee (now-mode); Jito только для fair-launch |
| R4 | **Отпечаток в цепочке.** Sender требует чаевые на свой tip-аккаунт. Если чаевые есть только у части tx (например, только у Now), режимы различимы on-chain | **high**, если сделать выборочно | Чаевые Sender — на **всех** mainnet-tx пула одинаковой суммой, как единый priority fee (now-mode N-5) |
| R5 | **Логи по повестке или при утечке.** Логи провайдера с tx и таймингом вместе с логами провайдера VPS (IP пользователей → наш сервер) дают тайминговую корреляцию для режима Now | medium | Выбирать провайдера с коротким сроком хранения (Triton 4 недели, Ankr 30 дней, Shyft — IP не хранит, Helius 20 недель, QuickNode «7 лет»). Модель угроз Now уже в README-плане |
| R6 | **API-ключ = аккаунт владельца** (email, карта) → вся активность пула привязана к личности оператора | low (это не данные пользователя) | Оплата криптой там, где можно (Helius USDC, Triton стейблкоины); ключ в URL не логировать (`adapters/src/env.ts` уже маскирует) |
| R7 | Публичный devnet/mainnet RPC: оператор неизвестен, политики нет | low (демо) | Не использовать в продакшене; только замеры и CI |

---

## 4. Рекомендованная схема (до дня 9 и, вероятно, до сдачи)

### Вариант A (рекомендую): Helius Free + Shyft Free, $0

| Задача | Провайдер | Как | Кредиты/мес |
|---|---|---|---|
| Priority fee | Helius Free | `getPriorityFeeEstimate` раз в 15–30 с, accountKeys = программы площадок, квантование (уже `adapters/src/fees.ts`) | 86–173 тыс. |
| Отправка mainnet | Helius Sender, `?swqos_only=true` | 0 кредитов, 50/с с ключом; tip 0,000005 SOL (≈ $0,001) **на каждой tx пула** | 0 |
| Отправка devnet | Helius Free RPC (`sendTransaction`, 1/с) | Sender на devnet в доке не упомянут **[не подтверждено]**; пачку эпохи разносить ≤ 1 tx/с, порядок случайный | ~10 тыс. |
| Подтверждения, blockhash | Helius Free (вместе с отправкой) | `getSignatureStatuses` пачкой | ~30 тыс. |
| Warm set, top-10, декои, `getAccountInfo` | **Shyft Free** | 10 rps — хватает при равномерном расписании | безлимит |
| Свечи и прогресс тёплых кривых | **Shyft WS** `accountSubscribe(bonding_curve)` | резервы до и после → направление, объём, цена; трейдер неизвестен (Dev/Whales — только по флагу) | — |
| Лента «unzeen купил» | своя БД | поток не нужен | 0 |

Итого Helius ≈ 0,15–0,25M кредитов из 1M. Shyft ≈ 0,5–1,5M вызовов (безлимит).

**Перед внедрением (backend, 15 мин):**
- (1) один `getTokenLargestAccounts` на Shyft Free (тяжёлый метод, на Chainstack он вообще закрыт);
- (2) `accountSubscribe` на Shyft Free WS держится 10 мин;
- (3) отправка через Sender SWQOS-only на mainnet: tx попадает в блок; tip-аккаунт — из ответа или доки, а не захардкоженный из примера.

### Вариант A′ (запасной): только Helius Free, ≤ 0,8M кредитов
- Fee: раз в 30 с — 86 тыс.
- Warm set: 50 токенов × 3 вызова; горячие раз в 5 мин, остальные раз в 15 мин — ≈ 0,43M.
- Декои: только при непустой очереди — ≈ 0,05M.
- Релейер — ≈ 0,05M.
- `accountSubscribe` кривых (2 кредита за 0,1 МБ) — 0,05–0,15M.
- Минус: один провайдер видит и чтения, и отправки (R1).

### Если нужны флаговые функции (полная лента по токену, Dev/Whales, снайперы)
- **Helius Developer $49** с `transactionSubscribe({accountInclude: [кривые warm set], failed:false})`. Точный лимит длины списка — **[не подтверждено]**; у LaserStream указано 10M pubkeys. Около 0,3–3M кредитов — влезает. Минимум кода. Минус: сразу пропадает разделение «чтение / отправка», если чтения перевести тоже на Helius. Чтения оставить на Shyft.
- **Альтернатива: Triton** — дешевле в месяц ($16–25 на вариант B) и лучшая политика логов, но депозит $125 и gRPC-клиент. Брать, только если владелец ставит приватность логов выше сроков.
- **Поток всей программы (история дева с нуля, «seen since»)** — не брать ни у кого до сдачи. Из таблицы: Helius Developer $49–110 с риском перерасхода, Triton $35–96, Alchemy $32–89, Chainstack $98. Это Tier 3 из token-intel, режется раньше Meteora.

---

## 5. Находки (по убыванию серьёзности)

| # | Серьёзность | Где | Находка | Исправление |
|---|---|---|---|---|
| P1 | **high** | `docs/STATUS.md` (решение Helius), FEATURES п. 6 | Оценка 1,8–5,4M кредитов занижена: поток логов всей программы = 5,6–13M/мес (замер), а полные tx — ещё 5–20M. Решение «купить Developer, если замер подтвердит» для полного индекса **не подтвердится** | Индекс всей программы вырезать; флаговые функции — только поток по кривым warm set |
| P2 | **high** | будущий индексатор, `adapters/src/events.ts` (фолбэк по `Program data:`) | В логах событие есть лишь у 33–65 % успешных tx → индекс из `logsSubscribe` теряет треть-две трети сделок | Источник сделок — полные tx (`transactionSubscribe`/gRPC) или резервы через `accountSubscribe`; логи — только как подсказка |
| P3 | **high** | будущая подписка warm set | Добавление подписки на кривую в момент поиска или покупки раскрывает намерение провайдеру (R2) | Менять подписки только на тике, вместе с декоями |
| P4 | **high** | `adapters/src/relayer` (если введут Sender) | Чаевые Sender только у части tx = отпечаток режима on-chain (R4) | Одинаковый tip на всех mainnet-tx пула или не использовать Sender вовсе |
| P5 | medium | `adapters/src/config.ts:80` | `priorityFeeSource` = `helius` выбирается **по хосту RPC** (`helius-rpc.com`). При переносе чтений на другой RPC оценка молча переключится на `getRecentPrioritizationFees` (минимум, часто 0) | Отдельная переменная URL для оценки комиссии (`SOLANA_PRIORITY_FEE_URL`), независимая от основного RPC |
| P6 | medium | релейер, эпохи Delayed/Max на Helius Free | `sendTransaction` 1/с на Free: пачка эпохи из N tx получает 429 или растягивается на N секунд | Sender (50/с) на mainnet; на devnet — разнести с шагом ≥ 1 с, порядок случайный |
| P7 | medium | выбор провайдера | Chainstack: `getTokenLargestAccounts` на Global-нодах недоступен → top-10 сломается | Не брать Chainstack основным |
| P8 | low | README (модель угроз) | Не описано, что видит RPC-провайдер | Абзац: «RPC provider sees pool-level activity (server IP, mints read, signed tx), never user IPs or keys; reads and sends split across providers» |
| P9 | low | `.env.example` | Нет переменных для раздельного RPC чтения и отправки | `SOLANA_READ_RPC_URL_*`, `SOLANA_SEND_RPC_URL_*`, `SOLANA_PRIORITY_FEE_URL` (backend, по решению лида) |

---

## 6. Открытые вопросы для лида

1. Согласен ли владелец на **второго провайдера (Shyft Free)** ради разделения «чтение / отправка»? Или один Helius Free с урезанной частотой (A′)?
2. Нужны ли вообще флаговые функции (полная лента, Dev/Whales) к сдаче? Если нет, **Developer $49 не покупать**.
3. Sender SWQOS-only на mainnet: согласен ли владелец на tip 0,000005 SOL на каждой tx пула? Это не Jito, но лишний перевод в каждой tx. Альтернатива — staked `sendTransaction` только на Developer.
4. Готов ли владелец к депозиту $125 в стейблкоинах у Triton, если важнее приватность логов (4 недели против 20)?
5. Нужен ли суточный профиль потока pump.fun (замер в 2–3 точках суток публичным WS, по 5 мин)? Это уточнит P2-цены, но на рекомендацию не повлияет.

---

## Источники (проверено 2026-10-12)

**Helius.** Маркетинговые страницы `www.helius.dev/pricing` и `helius.dev/privacy-policy` из среды аналитика отдавали ECONNREFUSED или таймаут через WebFetch; `.md`-версии доков и HTML политик скачаны через curl со 2–3 попытки.
- [Credits](https://www.helius.dev/docs/billing/credits): кредиты по тарифам, цены вызовов, Sender 0, WS 2 кредита за 0,1 МБ, LaserStream mainnet с Business, Parsed Streams.
- [Rate limits](https://www.helius.dev/docs/billing/rate-limits): RPC 10/50/200/500, sendTransaction 1/5/50/100, Sender 50/с, LaserStream по тарифам.
- [LaserStream WebSocket](https://www.helius.dev/docs/rpc/websocket): стандартные методы на всех тарифах, `transactionSubscribe` с Developer, подключение 1 кредит.
- [LaserStream](https://www.helius.dev/docs/laserstream): devnet на всех тарифах, mainnet с Business.
- [Sender](https://www.helius.dev/docs/sending-transactions/sender): 0 кредитов, все тарифы, SWQOS-only tip 0,000005 SOL, Max 0,001 SOL; без ключа 1 rps.
- [Priority Fee API](https://www.helius.dev/docs/priority-fee-api).
- [Privacy Policy](https://www.helius.dev/privacy-policy), last updated 13.03.2024: IP и «RPC method calls», «retain … RPC methods for a period of up to 20 weeks».
- [Terms](https://www.helius.dev/terms-of-service), last updated 28.09.2026: право Делавэра.
- Тарифы и USDC-оплата: [helius-labs/core-ai onboarding.md](https://github.com/helius-labs/core-ai/blob/main/.agents/skills/helius/references/onboarding.md).

**Triton One.**
- [Pricing](https://triton.one/pricing): депозит $125 в стейблкоинах, $10 за 1M вызовов, $0,08/ГБ.
- [Docs (llms-full.txt)](https://docs.triton.one/llms-full.txt): разделы Data Privacy (хранение 4 недели на общих сервисах; режимы Max / Enhanced / GDPR на выделенных), Rate limits (1200 / 10 с на IP), Improved Priority Fees API, Mainnet / Testnet / Devnet.
- [Policies](https://triton.one/policies): Triton One Limited, IP собирается, срок не указан.

**QuickNode.**
- [Pricing](https://www.quicknode.com/pricing): тарифы, крипта, Solana gRPC — аддон $499.
- [API credits Solana](https://www.quicknode.com/api-credits/sol): 30 кредитов за метод.
- [Privacy](https://www.quicknode.com/privacy): «seven years», Quiknode Inc., Hallandale, FL.
- [qn_estimatePriorityFees](https://www.quicknode.com/docs/solana/qn_estimatePriorityFees): аддон.

**Alchemy.**
- [Pricing](https://www.alchemy.com/pricing): Free 30M CU, PAYG $0,525/M, gRPC.
- [Compute Unit Costs](https://www.alchemy.com/docs/reference/compute-unit-costs): Solana-методы, WS 0,0002 CU/байт, gRPC $75/ТБ.
- [legal.alchemy.com](https://legal.alchemy.com/): ToS 27.06.2025, Делавэр, право Калифорнии. Текст Privacy Notice не получен.

**Chainstack.**
- [Pricing](https://chainstack.com/pricing/).
- [Limits](https://docs.chainstack.com/docs/limits): Solana mainnet 5/50 rps, `getTokenLargestAccounts` 0 на Global.
- [Request units](https://docs.chainstack.com/docs/request-units): WS — 1 RU за уведомление.
- [Yellowstone gRPC](https://docs.chainstack.com/docs/yellowstone-grpc-geyser-plugin): $49/149/449, только mainnet, 200 ключей.
- [Privacy](https://chainstack.com/privacy/): IP, заголовки, тело запроса; Сингапур.

**Shyft.**
- [Pricing](https://shyft.to/solana-rpc-grpc-pricing): Free без лимита кредитов, 10 rps; Build $199 с gRPC; Stripe и крипта.
- [Docs (llms-full.txt)](https://docs.shyft.to/llms-full.txt): devnet-эндпоинт, WS.
- [Privacy](https://shyft.to/privacy-policy): «we do not save the IP-addresses of requests to our blockchain nodes», лог 12 мес., Бангалор.

**Syndica.** Закрытие 14.02.2026 — только по [Chainstack: switch from Syndica](https://chainstack.com/switch-from-syndica-to-chainstack/) и [гайду миграции](https://docs.chainstack.com/docs/migrating-from-syndica-to-chainstack). Первоисточник Syndica не найден (syndica.io/pricing → 404).

**Ankr.**
- [Pricing docs](https://www.ankr.com/docs/rpc-service/pricing/): Solana 500 кредитов за запрос и за WS-уведомление.
- [Privacy](https://ankr.com/privacy-policy): 30 дней, 03.03.2023.
- [IP policy blog](https://ankr.com/blog/ankrs-ip-address-policy-and-your-privacy) (2022).

**Публичный RPC.** [Solana clusters](https://solana.com/docs/references/clusters): 100 запросов / 10 с на IP, 40 на метод, 40 соединений.

**Живые замеры (аналитик, 12.10.2026, ~19:20–19:26 UTC).** Публичный `wss://api.mainnet-beta.solana.com` (`logsSubscribe`, confirmed, 90 с и 60 с) и `https://api.mainnet-beta.solana.com` (`getSignaturesForAddress` × 5 страниц, `getTransaction` × 4). Только чтение публичных данных; ключи проекта не использовались.
