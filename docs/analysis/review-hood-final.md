# Финальное ревью: Robinhood Chain (hood, Pons V2)

Дата: 2026-10-14. Ревьюер: analyst. Код не правился.
Смотрел `adapters/src/evm/**` (HEAD `5af6f52`), core hood-инстанс (`api` / `scanner` / `ledger::verify`, `protocol/src/{evm,verify}.rs`, миграции 0028–0030), web за `NEXT_PUBLIC_HOOD`, а также API v0.21 и RELAYER v14. Юнит-тесты `adapters/test/evm` зелёные (62 passed, fork-тесты пропущены). Один временный тест подтвердил находку 1, после чего я его удалил.

## Вывод
Архитектура приватности на hood собрана правильно: свежий creator, ротация funder'ов, один vault на mint, капля газа с того же vault, единый fee-профиль, круглые суммы. Пользователь нигде не связывается со сделкой. Готовой интеграцию считать нельзя, есть две денежные ошибки. (1) Если RPC отвечает ошибкой, `lookup` принимает это за «tx не найдена», и сделка или вывод исполняется второй раз. (2) Сборщик комиссий отправляет на vault ETH пула, оставшийся на creator, и записывает его как комиссию создателя. Кроме того, Verify v3 в браузере не умеет проверять подписи EVM, а скрипта запуска hood-релейера нет.

## Находки

| # | Sev | Файл:строка | Сценарий | Фикс |
|---|---|---|---|---|
| 1 | **critical** | `adapters/src/evm/executor.ts:192-205` + `relayer/engine.ts:284-290` | `lookup()` глотает любую ошибку: 429 или таймаут на `getTransactionReceipt`/`getTransaction` дают `unknown`. Затем `getTransactionCount` проходит, и nonce оказывается занят **нашей же** tx, которая уже легла. `resolveSent` возвращает `null`, и задание исполняется заново: **двойной buy/sell/withdraw** (вывод — пользователь получает токены дважды). Публичный RPC hood отдаёт 429 из-за Cloudflare, так что сценарий реальный. Временный тест подтвердил: 429 → `unknown`. Тот же дефект в `relayer/fees.ts:97-102`: свип ложно помечается `failed`, создатель не получает зачисление. | `unknown` возвращать только на `TransactionReceiptNotFoundError` / `TransactionNotFoundError` (viem). Любая другая ошибка — исключение, и задание уходит в `retry`. Если nonce занят, перед повторным исполнением дополнительно проверить, что в блоке с этим nonce нет нашего хеша: `getTransactionReceipt` ещё раз, со второго провайдера. |
| 2 | **high** | `pons/adapter.ts:591-597`, `pons/creator.ts:173-175,204-215`, `relayer/fees.ts:47-56,119` | Creator пополняется суммой `ceil(value + 0.002 ETH, 0.01 ETH)`, поэтому после запуска на нём остаётся 0.0015–0.012 ETH **денег пула** (сюда же попадает `CurveBuyRefunded`). Сборщик считает `spare = balance − keep` «собираемым», переводит его на vault и пишет `creator_fee_sweeps.lamports`. Core зачисляет эту сумму создателю в `claimable`. Итог: пул теряет до ~0.01 ETH на каждый запуск, а при низкой комиссии запуска это прямой фарм. | В `lamports` писать только то, что пришло из escrow в этом прогоне (`claim`), плюс `curve/pool sweep`. Остаток либо оставлять на creator под газ, либо отдельной записью вне `creator_fee_sweeps` возвращать на адрес ребаланса (как в `reconcileCreator`). |
| 3 | **high** | `web/lib/verify/merkle-sum.ts:237-239,281` | Дайджест v3 браузер пересчитывает, но подпись оператора hood (EIP-191, `0x`-адрес) и подписи vault (EIP-712) проверяет как ed25519. На hood оператор получит `bad_signature`, все vault — «не подписаны», покрытие — «не доказано». То есть Verify на hood всегда красный. В mock-hood снимков Verify нет, поэтому в моках это не видно. В API.md формат подписей hood для браузера тоже не описан. | В `checkSnapshot` при `digestVersion 3`: оператор — `recoverMessageAddress({message:{raw:digest}})` и сравнение с `NEXT_PUBLIC_ATTESTATION_PUBKEY_HOOD`, vault — `verifyTypedData` с доменом `unzeen-verify/1/4663` и типом из `adapters/src/evm/attest.ts`. Добавить векторы в `core/testdata`, абзац в API.md, Verify-снимок в mock-hood. Проверить также `verify-proof.mjs`. |
| 4 | **high** (запуск) | `adapters/scripts/` (нет), `relayer/runtime.ts:101` | `runHoodRelayer` никто не вызывает: в `relayer-run.ts` hood не упоминается, отдельного скрипта нет. Живой прогон невозможен, функция есть только в тестах. | Скрипт `relayer:hood` (env `HOOD_NETWORK`, `UNZEEN_ALLOW_HOOD_MAINNET`, `DATABASE_URL_RELAYER`, проверка роли как у Solana) и `PgLaunchStore` вместо файла. |
| 5 | **medium** | `relayer/queue.ts:159,164` + `engine.ts:288` | `sentAt` берётся из `updated_at`, а его обновляет каждый claim и retry. Поэтому `now − sentAt < dropGraceMs` всегда true. Если tx записана, но так и не дошла до секвенсера (429 на `sendRaw` → stage `confirm`), задание бесконечно ждёт «tx not visible yet», пока nonce не займёт другая tx этого vault. У `create` nonce у creator одноразовый, так что запуск **висит навсегда**, а ZEC пользователя заморожен в `held`. | Хранить время записи tx отдельно: колонка `sent_at`, либо `meta.sent_at` в `reportSent`, и не трогать её при claim. |
| 6 | **medium** | `lifi.ts:86-116`, `pons/adapter.ts:819-834`, `engine.ts:349` | Calldata от LI.FI не декодируется. Проверяются только JSON-поля `toAmountMin`/`toAddress`, а реальные `receiver`/`minAmountOut` внутри `data` никто не сверяет. Подменённый ответ уводит выручку sell мимо vault. После этого `amountsKnown=false` → `retry` каждые 60 с бесконечно (не `failed`, без алерта). | Пока fallback выключен по умолчанию — оставить так и записать в модель доверия. Если включать: декодировать `swapTokensSingle*` (`_receiver`, `_minAmountOut`) по ABI Diamond. Для `amountsKnown=false` после N попыток ставить `attention`. |
| 7 | **medium** | `relayer/engine.ts:396-401`; нет hood-индексатора | `price_sol` hood-токена обновляет только релейер, и только по своим сделкам на кривой. Для пути v4/LI.FI `market = null`, при `phase != 0` пишется `"0"`. Фронт (`web/lib/trade.ts:69-74`) по нулевой цене ставит `minOut = 0`, по устаревшей — неверный `minOut`. Для graduated-токенов защиты от слиппеджа фактически нет (`LifiClient` при `minOut = 0` пропускает любой маршрут). | Перед hold квотировать сервером (`adapter.quote` → `minOut` от свежего блока). Либо core должен отклонять `buy/sell` hood с `minOut = 0` для `status = graduated`. Цену `"0"` не писать (`market = null`). |
| 8 | medium | `pons/adapter.ts:487,492,533,574,764` | Ошибка «landed but event not found» бросается **без** `stage`. `fromError` даёт `failed`, core возвращает ZEC, хотя tx легла и деньги потрачены. Маловероятно (только смена ABI/логов), но при этом теряются деньги. | Ставить `stage: "confirm", landedErr: false`, чтобы задание шло в `retry` и `resolveSent → resultFromReceipt` (`amountsKnown=false`). |
| 9 | low | `nonce.ts:38` | После `broadcast:true` кэш хранит N+1. Если tx отброшена секвенсером (рестарт), повтор в том же процессе подписывается с N+1: tx стоит за дырой, а если «призрак» N всё же ляжет, исполнятся обе. На Arbitrum это редко. | В `resolveSent` при переисполнении вызывать `nonces.reset(vault)`. |
| 10 | low | `engine.ts:103,431-454` | ETH, оставшийся на creator после упавшего запуска, возвращается только при рестарте (`reconcileLaunches`). | Вызывать reconcile и при `failed` `create`. |
| 11 | low | `withdraw.ts:139-144` | Капля газа не записывается до broadcast. Если получатель успел потратить ETH до повтора части, капля уйдёт повторно (копейки). Блокировка по `getCode` отсекает smart-кошельки и EOA с делегацией EIP-7702 (`0xef0100…`). | Принять как есть. В UI вывода: «обычный EOA-адрес». |
| 12 | low | `relayer/pool-state.ts:197-201` | Снимок Verify — один `eth_call` на (адреса × mint), где адреса включают всех creator'ов. При сотнях запусков он упрётся в gas/limit RPC, и снимок будет «late». | Разбить на чанки по одному блоку. Для creator'ов читать только ETH (токенов у них не бывает). |
| 13 | low | `scanner/src/rebalance.rs:120-122` | `min_free` на hood по умолчанию 1 ETH. При малом пуле и `UNZEEN_ALLOW_MAINNET_REBALANCE=1` ребаланс будет срабатывать по лоту 0.5 ZEC до 4 раз в сутки. | На время прогона флаг не ставить, `UNZEEN_REBALANCE_MIN_FREE_LAMPORTS` задать под реальный размер пула. |

## Приватность on-chain: какие связи появляются

| Связь | Публична? | Оценка |
|---|---|---|
| 1Click ↔ адрес ребаланса ↔ (одной tx Multicall3) все vault | да | Уровень пула, vault и так раскрыты через Verify. Доли округлены до 0.001 ETH, порядок случайный. **ок** |
| ребаланс → funder_i (лоты по 0.01, раз в 1–3 ч) → creator (ceil 0.01) → launch | да | У одного funder видно ~1/N creator'ов. Пользователь не задействован. **ок** |
| creator → vault (свип), creator → ребаланс (refund) | да | Только адреса пула. Время глобальное, 6–12 ч ± джиттер. **ок** (но см. п. 2) |
| vault → адрес вывода: капля 0.00005 ETH + transfer (две соседние tx) | да | Новой связи нет, токен всё равно идёт с этого vault. Сумма — 3 значащие цифры со срезом. **ок** |
| approve / Permit2 сразу после первой покупки | да | Момент будущей продажи не выдаёт. У LI.FI approve идёт перед sell (точная сумма), это слабее, но путь выключен. |
| Fee-профиль: `maxFee` константа, кратная 0.1 gwei, tip 0, gasLimit кратен 100k | да | Все tx пула легко кластеризуются, но vault публичны и так. Now/Delayed на цепочке не отличаются. **ок** |
| Суммы покупки: шаг 1e14 wei + срез 0–1 % (`rate.rs:217`) | — | Прошлые п. 6/7/8/9/13 в core исправлены (`mul_div`, `WEI_STEP`, NUMERIC, `unsupported_asset`). **ок** |

**Где hood хуже Solana:** (а) блок 100 мс и точные метки времени усиливают корреляцию в Now. Дефолт Delayed и предупреждение в UI обязательны. (б) Creator должен держать ETH, поэтому появляется граф funder'ов (на Solana creator только подписывает). (в) Вывод — это две tx вместо одной. (г) Секвенсер принадлежит регулируемому брокеру: санкционный скрининг — риск живучести (видит он IP сервера, а не пользователя). (д) LI.FI как третья сторона видит адрес vault и намерение до сделки. Новых связей «пользователь ↔ сделка» нет.

## Что чисто
- Hash-before-send для основной tx каждого задания. Creator одноразовый (nonce 0 + CREATE2 salt от ключа creator): двойной запуск невозможен. Advisory lock на vault + мьютекс nonce.
- `requireVault`: дефолтного vault больше нет (прошлый п. 10 закрыт). `pinned vault is not a key` → `failed`.
- `verifyDeployment` проверяет хеши кода factory/launchAndBuy/escrow и forwarder. `expectedEconomics` закреплён. Snipe-tax ожидается.
- `fund_vaults`: атомарный `aggregate3Value`, `allowFailure:false`, запрет «адрес ребаланса = vault», резерв газа.
- Verify v3: единый блок ≥ `min_slot`, `latest` — задокументированное допущение (секвенсер не реорганизует), в набор адресов `always` входят vault, funder, ребаланс, оба ключа аттестаций и creator с балансом. ETH в FeeEscrow не учитывается, но это занижение активов, а не ложный «зелёный». EIP-712: домен с chainId 4663, своя подпись у каждого адреса. Core проверяет оператора через `verify_eip191` с low-s.
- Mainnet-guard: `allowSend` только при `UNZEEN_ALLOW_HOOD_MAINNET=yes`, сверка chainId у read- и send-RPC.
- Логи и события содержат только kind и code. `sanitize` вырезает 0x-хеши из `error_message`.
- Web: hood собирается только при `NEXT_PUBLIC_HOOD=1`. Из браузера нет RPC и сторонних запросов, только ссылки на Blockscout.
- Хакатон: вход и выход — только shielded ZEC (`transfer_native` core не ставит). Вывод токенов идёт на EVM-адрес, как SPL на Solana. Fair-launch на hood отключён (`config.rs:812`). Деталей tlock/Jito в hood-UI нет. В строках снимка hood публикуется только адрес ключа `attest("fair")` — это безвредно.

## Чеклист живого mainnet-прогона (~0.02 ETH)
Предусловия: исправлены п. 1, 2, 4, 5. Платный RPC (`HOOD_RPC_URL_MAINNET`) и отдельный `HOOD_SEND_RPC_URL_MAINNET`. `vaultCount=2`, `funderCount=1`. `UNZEEN_ALLOW_MAINNET_REBALANCE` **не задан**. Лог-уровень — как в проде.
1. **Источник ETH:** ZEC → ETH(hood) через 1Click вручную, **на адрес ребаланса**. Ни в коем случае не с личного кошелька владельца (иначе пул публично связан с ним). Ключ `attest("verify")` пополнить так же, отдельным переводом, не с vault.
2. Read-only: `factoryTerms()` (узнать launchFee), `verifyDeployment()`, значение `fees.maxFeePerGas` против base fee.
3. Старт релейера. В логах: `launches reconciled`. В БД: строка `launch_curves(hood,pons)` и `pool_sol_inventory(hood)`.
4. `funders.topUp()` с маленьким target (0.005). Проверить в Blockscout: ребаланс → funder, круглая сумма, tip 0, gasLimit 100000.
5. `fund_vaults` на 0.004 ETH: одна tx Multicall3, доли по 0.001, `out_lamports` = Σ, в `trades` пусто.
6. Депозит ZEC на UA **hood-инстанса** → баланс. Депозит, подписанный под chainId Solana, → `frozen: bad_signature`.
7. Buy ~0.001 ETH существующего Pons-токена (кривая, вне snipe-окна), режим Delayed. Проверить: `status=sent` + хеш появились **до** квитанции; `lamports_in % 1e14 == 0`; `minOut > 0`; сразу следом approve с того же vault; закрепление в `mint_vaults`; строка в ленте.
8. **Краш-тест:** SIGKILL релейера сразу после `sent`, затем рестарт. Задание закрывается по квитанции, nonce vault вырос ровно на 1 (вторых tx нет). После фикса п. 1 повторить с RPC, отвечающим 429.
9. Sell половины: нового approve нет, `minWei > 0`, ZEC зачислен.
10. Вывод токенов на свежий EOA: капля 0.00005 ETH с **того же** vault, затем transfer; сумма с 3 значащими цифрами и срезом. Повтор той же части не даёт второй капли. Контрактный адрес → 400.
11. (Опционально, ≥ 0.012 ETH + launchFee) Create с первой покупкой: свежий creator, funder → creator `ceil 0.01`, `launchAndBuy` с токенами на vault, `creatorFeeRecipient = creator`, socials пустые. После свипа с низким порогом в `creator_fee_sweeps.lamports` попадает только escrow (п. 2).
12. Снимок Verify вручную: блок ≥ `min_slot`; все адреса из п. 1–5 есть в строках; EIP-712 vault и EIP-191 оператора проходят `verifyTypedData` / `recoverMessageAddress` офлайн и в `/verify` (после п. 3); calldata attest-tx равна дайджесту.
13. Вывод ZEC: shielded-выплата на UA.
14. Аудит логов релейера и core за прогон: нет `0x`-адресов, хешей, сумм, anon-ключей.

## Открытые вопросы лиду
1. Входит ли hood в сабмит? Если да, п. 1–5 блокируют, а п. 7 (graduated) проще закрыть запретом торговли graduated-токенами на hood, чем делать серверную котировку.
2. LI.FI-fallback оставить выключенным до дедлайна? (Рекомендую: да.)
3. Кто и откуда пополняет ключ аттестаций hood (нужен внешний источник ETH, не vault и не ребаланс)?

## Solana: те же классы (проверено 2026-10-14)

| Класс | Solana | Где |
|---|---|---|
| (а) Ошибка RPC = «tx не найдена» → повторное исполнение | **Нет.** `resolve()` при исключении probe ставит `st = null` и ждёт дальше. `expired` выставляется, только если статус пуст **и** finalized-высота больше `lastValidBlockHeight`. Ошибка любого из двух вызовов бросает исключение и ничего не решает. У сборщика комиссий так же: `.catch → pending/null → continue`. Остаётся теоретический риск (low): балансировщик RPC отдаёт высоту со свежего узла, а статус — с узла, отставшего больше чем на ~150 блоков. Тогда `null` + `expired` при уже легшей tx. На практике такого не ожидаю. | `relayer/engine.ts:369-380`, `tx.ts:280-298`, `relayer/fee-sweeper.ts:579,612-613` |
| (б) `sentAt` из поля, которое обновляет claim | **Поле то же, но решений на нём не принимается.** `postgres-queue.ts:317,323` так же берёт `sent_at_ms` из `updated_at`. При этом движок Solana не использует `sentAt` из строки: судьбу tx решает `lastValidBlockHeight`, а `markUsed` берёт часы новой попытки. Сейчас это безвредно, но поле вводит в заблуждение — то же исправление, что для hood (отдельная `sent_at`). | `relayer/postgres-queue.ts:317,323,355`; потребители — `engine.ts:332,558` |
| (в) Tx легла, результат не разобран → `failed` и возврат ZEC | **Нет.** `finalize`: если `ex.result` бросает исключение или вернул `null`, задание уходит в `retry` («landed, amounts not readable yet»), в `failed` никогда. У сборщика при нечитаемой сумме — `continue`. `failed` ставится только при `landed` с `err` или `expired`. | `relayer/engine.ts:399-406`, `relayer/fee-sweeper.ts:625-626` |
| (г) Сверхсуммы засчитываются как creator fee | **Нет.** На Solana creator не держит SOL пула: комиссию сети платит vault, rent-заём vault → creator остаётся на creator (`lockedRent`, E15) и в перевод не входит. В зачёт идёт `bucket + vaultAboveRent + (wallet − walletRent)`. Сверх rent на кошельке бывает только поздно накопленная комиссия. `collected()` читает именно перевод creator → vault из легшей tx. | `creator-fees.ts:375-418,618-640` |

Итог: найденные на hood классы (1), (2), (5) и (8) — специфика EVM-реализации. Из Solana перенесён только латентный `sent_at_ms = updated_at`.
