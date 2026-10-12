# Token intel: панель безопасности, быстрая торговля, поиск по CA (FEATURES 6–8)

Автор: analyst. Дата проверки: **2026-10-12** (день 5). Источники в конце. Помечено **[не подтверждено]** то, что не удалось проверить по документации или живым запросом.

---

## TL;DR

1. **Почти все метрики дешёвые, если считать их из своего индекса событий pump.fun, а не из «аналитических» API Helius.** CreateEvent (`user`, `creator`, `mint`) и TradeEvent (`user`, `is_buy`, суммы, резервы) уже декодирует `adapters/src/events.ts`. Authorities, прогресс кривой, LP — это 1–2 вызова `getAccountInfo` по 1 кредиту. Top-10 — `getTokenLargestAccounts` + `getMultipleAccounts`, 2 кредита.
2. **«История дева» через DAS `getAssetsByCreator` для pump.fun НЕ работает**: Helius прямо пишет, что поле creator в DAS — это Metaplex creators, а не деплоер, поэтому для pump.fun ответ пустой. Работающие варианты: свой индекс CreateEvent или `getTransactionsForAddress(dev)`. Последний доступен с тарифа Developer, а цена в документации противоречива (от 10 до 100 кредитов). Это самая дорогая и самая неточная метрика. «Слил» — эвристика, и дев обходит её, просто переведя токены на другой кошелёк.
3. **Числовая репутация «N launches · M rugs» связывает запуски по построению.** Одинаковые цифры на A и B и их одновременный рост на +1 выдают одного автора. Рекомендация: **не делать** числовую репутацию. Вместо неё бейдж «Unzeen launch: rules enforced» с реальными ограничениями дева в реестре. Тиер с k-анонимностью — только как stretch, и на хакатоне его почти никогда не покажешь (создателей будет меньше k).
4. **Приватность.** Помимо «Helius видит интерес к mint», нашлись более серьёзные утечки:
   - **(high)** картинка и метаданные чужих токенов, загруженные фронтом напрямую с IPFS или Arweave, отдают IP пользователя и mint третьей стороне;
   - **(high)** запрос к Helius по CA прямо перед покупкой даёт сигнал для фронтрана;
   - **(medium)** `updatedAt` и различие кэш-попадания и промаха раскрывают, что другой пользователь недавно смотрел токен;
   - **(medium)** для Unzeen-запусков «доля/продажи дева» нельзя считать из реестра: это раскрыло бы сделки анонимного создателя.
5. **Сроки.** Полный объём — около 6 дней backend и около 4 дней frontend. Это не влезает в план без сдвига Meteora или fair-launch. MVP («Tier 1» ниже + поиск + пресеты + PnL) — около 2,5 дня backend и около 2,5 дня frontend.

---

## 1. Метрики: как получить, сколько стоит

### Тарифы Helius (на 12.10.2026)

| | Free / Agent | Developer $49 | Business $499 | Professional $999 |
|---|---|---|---|---|
| Кредиты в месяц | 1M | 10M | 100M (в одной таблице доков 200M, противоречие) | 200M |
| RPC rps | 10 | 50 | 200 | 500 |
| DAS / Enhanced rps | 2 | 10 | 50 | 100 |
| Enhanced WebSockets | нет | да | да | да |
| `getTransactionsForAddress` | нет | да | да | да |

Цена вызовов:
- 1 кредит: стандартный RPC (`getAccountInfo`, `getMultipleAccounts`, `getTokenLargestAccounts`, `getSignaturesForAddress`, `getTransaction`, `sendTransaction`), событие webhook.
- 10 кредитов: DAS, `getProgramAccounts`.
- 100 кредитов: Enhanced Transactions (`parseTransactions`, `/v0/addresses/{a}/transactions`), Wallet API, управление webhook.
- Стриминг (WS, Enhanced WS, LaserStream): 2 кредита за каждые 0,1 МБ.
- `getTransactionsForAddress` (gTFA): **противоречие**. По доке credits — 10 кредитов за 100 полных транзакций, signatures-режим 10. По странице метода — 100 за запрос. Закладываем 100 как худший случай.
- gTFA на devnet поддерживается, ретеншн 2 недели.

**Рекомендация:** Developer ($49) на mainnet. На devnet хватит Free, потому что активность pump.fun на devnet около 30 tx за ~18 минут (замер 12.10, ~20:57 UTC).

### Таблица метрик

| Метрика | Метод | Кредиты | Как часто | devnet | Сложность |
|---|---|---|---|---|---|
| **Mint/freeze authority** + опасные расширения Token-2022 (`permanentDelegate`, `transferHook`, `transferFeeConfig`, `defaultAccountState=frozen`, `mintCloseAuthority`, `pausable`) | `getAccountInfo(mint, jsonParsed)` | 1 | один раз; повторно каждые 30 мин, только если authority ещё не `null` | **да, проверено**: devnet-mint от `create_v2` → `mintAuthority=null`, `freezeAuthority=null`, расширения `metadataPointer`, `tokenMetadata`, `updateAuthority=null` | низкая |
| **Прогресс кривой / graduated** | `getAccountInfo(bonding_curve PDA ["bonding-curve", mint])`. `progress = 1 − real_token_reserves / Global.initial_real_token_reserves`; `complete=true` → graduated. Ещё дешевле: брать резервы из последнего TradeEvent (0 кредитов) | 1 или 0 | при каждой сделке из потока или раз в 60 с для горячих | да | низкая |
| **LP burned/locked (PumpSwap)** | После миграции: `getAccountInfo(pool)` и `getAccountInfo(pool.lp_mint)`. `burned% = 1 − lpMint.supply / pool.lp_supply` (`lp_supply` не учитывает сжигания, см. PUMP_SWAP_README). pump.fun сжигает LP при миграции по документации | 2, один раз | один раз после `complete` | да (сам PumpSwap на devnet есть) | низкая |
| **Top-10 холдеров %** | `getTokenLargestAccounts(mint)` (топ-20 token-аккаунтов) → `getMultipleAccounts(...)` → владельцы. Исключить: `associated_bonding_curve`, base-vault пула PumpSwap, `mayhem_token_vault` (mayhem-монеты), **все vault пула Unzeen** (список публичный, Verify). Делить на `token_total_supply` | 2 | горячие: 5 мин; прочие: 15–30 мин | да | средняя (метод тяжёлый на больших mint, бывают таймауты) |
| **Кто такой «дев»** (pump.fun) | `CreateEvent.user` (подписант и плательщик create, он же обычно делает первую покупку) и `CreateEvent.creator` (получатель creator fee, хранится в `BondingCurve.creator`, меняется через `set_creator`). **Дев = `user`; если `creator ≠ user`, учитываем оба.** Create-tx получаем из потока или gTFA(bonding_curve, asc, limit 1) | 0 / 10–100 один раз | один раз | да | низкая |
| **Доля дева** | Баланс ATA дева (и creator) по mint: `getMultipleAccounts` вместе с top-10 | +0–1 | как top-10 | да | низкая |
| **История дева: сколько запустил** | (a) **Свой индекс CreateEvent** по `user`: 0 кредитов, но только с момента запуска индексатора. Подпись в UI: «seen since <date>». (b) gTFA(dev, `full`, `tokenAccounts:none`, до 100 tx) → фильтр инструкций `create`/`create_v2` программы `6EF8…`: 10–100 кредитов на страницу, у серийного деплоера тысячи tx. **DAS `getAssetsByCreator` — не работает для pump.fun** | 0 или 100–1000 на дева | кэш 24 ч на дева | (a) да; (b) да, ретеншн 2 нед. | (a) низкая; (b) средняя |
| **История дева: сколько «слил»** | Эвристика: дев (`user` и `creator`) продал **≥ 50 % полученных токенов в первые 60 мин** после create. Считается из TradeEvent по `bonding_curve` этого mint: свой поток или gTFA(bonding_curve, asc, `slotLte = createSlot + ~9000`). Ограничение: перевод на другой кошелёк и продажа оттуда не ловятся. Показывать как «at least M». | 10–100 на каждый токен дева, кэш навсегда (окно закрыто) | один раз на токен | да | **высокая и дорогая**: дев с 50 запусками ≈ 5 000 кредитов |
| **Снайперы** | Покупки (TradeEvent `is_buy`) от не-дева в слотах `createSlot+1 … createSlot+N` (N = 2–5, ~1–2 с). Источник: свой поток или gTFA(bonding_curve, asc, `slotLte`). Число и доля от supply | 0 или 10–100 один раз | один раз (иммутабельно после N слотов) | да | средняя |
| **Бандлы** | Признаки: покупки не-дева **в том же слоте**, что create, и/или tx с переводом на один из 8 tip-аккаунтов Jito (`getTipAccounts`) рядом с create. Факт бандла on-chain не записывается, распознавание только эвристикой. Публичный Jito bundles explorer API — **[не подтверждено]**, и это лишний третий сервис: не использовать | 0 (из тех же данных) | один раз | Jito на devnet — **[не подтверждено]**, для демо достаточно эвристики по слоту | средняя |
| **Соцсети** | `uri` из Token-2022 `tokenMetadata` (уже есть в `getAccountInfo` mint) или Metaplex metadata (legacy `create`) → **сервер** скачивает JSON (`twitter`, `telegram`, `website`). Альтернатива: DAS `getAsset` (10 кредитов), тогда JSON скачивает Helius и SSRF у нас нет | 0 или 10 | один раз (uri pump.fun неизменяем, `updateAuthority=null`) | да (на devnet встречаются uri вида `http://localhost:…`, нужна обработка) | низкая + SSRF-защита |
| **Meteora DBC** | Состояние пула (`quoteReserve` против порога миграции из конфига), LP lock из конфига (`creatorLockedLpPercentage` / `partnerLockedLpPercentage`) | 1–2 | как у pump | SDK есть, **[не проверено в этом проходе]** | средняя |

### Свой индекс против опроса по каждому mint

- **Вариант A: свой поток по программе pump.fun.** Enhanced WS `transactionSubscribe({accountInclude:[6EF8…]})`.
  - События pump — это `emit_cpi`, они лежат во inner instructions. Обычного `logsSubscribe` мало: в `events.ts` фолбэк по `Program data:` есть, но на него нельзя рассчитывать, нужен полный tx.
  - Цена: 2 кредита за 0,1 МБ. **Объём pump.fun на mainnet не измерен.** При 1M tx/сутки × ~3 КБ выходит около 60 тыс. кредитов в сутки (~1,8M в месяц); при 3M tx — около 5,4M в месяц, это на грани Developer.
  - Даёт бесплатно: дев, снайперы, бандлы, прогресс, лента по токену с фильтрами Whales/Dev, историю дева «since <date>».
- **Вариант B (MVP, рекомендую): поток только по `bonding_curve` PDA нужных токенов.** Нужные — это токены из ленты, горячие, торговавшиеся через Unzeen и искавшиеся по CA. В остальном — разовые снимки по таблице выше.
  - Enhanced WS принимает в `accountInclude` большой список адресов; точный лимит — **[не подтверждено]**.
  - На devnet хватает опроса `getSignaturesForAddress(6EF8…)` раз в 10 с + `getTransaction` по 1 кредиту.

**Перед решением:** 10-минутный замер объёма Enhanced WS по `6EF8…` на mainnet (день 6, 5 минут работы backend).

### Упрощения дорогих метрик
1. **История дева.** Только «launches seen by Unzeen: N» из своего индекса, без gTFA по кошельку дева. Пометка «rugs» — только для токенов, у которых мы видели первые 60 мин.
2. **Rug.** Одно правило (≥ 50 % за 60 мин). Никаких кластеров «кошельки, профинансированные девом»: это граф по funding-tx, сотни кредитов на токен.
3. **Бандлы.** «Buys in creation slot: K wallets, X % supply» без попытки доказать Jito.
4. **LP.** Для pump.fun после миграции: проверить один раз и закэшировать навсегда.
5. **Top-10.** Обновлять только для горячих, для остальных показывать возраст снимка, округлённый до 5 мин.

### Особый случай: токены, запущенные через Unzeen
- On-chain дев — свежий creator-адрес пула. Он не торгует, поэтому доля дева 0 %, история — 1 запуск.
- **Не подменять это данными реестра.** Доля и продажи анонимного создателя в реестре — это его приватные сделки (critical, см. ниже).
- Vault пула в top-10 показывать отдельной строкой: «Unzeen pool vault — X % (shared by all unzeen holders)». В концентрацию не включать.
- Наш атомарный `create + buy` и fair-launch через Jito попадут под «бандл / покупка в слоте create». Пометить «unzeen launch buy (by design)», а не «bundle».

---

## 2. Схема приватности для чтения рыночных данных

### Модель угроз
- **Helius и любой, кто получит его логи или наш API-ключ.** Видит поток запросов нашего сервера: «mint X запрошен в t», затем `sendTransaction` buy X с vault в t+40 с. Пользователя он не знает, но получает **сигнал намерения до исполнения** (фронтран, копитрейд) и **связку «тот, кто искал, тот и купил»**.
- **Сетевой наблюдатель** (провайдер VPS или пользователя). Видит IP пользователя → наш сервер в t и наш сервер → Helius в t+δ. Mint под TLS не виден, но по совпадению времени и размеров ответа можно связать сессию с конкретным исходящим запросом.
- **Другие пользователи Unzeen.** Через кэш-тайминги и поля «обновлено в» узнают, что кто-то недавно смотрел токен.
- **Хост из `uri` метаданных** (контролирует автор токена). Если сервер скачивает `uri` по запросу пользователя, автор узнаёт: «пользователь Unzeen открыл мой токен в t».

### Схема

1. **Тёплое множество (warm set).**
   - Состав: токены ленты, горячие, все токены с позициями пула, все Unzeen-запуски, все mint из CA-поиска за 7 дней.
   - Обновление — **по фиксированному расписанию, независимо от просмотров**. Снимки top-10, authorities и прогресса — каждые 5 мин горячим, 30 мин остальным. Порядок внутри цикла перемешивается.
   - Просмотр страницы **не** ускоряет обновление (иначе частота запросов выдаёт популярность у наших юзеров).
2. **Холодный CA (неизвестный mint).**
   - `GET /api/tokens/:mint/safety` кладёт mint в очередь и отвечает `202 {status:"pending", retryAfterMs}`.
   - Очередь разбирается **пачкой на границе фиксированного тика** (60 с ± джиттер 0–15 с, тик не зависит от запросов).
   - Каждая пачка **добивается декоями до фиксированного размера K = 8**. Декои — случайные mint из свежих CreateEvent и из warm set.
   - На Helius уходит один `getMultipleAccounts` по всей пачке (mint + bonding_curve; до 100 аккаунтов за 1 кредит), затем `getTokenLargestAccounts` по каждому mint пачки, включая декои.
   - Цена декоев на mainnet: ~2 кредита × 8 × 1440 тиков ≈ 23 тыс. кредитов в сутки в худшем случае (если очередь не пуста каждый тик). Пустой тик ничего не шлёт.
   - Для mint, ставшего Unzeen-позицией, данные по нему уже есть в warm set, поэтому покупка по сети не выглядит как «запрос → покупка».
3. **Одинаковые ответы всем.**
   - Публичные эндпоинты без подписи, без cookies, без `x-unzeen-pubkey`.
   - `Cache-Control: public, max-age=60`. В ответе нет ничего персонального, в том числе «you hold».
   - `asOf` округляется до границы тика (минимум 1 мин) и **не раскрывает момент первого запроса**.
4. **Против кэш-проб.**
   - Холодный mint, впервые попавший в очередь, остаётся в `pending` до тика у **всех** запрашивающих.
   - Второй пользователь в том же окне видит ровно то же `pending` и тот же `retryAfterMs` до тика, а не «уже готово». Так нельзя отличить «я первый» от «кто-то искал минуту назад».
5. **Метаданные и картинки чужих токенов.**
   - Сервер скачивает `uri` **при попадании mint в warm set или в пачку тика**, а не по клику.
   - Защита: только `https://` и `ipfs://`; IPFS переписывается на один выбранный нами шлюз. Таймаут 3 с, ≤ 64 КБ JSON, без редиректов на приватные адреса, запрет RFC1918, loopback, link-local и `169.254.169.254`, повторная проверка IP после DNS.
   - Картинку **перекодировать тем же пайплайном**, что `adapters/src/metadata.ts` (без SVG, ≤ 512 КиБ), и отдавать через наш `/media/<sha40>.<ext>`.
   - **Фронт никогда не грузит `image` и `uri` напрямую** (high: IP пользователя + mint у IPFS-гейтвея или Arweave).
6. **Соцсети.**
   - Отдавать только нормализованные ссылки (`https`, домены x.com/twitter.com, t.me, произвольный `website` как текст + домен).
   - Без превью, OG-картинок и favicon (это сторонние запросы).
   - Ссылки с `rel="noopener noreferrer"` и `referrerPolicy="no-referrer"`, плюс глобальный `Referrer-Policy: no-referrer`. Перед переходом — диалог «You are leaving unzeen».
7. **Поиск по CA (фронт).**
   - Запрос только по submit или по paste валидного base58 длиной 32 байта, без запросов на каждое нажатие клавиши.
   - Свободный текстовый поиск (по тикеру) — только клиентский, по уже загруженному списку `/api/tokens`. На сервер текст не уходит.
8. **Логи.** Никаких логов mint из `/safety` и `/search` (access-логи выключены по ARCHITECTURE). Очередь холодных mint — в памяти, не в Postgres, без привязки к IP.
9. **В README** честно описать остаточный риск: Helius видит наш поток запросов. Декои и расписание размывают связку «поиск → покупка», но не устраняют её полностью. Для Max privacy полезно, что эпоха 5–15 мин длиннее тика.

---

## 3. Opt-in репутация анонимного создателя: рекомендация

**Суть проблемы.** Репутация — это и есть связывание: «у этого создателя 5 запусков» имеет смысл только потому, что эти 5 запусков объявлены одним лицом. Любой показ на токене A и токене B атрибута, уникального для создателя, связывает A и B. Конкретные каналы:
- **одинаковые цифры** «5 launches · 1 rug» на A и B;
- **синхронные изменения**: в момент запуска C счётчики на A и B становятся 6 — значит, C того же автора; когда A «рагнул», M растёт на B;
- **малое множество анонимности**: на хакатоне Unzeen-создателей единицы, поэтому любой тиер вроде «Veteran» уникален;
- **сам источник «rugs»** — это продажи создателя в реестре, то есть его приватные сделки. Даже в агрегате это раскрытие (допустимо только с согласия).

**Варианты:**

| Вариант | Связывание | Полезность | Вывод |
|---|---|---|---|
| Точные N · M | полное + тайминговое | высокая | **нет** |
| Округлённые агрегаты (1, 2–4, 5–9, 10+) | частичное; переходы между корзинами всё равно связывают | средняя | слабо |
| Тиер (new / established / veteran) + **k-анонимность** (тиер показывается, только если в нём ≥ k = 5 opt-in создателей) + **обновление раз в сутки** + **opt-in на каждый запуск** с предупреждением «Enabling this publicly links all launches where you enable it» | только «один из ≥ k» | низкая–средняя | допустимо как stretch, но на хакатоне < k создателей, бейдж не появится |
| Только «Unzeen launch: dev anonymous, rules enforced» с **реальными правилами в реестре** (лок на продажу и вывод токенов создателя из initial buy на T часов; кап initial buy ≤ X % supply; creator fees только через глобальный claim) | нет | **выше, чем у репутации**: гарантия на этот токен, а не обещание по истории | **делать** |
| ZK-доказательство «я создатель ≥ N токенов без рага» | нет | высокая | вне сроков, в roadmap |

**Рекомендация:** числовую репутацию **не делать** (вырезать первой). Делать бейдж «rules enforced» и перечислить правила на странице токена. Это совместимо с моделью доверия (оператор исполняет правила в реестре) и лучше продаётся судьям Private Markets: «доверие без деанонимизации». В README — roadmap: «k-anonymous creator tiers / ZK reputation».

Если владелец всё же хочет репутацию, минимальные условия:
- opt-in на каждый запуск, по умолчанию выключен;
- тиер вместо чисел;
- k ≥ 5;
- суточное обновление;
- никакого списка токенов;
- UI-предупреждение о связывании;
- анализ этого перед мержем.

---

## 4. PnL и маркеры в браузере

**Источник данных.**
- Фронт хранит `id` своих действий в момент `POST /api/actions` и опрашивает `GET /api/actions/:id`.
- При `executed` сохраняет `fill` (`tokenAmount`, `solAmount`, `zecSpent`/`zecCredited`), `rate`, `ts` исполнения и, по желанию, `solanaTx`.
- Цена для нереализованного PnL берётся из публичного `Token.priceSol` и `PoolInfo.rate` (запросы, которые делают все).
- Средняя цена входа — по средневзвешенной в ZEC (`zecSpent / tokenAmount`). `withdraw_token` уменьшает позицию по себестоимости.

**Риски:**

| Риск | Серьёзность | Исправление |
|---|---|---|
| D1: `fill` и `solanaTx` стираются на сервере через 24–48 ч. Если вкладка закрыта до исполнения (особенно Max privacy) и пользователь не вернётся 48 ч, история неполна | medium (UX) | Сохранять `id` сразу; при восстановлении — «PnL incomplete: N actions expired». **Не** хранить себестоимость на сервере: это была бы долгоживущая история сделок |
| История сделок в `localStorage` открытым текстом: доступна при изъятии устройства, расширениям, при XSS | high | IndexedDB, шифрование тем же ключом, что anon-ключ (AES-GCM от пароля), раздельно по сети. Без пароля PnL не показывается |
| `solanaTx` локально связывает устройство с конкретной on-chain tx | medium | Не хранить `solanaTx` по умолчанию (для PnL не нужен); показывать ссылку только пока она есть на сервере |
| Перенос на другое устройство | low | Только зашифрованный экспорт и импорт файлом. **Никакой синхронизации через сервер** |
| Маркеры на графике видны при демонстрации экрана или на скриншоте | low | Маркеры и PnL размыты по умолчанию, как балансы («Peek») |
| Соблазн отправить «мои сделки» на сервер для отрисовки или подсчёта | high, если случится | Правило в FRONTEND.md: PnL и маркеры считаются только локально, запросов с данными позиции нет |
| Опрос `/api/actions/:id` в момент `executed` | low | Сервер и так знает автора действия. Интервал опроса сделать фиксированным, без ускорения у границы эпохи |

**Фильтр ленты токена «Dev» и «Whales».**
- Требует показывать **все** сделки по mint, не только unzeen. Нужен поток по `bonding_curve` (вариант B) и расширение `FeedEvent`.
- Для Unzeen-запусков пометка «Dev» **никогда** не ставится на сделки vault: vault общий, а различать в нём создателя — значит раскрыть его.
- Фильтр «unzeen» работает на текущих данных, без нового индекса.

---

## 5. Черновик эндпоинтов для API.md (API.md не правил)

Все эндпоинты публичные: без подписи, без cookies, `Cache-Control: public, max-age=60`, без логов. Ответ одинаков для всех.

```ts
// GET /api/tokens/:mint/safety
// 200 — готово; 202 — {status:"pending", retryAfterMs} (холодный mint в очереди тика);
// 400 bad_request — не base58 32 байта; 404 not_found — аккаунта mint нет в сети.
interface TokenSafety {
  mint: string;
  asOf: number;                 // unix мс, округлено до границы тика (≥ 1 мин), не время первого запроса
  program: "spl-token" | "token-2022";
  authorities: {
    mintRevoked: boolean;
    freezeRevoked: boolean;
    metadataImmutable: boolean | null;     // updateAuthority == null
    riskyExtensions: ("permanentDelegate" | "transferHook" | "transferFee" | "defaultFrozen" | "mintClose" | "pausable")[];
  };
  holders?: {                   // нет поля — снимка ещё нет
    top10Pct: string;           // десятичная строка %, без кривой, пула AMM, vault Unzeen
    devPct: string | null;      // null для Unzeen-запусков (дев анонимен) и если дев неизвестен
    unzeenPoolPct: string;      // доля всех vault пула (общий инвентарь)
    asOf: number;
  };
  dev?: {                       // нет для Unzeen-запусков
    address: string;            // CreateEvent.user (публичный on-chain)
    launchesSeen: number;       // по нашему индексу
    rugsSeen: number;           // «продал ≥50% за 60 мин», нижняя оценка
    since: number;              // с какого момента индекс
  };
  firstBlocks?: {               // считается один раз после createSlot+N
    snipers: number; sniperPct: string;           // покупки не-дева в слотах +1..+N
    sameSlotBuyers: number; sameSlotPct: string;  // покупки в слоте create (бандл-подобные), без нашей launch-покупки
    unzeenLaunchBuy: boolean;                     // атомарный create+buy / fair-launch Unzeen
  };
  market: {
    venue: Venue; status: "curve" | "graduated";
    curveProgressPct?: string;  // только на кривой
    lpBurnedPct?: string;       // после миграции (PumpSwap / DAMM)
  };
  socials?: { twitter?: string; telegram?: string; website?: string };  // нормализованные https-ссылки
  image?: string;               // только наш /media/<sha40>.<ext>, никогда внешний URL
  unzeen?: {                    // только для запусков через Unzeen
    launch: true;
    rules: string[];            // ["creator_initial_buy_locked_24h", "initial_buy_cap_5pct", ...]
    // creatorTier — только если решат делать (см. §3); k-анонимность ≥5, суточное обновление
  };
}

// GET /api/tokens/:mint — уже есть. Для неизвестного mint: тот же 202 pending + постановка в очередь
// (вместо 404), чтобы поиск по CA работал одной страницей.

// GET /api/tokens/:mint/trades?filter=all|unzeen|whales|dev&before=&limit=
// Тип ответа — TokenTrade:
interface TokenTrade extends FeedEvent {
  trader: string | "unzeen";    // публичный адрес для чужих сделок, "unzeen" для vault пула
  tags: ("whale" | "dev" | "sniper")[];   // "dev" никогда не ставится на сделки vault
}
// whale: solAmount ≥ max(1 SOL, 1% curve liquidity) — порог фиксированный, публичный.

// WS /ws/feed?mint= — без изменений. Для all-trades: /ws/trades?mint= с TokenTrade.
```

Поиск по CA отдельным эндпоинтом не нужен: фронт валидирует base58 и делает переход на `/token/<mint>`.

---

## 6. Трудозатраты и что резать

### Backend (дни)

| Блок | Полный | MVP |
|---|---|---|
| Tier 1: authorities + Token-2022 расширения, прогресс, graduated, LP, top-10 и доля дева, исключения vault | 1,5 | 1 |
| Метаданные: фетч `uri` с SSRF-защитой, прокси и перекодирование картинок в `/media`, соцсети | 0,5 | 0,5 |
| Warm set + планировщик, очередь холодных CA с тиком и декоями, публичный `/safety`, 202 pending | 1 | 0,75 |
| Поток по `bonding_curve` (вариант B) + таблица trades по mint, `TokenTrade`, фильтры | 1,5 | — |
| Первые блоки: снайперы, покупки в слоте create | 0,75 | 0,25 (из потока или gTFA один раз) |
| История дева + эвристика rug | 1,5 | — |
| Репутация / тиер | 0,5 | — |
| **Итого** | **≈ 6–7** | **≈ 2,5** |

### Frontend (дни)

| Блок | Полный | MVP |
|---|---|---|
| Панель «Token safety» (+ состояние pending, бейдж Unzeen launch) | 1 | 0,75 |
| Пресеты Buy/Sell, настройки слиппеджа и приоритета | 0,5 | 0,5 |
| Локальная зашифрованная история действий, PnL, avg entry, маркеры lightweight-charts, Peek | 1,5 | 1 |
| Лента сделок токена с фильтрами | 0,5 | 0 (только «unzeen», уже есть) |
| CA-поиск в шапке (валидация, без запросов по нажатию клавиш) | 0,25 | 0,25 |
| **Итого** | **≈ 4** | **≈ 2,5** |

### Порядок урезания внутри фич 6–8
1. Числовая репутация создателя (рекомендую не делать вовсе).
2. «Rugs» в истории дева.
3. История дева целиком (оставить только адрес дева и его долю).
4. Фильтры Whales/Dev и лента всех сделок (оставить «unzeen»).
5. Бандлы (оставить снайперов как «buys in first N slots»).
6. LP burned для Meteora (для pump.fun оставить).

**Не резать:** authorities + Token-2022 расширения, top-10 и доля дева, прогресс и graduated, соцсети через прокси, CA-поиск, пресеты, PnL локально.

**Относительно общего порядка урезания из CLAUDE.md.** Tier 2–3 этих фич надо резать **раньше Meteora**. Судьи трека Private Markets увидят в safety-панели «как у Axiom/GMGN», а не инновацию. Инновация здесь — приватный доступ к рыночным данным (тик + декои, без связи с anon-ключом) и «rules enforced» вместо репутации. Это стоит показать в README и видео.

---

## Находки по серьёзности

| # | Серьёзность | Где | Находка | Исправление |
|---|---|---|---|---|
| T1 | **critical** | FEATURES.md п. 6 («доля дева», «история дева») для Unzeen-запусков | Если считать долю, продажи или «раги» анонимного создателя из реестра, раскрываются его приватные сделки (дисквалифицирующая утечка) | Для Unzeen-запусков `devPct = null`, `dev` отсутствует; репутация только opt-in тиером (§3) или не делать |
| T2 | **high** | будущий `web/` (страница токена для произвольного CA) | Загрузка `image`/`uri` чужого токена напрямую с IPFS/Arweave/хоста автора раскрывает IP пользователя и mint третьей стороне | Сервер скачивает и перекодирует, фронт берёт только `/media/<sha40>` |
| T3 | **high** | будущий `/safety` | Синхронный запрос к Helius по клику даёт Helius сигнал «поиск → покупка через 30–60 с» (фронтран, связка) | Тик с джиттером + декои до K=8 + warm set по расписанию (§2) |
| T4 | **high** | PnL на фронте | История сделок открытым текстом в `localStorage` | IndexedDB + AES-GCM ключом от пароля, раздельно по сети |
| T5 | **medium** | будущий `/safety` | `asOf`, равный моменту первого запроса, и различие кэш-попадания и промаха раскрывают чужой интерес к токену | Округлять `asOf` до тика, держать `pending` до тика для всех |
| T6 | **medium** | сервер, фетч `uri` | SSRF через `uri` метаданных (контролирует автор токена); фетч по клику уведомляет автора о просмотре | Фетч только по расписанию; https/ipfs, блок приватных IP, 64 КБ, 3 с, без редиректов; или DAS `getAsset` |
| T7 | **medium** | FEATURES.md п. 6 «история дева (Helius)» | DAS `getAssetsByCreator` пуст для pump.fun, план через него не сработает | Свой индекс CreateEvent (`user`) или gTFA (Developer-план) |
| T8 | **medium** | эвристика снайперов и бандлов | Наш атомарный create+buy и fair-launch через Jito будут помечены как «бандл» | Исключать vault пула, флаг `unzeenLaunchBuy` |
| T9 | low | соцсети | Переход по ссылке отдаёт Referer со страницей токена | `Referrer-Policy: no-referrer`, `rel="noopener noreferrer"`, без превью |
| T10 | low | `getTokenLargestAccounts` | Возвращает token-аккаунты, а не владельцев; тяжёлый на больших mint | `getMultipleAccounts` для владельцев, таймаут и повтор, кэш |

---

## Открытые вопросы для лида
1. Какой тариф Helius на mainnet? Developer ($49) нужен для gTFA и Enhanced WS. Без него — только вариант «свой индекс с момента запуска», плюс опрос.
2. Какие именно правила стоят за «rules enforced»? Предлагаю: лок токенов initial buy создателя на 24 ч, кап initial buy ≤ 5 % supply, creator fees только через глобальный claim. Это изменение реестра (backend) и API.md.
3. Согласен ли владелец **убрать** числовую репутацию из FEATURES п. 6 (заменить на «rules enforced» + roadmap)?
4. Порог rug (≥ 50 % за 60 мин) и порог whale — утвердить или вырезать историю дева целиком?
5. Показывать ли все сделки по токену (нужен поток, +1,5 дня backend) или только сделки unzeen?
6. Перед выбором варианта A/B — разрешить backend 10-минутный замер объёма потока pump.fun на mainnet (день 6).

---

## Источники (проверено 2026-10-12)
- Helius, тарифы и цены кредитов: [Helius Pricing](https://www.helius.dev/pricing), [Plans](https://www.helius.dev/docs/billing/plans), [Credits](https://www.helius.dev/docs/billing/credits); таблица тарифов и цены кредитов также в официальном репозитории Helius [helius-labs/core-ai `.agents/skills/helius/references/onboarding.md`](https://github.com/helius-labs/core-ai/blob/main/.agents/skills/helius/references/onboarding.md). Сайт helius.dev был недоступен из среды аналитика (ECONNREFUSED), цифры сверены по выдаче поиска и по этому репозиторию.
- DAS (10 кредитов; `getAssetsByCreator` не работает для pump.fun): [core-ai das.md](https://github.com/helius-labs/core-ai/blob/main/.agents/skills/helius/references/das.md), инструмент `getPumpFunGuide` в [core-ai helius-mcp/src/tools/guides.ts](https://github.com/helius-labs/core-ai/blob/main/helius-mcp/src/tools/guides.ts).
- Enhanced Transactions (100 кредитов, legacy): [core-ai enhanced-transactions.md](https://github.com/helius-labs/core-ai/blob/main/.agents/skills/helius/references/enhanced-transactions.md), [Enhanced Transactions overview](https://www.helius.dev/docs/api-reference/enhanced-transactions/overview).
- getTransactionsForAddress (Developer+, devnet с ретеншном 2 недели, цена противоречива): [gTFA docs](https://www.helius.dev/docs/rpc/gettransactionsforaddress), [анонс в блоге](https://www.helius.dev/blog/introducing-gettransactionsforaddress).
- Webhooks (1 кредит за событие), WebSockets (2 кредита за 0,1 МБ), devnet WS endpoint: [core-ai webhooks.md / websockets.md](https://github.com/helius-labs/core-ai/tree/main/.agents/skills/helius/references).
- pump.fun: BondingCurve, `complete`, `creator`, CreateEvent и TradeEvent (IDL), `create_v2` (Token-2022, mint_authority PDA), PumpSwap `lp_supply` и сжигание LP, synthetic migration: [pump-fun/pump-public-docs](https://github.com/pump-fun/pump-public-docs) (`docs/PUMP_PROGRAM_README.md`, `docs/instructions/COIN_CREATION.md`, `docs/PUMP_SWAP_README.md`, `docs/SYNTHETIC_MIGRATION.md`, `idl/pump.json`).
- Живые проверки (devnet, 12.10 ~20:57 UTC, публичный `api.devnet.solana.com`): `getSignaturesForAddress(6EF8…)` дал 30 tx за ~2 700 слотов; create_v2 `NuzHEUs2…` → mint `2pYxXseqGTcBSKL5MtoXW7u86p2KAUs6b8r523Rwbp4T`, `mintAuthority=null`, `freezeAuthority=null`, расширения `metadataPointer`, `tokenMetadata`, `updateAuthority=null`.
- Devnet-хосты DAS и Enhanced API у Helius: в официальной документации не найдено, сторонний SDK указывает `api-devnet.helius.xyz/v0` для Enhanced REST — **[не подтверждено]**, проверить с devnet-ключом.
