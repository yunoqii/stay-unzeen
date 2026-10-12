# Правила ZECATHON и что из них следует для Unzeen

Автор: analyst. Дата проверки: **2026-10-12**.
Источник: на thezecathon.com правила видны только после входа, но весь контент сайта лежит в публичном файле `https://thezecathon.com/darkpool/data.js` (комментарий в файле: «Everything a non-developer should be able to edit lives here. os.js reads this and renders; it invents nothing»). Поля формы сабмита взяты из `https://thezecathon.com/darkpool/forms.js`. **Лиду: один раз сверить с тем, что показывается внутри аккаунта.** В `data.js` у разбивки призов стоит пометка «PLACEHOLDER SPLIT… the division is my proposal».

---

## TL;DR

**Блокеров нет, трек выбран верно.** Главное:

1. **«Leaks are disqualifying, not deductions.»** Любая утечка, связывающая пользователя со сделкой, — это не минус баллы, а вылет. Аудит приватности (дни 13–14) должен быть жёстким, а в README нужно честно разделить, что приватно, а что держится на доверии к оператору.
2. **Сабмит требует И рабочий демо-URL, И 2-минутное видео** (в форме оба поля `req:true`). Описание до 2000 символов, причём сайт просит прямо: «What it does, why it does not leak, what is real and what is a mock».
3. **Окно сборки — 28.09–28.10.2026** (30 дней). Наш первый коммит от 12.10 в него укладывается. Нельзя брать за основу готовый продукт: форк Meteora «fun-launch» scaffold, чужой лаунчпад и т. п.
4. **Лицензия правилами не требуется явно**, но нужен «Open source at submission» → добавить `LICENSE` (MIT или Apache-2.0). Сейчас в корне репо его **нет**.
5. **Mainnet правилами не запрещён и не требуется.** Критерий «Does it run. Working beats ambitious.» и требование «Something the judges can open and use» говорят в пользу демо, которое судьи могут пройти сами, то есть testnet/devnet.
6. **Private Markets подходит идеально** («the price should be public and the participants should not»). Cross-Chain — плохой выбор: там требуется «without unshielding on the way through», а NEAR Intents принимает только transparent ZEC.

---

## 1. Ключевые требования — дословно

**Сроки** (`data.js → dates`):
- «Registration opens — Sep 28, 2026», «Submissions open — Sep 28, 2026»
- «Submissions due — **Oct 28, 2026 · 23:59 UTC**»
- «Judges revealed — Oct 29, 2026», «Judging — Oct 29 – Nov 22, 2026», «Winners announced — Nov 23, 2026»

**Rules** (`data.js → rules`), дословно:
1. «One person registers and submits. The prize goes to that account; build with anyone.»
2. «**All code written during the build window. Libraries are fine; existing products are not.**»
3. «**Open source at submission. A private repo made public on Oct 28 counts.**»
4. «**One submission per account, entered in exactly one track.**»
5. «Submissions stay sealed until judging opens. You can edit yours until the deadline.»
6. «Organisers and judges cannot enter.»

**Judging criteria** (`data.js → criteria`), дословно:
- **Privacy** — «Does it actually preserve privacy, or does it only look like it does? **Leaks are disqualifying, not deductions.**»
- **Usefulness** — «Would someone use this on Monday.»
- **Execution** — «Does it run. **Working beats ambitious.**»
- **Originality** — «Built for this hackathon, not repackaged.»

**Трек Private Markets** — «$15,000». «The dark-pool thesis. Sealed-bid auctions, order flow, settlement, anything where the price should be public and the participants should not.»
**Grand Prize** — «$20,000. Best overall submission, awarded on top of its track prize.» Community bounties — «$5,000. Smaller targeted bounties posted during the build window.»
**Выплата** — «Prizes are paid in ZEC to a shielded address you provide at submission.»

**Форма сабмита** (`forms.js`, все поля ниже обязательные, `req:true`):
- Project name (≤64), Track (одна), **Description** (≤2000 символов, плейсхолдер: «What it does, why it does not leak, what is real and what is a mock. Judges read this first.»)
- **Code repository** — «Private is fine until the deadline; it must be public by then.»
- **Working demo** (URL) — «Something the judges can open and use.»
- **Demo video** (URL) — «Two minutes. YouTube, Loom, anything with a link.»
- Чекбокс: «The repository will be public by the deadline. **I understand a private repo at the deadline is not judged.**»
- Можно сохранять черновик и переотправлять до дедлайна. Внимание: «Saving a draft after submitting takes it back out of submitted until you SUBMIT again.»

---

## 2. Разбор по вопросам

### 2.1 Что считается «готовым продуктом»
Определения в правилах нет. Опираемся на формулировки «Libraries are fine; existing products are not» и «Built for this hackathon, not repackaged».
- **Можно:** npm/crates-библиотеки (pump-sdk, DBC SDK, librustzcash, tlock-js), API (Jupiter, 1Click, Jito), shadcn-компоненты.
- **Рискованно:** форк Meteora «fun-launch» scaffold, любого open-source лаунчпада или кошелька как основы приложения; копипаст больших кусков `zcash-devtool` (это пример-утилита, а не библиотека: брать паттерны, а не модули целиком, и указывать атрибуцию).
- **Риск:** medium. **Рекомендация:** в README сделать раздел «Built during ZECATHON (Sep 28 – Oct 28)» со списком внешних библиотек и ссылкой на историю коммитов. Коммитить по ходу работы, а не одним комом в конце: git-история служит доказательством, что код написан в окне.

### 2.2 Открытый репо и лицензия
- Репо должен быть публичным к 28.10 23:59 UTC. **Открыть заранее, 28.10 до 20:00 UTC**, и проверить в инкогнито-окне, что он виден.
- Лицензия явно не требуется, но без `LICENSE` код формально не open source. **Рекомендация:** добавить MIT или Apache-2.0 в день 15. Сейчас в корне `/Users/yunoqii/Desktop/stay-unzeen` файла `LICENSE` нет.
- Перед открытием: прогнать поиск секретов (gitleaks / `git log -p | grep -i key`), потому что vault-ключи, Helius/1Click/Pyth-ключи в истории = компрометация после открытия. `.env*` в `.gitignore` проверить сейчас.

### 2.3 Видео и демо
- Видео **2 минуты**. Демо-URL **обязателен**, просто видео недостаточно.
- Что показать: оплата shielded ZEC по QR → «unzeen купил…» в ленте → та же сделка в Solscan, где виден vault, а не пользователь → вывод → Verify. И отдельно 10 секунд: «вот что видит наблюдатель в Zcash- и Solana-эксплорере».

### 2.4 Mainnet допустим?
Правила ничего не говорят про mainnet/testnet. **Допустим, но не обязателен.** Соображения:
- «Something the judges can open and use»: на mainnet судьи платили бы реальные ZEC, и интерактивная проверка фактически невозможна.
- Pump.fun, Meteora DBC и Pyth есть на devnet (проверено, см. `solana-launchpads.md`). Jupiter, Jito и NEAR Intents есть только на mainnet.
- **Рекомендация:** демо-URL = Zcash testnet + Solana devnet (pump.fun devnet), с баннером «testnet». В видео — короткий **mainnet**-прогон на деньги команды (≈0,3 SOL), ссылки на mainnet-транзакции в README. Деньги третьих лиц на mainnet не принимать (кастодиальный пул без аудита = юридический и репутационный риск).

### 2.5 Трек
Private Markets — правильный. Unzeen буквально «price public (bonding curve, лента), participants not». Fair-launch на tlock прямо попадает в «Sealed-bid auctions». Cross-Chain не подходит: «Swaps, bridges and intents that reach other chains **without unshielding on the way through**», а мы unshield-им через NEAR Intents (ZEC там transparent only).

---

## 3. Судейский взгляд: что значит «Leaks are disqualifying» для нашей архитектуры

Список для аудита на дни 13–14, по убыванию серьёзности:

| Серьёзность | Потенциальная утечка | Исправление |
|---|---|---|
| critical | Выплата пользователю через NEAR 1Click (recipient = t-адрес) или refund в t-адрес | Выплаты только shielded из резерва пула. 1Click — только пакетный ребаланс фиксированными лотами |
| critical | `creator` на pump.fun / pool creator на DBC = кошелёк пользователя или общий creator на все его запуски | Свежий адрес пула на каждый запуск |
| critical | `withdraw` на новый Solana-адрес сразу после покупки той же суммой с того же vault | Задержка + батч + вывод с другого vault + округление сумм (уже в ARCHITECTURE.md, проверить реализацию) |
| high | Лог/БД хранят связку `txid депозита ↔ anon_pubkey ↔ solana tx` | Разделить таблицы, хранить только хэши, не логировать memo |
| high | Тайминг: депозит виден в блоке Zcash → покупка через N секунд | Случайная задержка + батчинг по блокам |
| high | Фронт ходит напрямую к Helius/Jupiter/Pyth/IPFS из браузера (IP ↔ mint) | Все внешние запросы только через бек; метаданные грузит сервер |
| medium | anon-ключ / мнемоника в `localStorage` без шифрования | WebCrypto + пароль, как в STACK.md |
| medium | Один vault = один гигантский холдер | Шардирование + ротация |

Честность модели доверия (оператор видит реестр) **не утечка**, если она прямо описана в README. Судьи накажут за «только выглядит приватным», а не за честно заявленный trust-оператор.

**Что впечатлит на Grand Prize:** (1) живой end-to-end на testnet, который судья может пройти за 3 минуты; (2) страница Verify / «что видит наблюдатель»; (3) sealed-bid fair-launch на tlock как дословное попадание в формулировку трека; (4) честный threat model + roadmap (FROST, Squads); (5) публикация viewing key пула для аудита сумм.

---

## 4. Порядок урезания с точки зрения правил

Критерии «Working beats ambitious» и «Leaks are disqualifying» означают: сначала надёжное и неутекающее ядро, потом фичи. С учётом выводов из `solana-launchpads.md` рекомендую:
**Meteora → Jito multi-vault → автоматизация NEAR Intents (оставить ручной ребаланс) → fair-launch (оставить упрощённый: tlock + одна tx create + buy) → Jupiter.**
Jupiter опустить в конец списка, потому что он закрывает buy/sell после graduation и для любых токенов почти без кода. Fair-launch не резать целиком: это главный аргумент «почему именно Private Markets».

---

## Открытые вопросы для лида
1. Кто регистрирует аккаунт-сабмиттер? Приз уходит «that account» на shielded-адрес, указанный при сабмите. Нужен ZODL-адрес команды.
2. Сверить правила и сплит призов внутри аккаунта: в `data.js` есть пометка «PLACEHOLDER SPLIT».
3. Подтвердить гибридное демо (testnet/devnet интерактивно + mainnet в видео).
4. Хостинг демо-URL (web + core + lightwalletd должны быть живы с 29.10 по 22.11, весь период судейства). Это расход на ~4 недели, его нужно заложить.
5. Задать вопрос организаторам (bladet928@gmail.com), считается ли mainnet-only демо «open and use», если делать mainnet.

## Источники (проверено 2026-10-12)
- https://thezecathon.com/ (главная: «Sign in to see prize information… Tracks, rules, the schedule and the submission form are all inside.»)
- https://thezecathon.com/darkpool/data.js — сроки, треки, критерии, правила, FAQ
- https://thezecathon.com/darkpool/forms.js — поля формы сабмита
- https://x.com/zksnarks_/status/2104606505177899314 — анонс (призовой фонд $100K)
- https://docs.near-intents.org/resources/chain-support.md — ZEC transparent only (к п. 2.5)
