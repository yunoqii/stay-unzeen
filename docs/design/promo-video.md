# Unzeen: промо-ролик для X (после хакатона)

designer, 16.10.2026. **Публикация только после 28.10.2026 23:59 UTC.** В этом ролике fair-launch (sealed bids, drand tlock, одна цена) показываем открыто. До этой даты файл и всё, что по нему собрано, наружу не выкладывать: ни кадров, ни тизеров.

Основа: бренд v4 (`docs/brand/final/GUIDE.md`), лента-отклейка (`docs/design/tape-peel.md`), моушн-язык (`docs/design/motion-v2.md`, M1–M10), реальные экраны (`docs/screenshots/2026-10-15/devnet-live/`).
Язык: пояснения на русском. Всё, что попадает в кадр, все промпты, титры, субтитры и тексты постов только на английском.

---

## 0. Коротко

- **Основной ролик:** 84 с, 1920×1080, 30 fps, 120 BPM (1 доля = 15 кадров, 1 такт = 2 с, весь ролик = 42 такта).
- **Вертикальная нарезка:** 30 с, 1080×1920, из тех же исходников, свой порядок.
- **Рекомендация по концепции:** вариант **A, «Ledger line»** (ниже). Через весь ролик идёт одна горизонтальная hairline-линия реестра. Каждая сцена это строка, на которой жёлтая лента закрывает того, кто действует. Лента здесь главный герой: она ездит, клеится, отклеивается. Людей, замков, щитов и неона в кадре нет.
- **Как собирать:** UI только из реальных скринкастов (Playwright плюс захват экрана), всё поверх них собирается в **Remotion**: лента, штриховка, глифы, маски, зумы. AI-видео (Veo, Sora, Runway, Kling) идёт только на фоны и переходы **без текста и без интерфейса**: генераторы портят буквы и цифры, а неверная цифра в трейдинг-демо подрывает доверие.
- **Честность:** все цифры в кадре берутся из реальных прогонов (mainnet, где можно). Ничего не придумываем: ни «$10M volume», ни «10,000 users». Где реальной цифры нет, в кадре её тоже нет.

---

## 1. Концепция

### 1.1 Три варианта

| | Концепция | Структура | Плюсы | Минусы |
|---|---|---|---|---|
| **A · Ledger line** (рекомендую) | Одна бесконечная строка реестра. Камера едет вправо, каждая «ячейка» это действие продукта. Слово `unzeen` в каждой строке появляется после того, как лента закрыла реальный адрес | Непрерывный горизонтальный трек, переходы «лентой» без склеек | Своя структура, не шаблон «проблема → решение → фичи → CTA». Лента держит все 14 действий в одном жесте. Дёшево собирается кодом | Нужна аккуратная хореография трека в Remotion |
| B · Bought by ▬▬▬ | Ролик построен вокруг одной сделки: «кто купил 1.2M $X?» Детектив-обратка: от строки в ленте назад к депозиту ZEC, на каждом шаге след обрывается лентой | Обратная хронология, 4 главы | Сильный хук, сюжет | 14 функций в обратный сюжет не влезают, fair-launch и Verify выпадают из логики |
| C · Rounds | Ритм задают раунды drand: каждые 3 с «тик» (кольцо-таймер), на тике меняется сцена | Метроном, кольцо всегда в углу | Сильная визуальная константа, хорошо ложится на 120 BPM | Кольцо-таймер в каждой сцене размывает смысл fair-launch, где оно настоящее |

Из B берём только хук (первые 3 с), из C только привязку склеек к тактам. Остальное по A.

### 1.2 Тон
Тихо, точно, дорого. Короткие повествовательные фразы без восклицаний. Юмор сухой, одной строкой: «Who bought it? Nobody you can name.» Никакого «revolutionary», «game-changer», «the future of». Заголовки всегда прямые (roman), курсива нет. Акцент даём жёлтым, весом или лентой.

### 1.3 Музыка
- **Жанр:** минимал-техно / dark ambient с саб-пульсом, сухой клик-хэт, без вокала и без EDM-дропа. Референс по настроению: тёмный, «ночной» минимал, пустое пространство между ударами.
- **Темп:** 120 BPM, 4/4. Склейки на сильную долю, лента «шлёпает» на слабую (сдвиг на 7–8 кадров даёт ощущение руки, а не сетки).
- **Драматургия:** 0–8 с почти тишина (саб плюс шум ленты); 8–44 с ровный грув; 44–56 с (fair-launch) грув снимается до пульса и тиканья, на reveal один удар и возврат грува; 76–84 с всё уходит, финальный звук это отклеивание ленты.
- **Где брать (роялти-фри, лицензию проверять на каждый трек и сохранять скрин/PDF лицензии рядом с проектом):**
  - YouTube Audio Library: бесплатно; у части треков обязательна атрибуция, она указана у трека.
  - Pixabay Music: Pixabay Content License, атрибуция не нужна. Перед публикацией проверить, что трек не зарегистрирован в Content ID третьей стороной.
  - Uppbeat (бесплатный тариф с кредитом в посте) или Artlist / Epidemic Sound (платно, чистая лицензия на соцсети).
  - Free Music Archive: только CC BY или CC0, CC BY-NC для промо не годится.
  - **Лучший вариант — своя музыка:** простой луп 120 BPM в GarageBand или Ableton (саб, хэт, один аккорд). Никаких прав и полностью оригинально.
- **Звуки (SFX):** **записать свои**, это 15 минут работы и оригинальность. Нужны: отрыв малярной ленты (быстрый и медленный), шлепок наклеивания, тихий щелчок клавиши, «тик» (щелчок ручкой). Запасной источник: freesound.org, только CC0.
- **Чего избегать:** трейлерные «браммы», whoosh на каждую склейку, глитч-шумы, звук «хакерского» набора текста.

### 1.4 Ритм монтажа
- Сцена занимает 2–4 такта (4–8 с), fair-launch 6 тактов (12 с).
- Внутри сцены одно главное движение (лента или зум), не больше. Всё остальное это реальный UI, который двигается сам.
- Зумы в UI: `scale` 1 → 1.35–1.8 за 18–24 кадра, easing `[0.16, 1, 0.3, 1]` (наш `--uz-ease-expo-out`), без overshoot. Цифры никогда не пружинят.
- Лента: peel 420 мс `cubic-bezier(.2,.8,.2,1)`, stick 300 мс `cubic-bezier(.5,0,.9,.3)`. Тайминги из `tape-peel.md`, пружин нет.
- Титр держится не меньше 1.5 с на 6 слов (читают без звука). Титры коротко, максимум 8 слов.
- Курсор дорисовывается в посте: маленькая серая стрелка `#B9B9C1` плюс 1 px обводка `#0B0B0D`. Клик показываем коротким кольцом `#F4B728`, 6 кадров.

---

## 2. Раскадровка, основной ролик 84 с (16:9)

Обозначения: **SC-xx** — скринкаст (раздел 4.2), **G-xx** — генерируемый плейт (раздел 3.1), **M-x** — эффект из `motion-v2.md`. Время в формате `мм:сс`, такт = 2 с.

| # | Время | Что на экране | Движение | Текст на экране (EN) | Звук / переход |
|---|---|---|---|---|---|
| 0 | 00:00–00:03 | Чёрный `#0B0B0D`, одна строка ленты сделок крупно, Geist 64 px: `7xKX…Fq2p bought 1.2M $X for 0.5 ZEC`. Адрес — реальный адрес vault из mainnet-прогона | Кадр 0 уже содержательный: это обложка (см. 5.4). На 0:01 жёлтая лента наезжает слева на адрес (M2 «identity collapse»), адрес рассыпается в `▓▒░` и собирается в `unzeen` | `unzeen bought 1.2M $X` (сама строка), снизу Geist Mono 20 px `#8B8B95`: `who? nobody you can name.` | Тишина → звук отрыва ленты на 0:01 → шлепок. Склейка: hard cut на такт |
| 1 | 00:03–00:08 | SC-01: главная, живая лента. Камера медленно едет по строкам, у каждой `unzeen` | Скролл реального UI, лёгкий зум 1 → 1.15 | `Every trade is on-chain.` → (0:05) `Who made it is not.` | Входит саб-пульс. Переход: горизонтальная hairline-линия реестра выезжает из-под ленты и тянет кадр влево (трек A) |
| 2 | 00:08–00:14 | SC-02: `/pay`, QR ZIP-321 в пульсирующем кольце. Справа запись экрана телефона (SC-02b, Zashi/ZODL, сканирование и отправка), подаётся как скруглённый прямоугольник с hairline-рамкой, **без нарисованного корпуса телефона** | Статусы `Waiting for payment → Seen → Credited`, переход `layoutId`. На Credited строку `Incoming` закрывает лента (M1), баланс считается вверх | `Pay in shielded ZEC.` → `Credited · shielded, unlinkable` (это строка UI, не титр) | Грув стартует на 0:08. Тик на Seen, шлепок ленты на Credited |
| 3 | 00:14–00:18 | SC-03: `/key`, 12 слов размыты, «Hold to reveal». Затем `/portfolio`: баланс закрыт лентой (Peek, M6), удержание снимает ленту | Peel/stick ленты по таймингам `tape-peel.md` | `No wallet. No email.` → `12 words, kept in your browser.` | Отрыв и шлепок. Переход: лента с баланса улетает вправо и становится ведущей лентой трека |
| 4 | 00:18–00:25 | SC-04: `/token/[mint]`, пресет Buy 0.5 ZEC, сегмент `Now / Delayed`, тумблер `Max privacy (5–15 min)`. Сразу SC-01b: новая строка в ленте проявляется из blur, `unzeen bought …` | Зум на переключатель режима (1 → 1.6). Сплит-переход: левая половина — кнопка Buy, правая — лента | `Buy now. Or later, in a crowd.` | Клик на долю. Строка ленты появляется на сильную долю 0:22 |
| 5 | 00:25–00:30 | SC-05: вкладка Orders, ставим bracket: take-profit и stop-loss. Ордер появляется в списке | Зум на список ордеров, справа по краю идёт полоса штриховки (redaction tape) с надписью Geist Mono `not on-chain` | `Limits, take-profit, stop-loss.` → `Kept in the pool. Nothing to hunt.` | Тихий щелчок клавиши. Переход по ленте |
| 6 | 00:30–00:36 | SC-06: вывод токенов, Smart withdraw: `Parts 3`, `Max delay`. Анимация M4 «split and scatter»: сумма делится на 3 строки, каждая уезжает на свой новый адрес. Потом SC-07: вкладка ZEC, вывод на shielded UA | Три линии расходятся веером по ledger-сетке, у каждой адрес закрыт лентой | `Exit to fresh addresses.` → `Or straight back to shielded ZEC.` | Три коротких шлепка (по одному на часть), на третьей доле — дробь |
| 7 | 00:36–00:44 | SC-08: `/launch`, Instant. Чипы площадок `pump.fun · Meteora · LaunchLab · Bags` переключаются по доле, пары `/SOL · /ZEC · /USDC · /USD1` тоже. Справа превью «▬▬▬ launched $X» (M8). Внизу блок `Rules enforced on your launch` | Переключение чипов строго на каждую долю (8 долей). Превью в ленте проявляется последним | `Launch anywhere.` → `The creator on-chain is a pool vault.` | Грув на полную. На 0:44 грув обрывается на один такт: подготовка к fair-launch |
| 8 | 00:44–00:56 | **Fair-launch, главная сцена.** SC-09: создание окна sealed-bid. SC-10: три заявки от трёх ключей видны только как `▓▒░` (bid panel). SC-11: окно закрыто, commitment root записан memo-tx (`anchored before the round`). SC-12: кольцо drand до раунда `#…`. SC-13: reveal: глифы расшифровываются в цифры, `One price for everyone`, `Bought in one transaction`, `Your allocation` | Кольцо-таймер в центре, вокруг глифы. На раунде: одна вспышка `#F4B728` на 4 кадра, глифы скрамблятся в цифры за 18 кадров. Затем зум на `One price for everyone` | `Sealed bids. Nobody sees them.` → `Locked to a drand round.` → `Revealed at once.` → `One price. One transaction.` | Грув снят до пульса и тиканья 120 BPM. На reveal один удар саба, после него грув возвращается |
| 9 | 00:56–01:02 | SC-14: `/scenarios`, цепочка из 8 блоков (депозит → пауза → safety check → buy → bracket → ожидание → пауза → вывод ZEC). Кнопка `Sign once & start`. Затем SC-14b: блоки «зажигаются» по очереди | Блоки загораются по одному на долю (8 долей = 4 с), hairline-коннектор между ними заполняется жёлтым | `Sign once.` → `The pool does the rest.` | Подпись: короткий звук «росчерка» (ручка по бумаге, своя запись) |
| 10 | 01:02–01:06 | Сплит пополам. Слева SC-15: чат под токеном, у двух токенов у одного ключа разные ники (сравнение двух табов). Справа SC-16: `/creator`, комиссии, `Claim` | Слева ник одного ключа под токеном A меняется на другой под токеном B (кросс-фейд 6 кадров), справа claim уходит в баланс, count-up | `A new name under every token.` / `Creator fees, claimed anonymously.` | Два щелчка |
| 11 | 01:06–01:12 | SC-17: `/verify`. `Check my balance`: путь Merkle от «своего листа» к корню (M5), в карточках vault отметки `Signed ✓`, ссылка на якорь (memo-tx) | Путь рисуется `stroke-dashoffset` снизу вверх за 1 с, потом зум на `Signed ✓`, потом на root history | `Check the pool. Not the people.` → `Merkle-sum proofs · signed vaults · on-chain anchor` | Тики на каждый уровень дерева |
| 12 | 01:12–01:16 | SC-18: полоса курсов в футере `ZEC · SOL · ETH`, переключатель `Prices in ZEC / SOL`. Затем SC-19: переключатель сети Solana → Robinhood Chain, токен на Pons. **Только если hood на этот момент работает на mainnet или testnet; иначе сцену 12 сокращаем до курсов (см. 2.1)** | Три знака монет въезжают по ledger-линии: ZEC (официальный, жёлтый), SOL и ETH (официальные, монохромные `#B9B9C1`). Знаки стоят на одной базовой линии, не вращаются | `Priced in ZEC.` → `Solana today. Robinhood Chain too.` | Грув затихает |
| 13 | 01:16–01:24 | Финал. Чёрный фон, ledger-линия сходится в точку. Слоган в две строки, Geist 96 px: `Launch anywhere.` / `Stay unzeen.` (второе слово `#8B8B95` как на сайте). Затем lockup v4 (`svg/unzeen-lockup-dark.svg`): лента отклеивается с «z» и садится обратно (tape-peel). Под ним Geist Mono 24 px: `<domain> · @stayunzeen` (реальный домен подставить при монтаже, хэндл сверить) | Слоган печатается не печатной машинкой, а снятием ленты: строка закрыта лентой, лента отклеивается (420 мс), под ней текст. Потом lockup peel и stick, держим 2 с | `Launch anywhere. Stay unzeen.` → lockup → URL и хэндл | Музыка уходит; последний звук это отрыв и шлепок ленты на lockup; 0.5 с тишины перед концом |

### 2.1 Что зависит от состояния продукта на момент монтажа
Проверить у лида перед записью. Если функция не работает, сцену убираем, а не имитируем.
- **Robinhood Chain / Pons:** в STATUS сейчас это ресёрч и флаг `hood`. Если на mainnet нет живого запуска, сцена 12 занимает 4 с только с курсами, а титр меняется на `Priced in ZEC. Paid in shielded ZEC.`
- **Bags:** только mainnet и только после A4. Если не включено, на чипах остаются 3 площадки.
- **LaunchLab:** чип показываем, только если `PoolInfo.venues` его отдаёт.
- **Цифры:** «1.2M $X» в сцене 0 заменить реальной строкой из mainnet-ленты (тикер и сумма как есть).

---

## 3. Промпты по сценам

### 3.1 Общий формат AI-промпта (Veo 3 / Sora / Runway Gen-4 / Kling 2.x)

AI-плейты только для фонов, фактур и переходов. **В них не должно быть ни текста, ни UI, ни логотипов, ни людей.** Длительность клипа 4–8 с, генерировать в 1920×1080 (16:9) и отдельно в 1080×1920 (9:16), 24 или 30 fps. Апскейл только если генератор отдаёт меньше. Звук генератора не используем.

Шаблон:
```
[SHOT] <one sentence: what is in frame>
[CAMERA] <static | slow dolly-in 5% | slow lateral track left-to-right>, locked horizon, no handheld shake
[LIGHT] single warm key from <side>, everything else falls off to near-black
[PALETTE] near-black #0B0B0D and #18181C, muted graphite grays #34343B / #8B8B95, the only accent is warm Zcash yellow #F4B728; no other hues
[STYLE] macro product cinematography, shallow depth of field, fine 35mm film grain, matte, calm, expensive, minimal
[DURATION] 6 s, 30 fps, 1920x1080, seamless start and end on near-black
[NEGATIVE] no text, no letters, no numbers, no logos, no UI, no people, no faces, no hands unless stated, no padlocks, no shields, no hooded figures, no matrix rain, no neon, no blue, no purple, no lens flares, no glitch, no RGB split, no particles flying at camera, no 3D spinning coins, no bokeh balls, no gradient sky
```

Если генератор плохо держит HEX: заменить на слова «deep warm golden yellow, like a Zcash coin» и «charcoal black». После генерации всё равно прогнать грейд в Remotion или Resolve: LUT в нашу палитру, жёлтый вернуть точно в `#F4B728`.

**Запасной вариант для любого плейта:** собрать кодом в Remotion (шум `feTurbulence`, штриховка, затмение из `docs/brand`). Для практичных кадров ленты (G-02) лучше всего реальная съёмка на телефон (раздел 3.3).

### 3.2 По сценам

Для каждой сцены: **(а)** AI-плейт (если нужен), **(б)** сборка в моушне: какой скринкаст и что поверх.

**Сцена 0 · Хук «identity collapse»**
- (а) Не нужен. Чистый `#0B0B0D` с зерном 4 %.
- (б) Remotion. Текст живыми шрифтами Geist (локально из `web/node_modules/geist/dist/fonts`). Адрес vault Geist Mono. Компонент `<RedactionTape from="left">` (spec M2): `scaleX 0→1` 12 кадров, затем `▓▒░`-скрамбл адреса 9 кадров, затем `unzeen` из blur 12 → 0 px. Лента — `tape-strip-full.svg` из `docs/brand/final/for-web/`, не рисовать заново.

**Сцена 1 · Лента**
- (а) G-01 (опционально, фон за краями кадра при зуме):
  ```
  [SHOT] An endless sheet of dark matte paper with very faint horizontal hairline rules, like an accountant's ledger, seen from directly above
  [CAMERA] slow lateral track left-to-right, 3% per second, locked
  [LIGHT] soft warm key from top-left, strong falloff to near-black at the edges
  [PALETTE] … (как в шаблоне)
  [STYLE] … [DURATION] 8 s, loopable
  [NEGATIVE] … (как в шаблоне), no writing on the paper
  ```
- (б) SC-01, 1920×1080, скролл ленты. Поверх: ledger-сетка hairline `#ffffff` 6 % с шагом 64 px, слева уходит в виньетку. Титры Geist 56 px, низ-лево, отступ 120 px.

**Сцена 2 · Депозит ZEC**
- (а) G-03 (переход, 1.5 с перед сценой):
  ```
  [SHOT] Extreme macro of a thin ring of warm yellow light slowly closing around a dark empty circle, like an eclipse reaching totality
  [CAMERA] static, centered
  [LIGHT] the ring is the only light source
  [STYLE] … [DURATION] 4 s
  [NEGATIVE] … (как в шаблоне), no stars, no sun rays
  ```
  Альтернатива: eclipse-loop из `asset-prompts.md` п. 2, если владелец уже сгенерировал.
- (б) SC-02 (`/pay`) и SC-02b (запись экрана телефона из Zashi/ZODL: сканирование QR, сумма, отправка). Телефонный клип в скруглённой маске `rx 48`, hairline `#34343B`, **без корпуса устройства** (правило hallmark: не рисуем фейковую оболочку). Поверх: M1 «shielding tape» на строке Incoming, flash `#F4B728` 4 кадра на Credited. На записи с телефона закрыть лентой адрес и сумму в истории кошелька, если там видно что-то лишнее.

**Сцена 3 · anon-ключ и Peek**
- (а) Не нужен.
- (б) SC-03. **Только демо-ключ, специально созданный для ролика и потом выброшенный.** Слова в кадре размыты всегда, даже на «reveal»: в посте поверх слов накладываем ленту, реальные слова не показываем ни на одном кадре. Peek баланса: лента `tape-strip-full` по таймингам `tape-peel.md`.

**Сцена 4 · Buy + режим исполнения**
- (а) Не нужен.
- (б) SC-04 и SC-01b. Зум-маска на переключатель `Now / Delayed` и `Max privacy`. Сплит: вертикальный шов — hairline-линия, по которой проезжает лента. Новая строка в ленте с эффектом M2.

**Сцена 5 · Ордера**
- (а) Не нужен.
- (б) SC-05. Справа по краю вертикальная полоса redaction tape (штриховка −45°, `#F4B728` 1.4 px / 6 px) с подписью Geist Mono 18 px `not on-chain`, поверх которой идут «ценовые» тики. Других украшений нет.

**Сцена 6 · Вывод**
- (а) G-04 (опционально, под веер M4):
  ```
  [SHOT] Three thin warm yellow lines of light split from one point and drift apart across a dark ledger surface, each fading into darkness at a different distance
  [CAMERA] static top-down
  [STYLE] … [DURATION] 5 s
  [NEGATIVE] … (как в шаблоне), no sparks, no particles
  ```
- (б) SC-06 и SC-07. M4 «split and scatter» кодом поверх (точнее и дешевле, чем AI). Адреса в кадре: только свежие одноразовые, созданные для ролика, всё равно закрытые лентой после 8 кадров показа.

**Сцена 7 · Запуск**
- (а) Не нужен.
- (б) SC-08: в Playwright переключаем чипы площадок и пар на каждую долю (интервал 500 мс), запись в реальном времени. Если чип недоступен (2.1), он остаётся серым, как в UI, мы его не подделываем. Поверх: M8 превью в ленте, бейдж `Rules enforced`.

**Сцена 8 · Fair-launch**
- (а) G-05 (фон под кольцо drand, 12 с):
  ```
  [SHOT] A dark circular dial with twelve faint tick marks, a single thin warm yellow arc slowly sweeping around it like a clock hand made of light
  [CAMERA] very slow dolly-in, 4% over the clip
  [LIGHT] the arc is the only light
  [STYLE] … [DURATION] 8 s
  [NEGATIVE] … (как в шаблоне), no numbers on the dial
  ```
  Используем приглушённым (30 %) под настоящим SVG-кольцом из UI, не вместо него.
- (б) SC-09…SC-13, прогон с тремя ключами (u1, u2, u3), как в скриншотах `30-…35-*`. Поверх:
  - заявки как столбцы `▓▒░`, Geist Mono, плотность меняется каждые 3 кадра;
  - ledger-строка `commitment root · anchored before the round` с ссылкой на memo-tx (реальный хэш);
  - на раунд: flash 4 кадра, скрамбл глифов в реальные цифры итога за 18 кадров;
  - **не показывать** суммы заявок отдельных ключей рядом с ключами: в кадре только общий итог и `Your allocation` одного ключа. Число заявок — как в UI: `<5`, если их меньше пяти.

**Сцена 9 · Сценарии**
- (а) Не нужен.
- (б) SC-14 и SC-14b. Подсветка блоков кодом поверх скринкаста (маска на каждый блок, `opacity` 0.35 → 1 по доле), коннектор заполняется `stroke-dashoffset`. **Записывать в режиме viewport, не fullPage:** на fullPage-скриншоте шапка залипает посередине (видно на `23c-scenario-running.png`).

**Сцена 10 · Чат и кабинет создателя**
- (а) Не нужен.
- (б) SC-15 (один ключ, два токена, два ника) и SC-16 (`/creator`, claim). Сплит 50/50, шов — hairline.

**Сцена 11 · Verify**
- (а) G-06 (опционально, 3 с перед сценой):
  ```
  [SHOT] Thin warm yellow lines branch upward like a binary tree drawn in light on dark matte paper, converging into a single point at the top
  [CAMERA] slow tilt up following the branches
  [STYLE] … [DURATION] 4 s
  [NEGATIVE] … (как в шаблоне), no organic tree, no leaves, no circuit board look
  ```
- (б) SC-17: `/verify`, `Check again` с ключом, у которого есть баланс (на скриншоте `22-verify-own.png` показан пустой ключ — для ролика нужен ключ с балансом). Поверх: путь M5 кодом, зум на `Signed ✓`, зум на root history. Подпись якоря Geist Mono с реальным хэшем memo-tx.

**Сцена 12 · Курсы и сети**
- (а) Не нужен.
- (б) SC-18 и SC-19. Знаки монет — только официальные файлы: ZEC из z.cash brand assets (жёлтый, как есть), SOL с solana.com/branding, ETH с ethereum.org/assets. **SOL и ETH монохромные `#B9B9C1`.** Знаки не генерировать AI (он их искажает), не вращать, не делать 3D. По бренд-гайду: монета ZEC не стоит рядом с нашим лого и меньше него.

**Сцена 13 · Финал**
- (а) Не нужен. Чистый `#0B0B0D`, зерно 4 %.
- (б) Remotion: слоган живым Geist (разрешено, лента в слогане не используется); lockup **только готовым SVG** `docs/brand/final/svg/unzeen-lockup-dark.svg`. Peel и stick ленты на «z» по `tape-peel.md` (`transform-origin: 92% 50%`, peel 420 мс, hold 900 мс, stick 300 мс). Wordmark живым шрифтом с лентой «на глаз» не набирать.

### 3.3 Практическая съёмка (лучше AI для ленты)
G-02, «tape macro»: настоящая жёлтая малярная лента на чёрной матовой бумаге, телефон на штативе, 4K 60 fps, один тёплый свет сбоку. Кадры: (1) отрыв ленты от рулона, крупно рваный край; (2) лента ложится на полоску бумаги; (3) медленное отклеивание за уголок. В грейде жёлтый вернуть в `#F4B728`, фон в `#0B0B0D`. Это идёт на переходы между сценами 3→4, 7→8 и в финал перед lockup, по 8–12 кадров. Звук с этой же съёмки становится SFX ленты. Такого кадра нет ни у кого, это наш материал.

Если снимать некогда, AI-промпт G-02:
```
[SHOT] Extreme macro of a strip of warm yellow masking tape being slowly peeled off matte black paper, torn ragged edge in focus, the tape lifts from one corner and casts a soft shadow
[CAMERA] static macro, focus on the torn edge
[LIGHT] single warm key from the right, raking light shows the crepe texture of the tape
[STYLE] … [DURATION] 5 s
[NEGATIVE] … (как в шаблоне), hands out of frame
```

---

## 4. Монтажный план

### 4.1 Порядок сборки
1. Лид проверяет по 2.1, что работает на момент записи; финализировать список сцен.
2. Mainnet-прогон для «живых» сцен (лента, buy, вывод, launch, verify): реальные tx и цифры. Devnet — только для fair-launch с тремя ключами, если на mainnet его не прогоняли. Тогда в углу сцены 8 метка Geist Mono 16 px `#7C7C86`: `devnet`.
3. Запись скринкастов SC-01…SC-19 (4.2).
4. Параллельно: владелец генерирует G-01…G-06 и снимает G-02; собирается музыка и SFX.
5. Remotion-проект: композиция 1920×1080 30 fps, 2520 кадров, сетка тактов (каждые 60 кадров), сцены как отдельные `<Sequence>`. Компоненты: `RedactionTape`, `GlyphScramble`, `LedgerGrid`, `TapePeel`, `ZoomMask`, `Cursor`, `Caption`. Шрифты Geist и Geist Mono из локального пакета, без сетевых запросов.
6. Грубая сборка под музыку, проверка хронометража, потом детали (лента, зумы).
7. Анти-слоп-проверка по 4.6 и проверка приватности по 4.5.
8. Вертикальная версия (раздел 6), экспорт (5), обложка, субтитры.
9. Ревью лидом и analyst (приватность кадров) до публикации.

Где хранить проект: предлагаю `docs/design/promo/` (исходники Remotion и SRT). Тяжёлые рендеры, скринкасты и плейты в git не класть: держать локально или в release-ассетах. Решение за лидом.

### 4.2 Скринкасты (записывает frontend или лид через Playwright)

Общие настройки:
- **Production-сборка** (`next build && next start`), иначе в углу висит dev-индикатор Next «N» (он есть на всех скриншотах 15.10).
- Окно 1920×1080, `deviceScaleFactor: 2` (рендерим 3840×2160, в Remotion масштабируем: тогда зумы до 1.8× остаются резкими).
- Встроенный `recordVideo` в Playwright даёт низкий битрейт. Лучше: Playwright управляет headed Chrome, а захват идёт через OBS или `ffmpeg -f avfoundation` в ProRes 422 / CRF 10, 60 fps. Запасной путь: CDP `Page.startScreencast` с `quality: 100`, кадры потом склеить через ffmpeg.
- `slowMo: 150`, паузы 800 мс до и после каждого клика: в монтаже нужен запас.
- Системный курсор скрыть (дорисуем в посте), `prefers-reduced-motion: no-preference`.
- Только viewport-захват, без fullPage.
- Сеть Mainnet, если не указано иное. На каждый клип 2–3 дубля.

| ID | Страница | Действие | Сеть | Длина |
|---|---|---|---|---|
| SC-01 | `/` | Плавный скролл ленты 400 px за 6 с, в процессе приходит новое событие | mainnet | 10 с |
| SC-01b | `/` | Ожидание новой строки после покупки из SC-04 (тот же прогон) | mainnet | 8 с |
| SC-02 | `/portfolio` → Top up → `/pay/[id]` | Создать пополнение, ждать `Seen` → `Credited` | mainnet | до Credited, в монтаже сжать |
| SC-02b | Телефон, Zashi/ZODL | Запись экрана iOS: скан QR, отправка (владелец) | mainnet | 15 с |
| SC-03 | `/key` → `/portfolio` | Создать демо-ключ, hold to reveal; на портфеле удержать Peek | mainnet | 12 с |
| SC-04 | `/token/[mint]` | Выбрать `Delayed`, включить и выключить `Max privacy`, пресет 0.5 ZEC, Buy | mainnet | 12 с |
| SC-05 | `/token/[mint]` → Orders | Поставить take-profit и stop-loss, показать список | mainnet | 12 с |
| SC-06 | `/portfolio` → Withdraw → Tokens | Smart withdraw: `Parts 3`, Max delay, 3 свежих адреса, Confirm | mainnet | 15 с |
| SC-07 | `/portfolio` → Withdraw → ZEC | Shielded UA, сумма, Confirm, статус queued | mainnet | 10 с |
| SC-08 | `/launch` | Instant: имя, тикер, картинка; переключение площадок и пар по 500 мс; превью; Launch; результат | mainnet | 20 с |
| SC-09 | `/launch` → Fair launch | Создание окна sealed-bid | devnet* | 10 с |
| SC-10 | страница fair-launch | Три заявки от u1, u2, u3 (три профиля браузера) | devnet* | 3 × 8 с |
| SC-11 | то же | Окно закрыто, commitment root, anchor | devnet* | 8 с |
| SC-12 | то же | Кольцо drand до раунда | devnet* | 10 с |
| SC-13 | то же | Reveal, результат u1, `Open $X` | devnet* | 10 с |
| SC-14 | `/scenarios` | Собрать 8 блоков из шаблона, Review, `Sign once & start` | mainnet | 20 с |
| SC-14b | `/scenarios` → My scenarios | Запущенный сценарий, шаги идут | mainnet | 8 с |
| SC-15 | `/token/A`, `/token/B` → Chat | Сообщение одним ключом под двумя токенами, видны разные ники | mainnet | 2 × 6 с |
| SC-16 | `/creator` | Токен из SC-08, комиссии, Claim | mainnet | 10 с |
| SC-17 | `/verify` | `Check my balance` ключом с балансом, скролл до vault и root history | mainnet | 15 с |
| SC-18 | любой экран, футер | Курсы ZEC / SOL / ETH, переключение `Prices in` ZEC ↔ SOL | mainnet | 6 с |
| SC-19 | переключатель сети → hood | Токен на Pons, покупка (только если работает, см. 2.1) | hood | 10 с |

\* Если fair-launch прогнали на mainnet, всё на mainnet и метку `devnet` убрать.

### 4.3 Ассеты

| Что | Кто | Где взять | Формат |
|---|---|---|---|
| G-01 ledger paper, G-03 eclipse ring, G-04 three lines, G-05 dial, G-06 tree | владелец, AI | промпты в 3.2 | MP4/ProRes 1920×1080 и 1080×1920, 4–8 с |
| G-02 tape macro | владелец, съёмка (или AI, 3.3) | — | 4K 60 fps |
| SC-01…SC-18 | frontend или лид, Playwright | 4.2 | ProRes / CRF 10, 3840×2160 |
| SC-02b, SC-19 | владелец (телефон), лид | 4.2 | запись экрана |
| Музыка | владелец | 1.3 | WAV 48 kHz, файл лицензии рядом |
| SFX ленты, щелчки, ручка | владелец (своя запись) или freesound CC0 | 1.3 | WAV 48 kHz |
| Лента, lockup, wordmark | есть | `docs/brand/final/for-web/tape-strip-full.svg`, `svg/unzeen-lockup-dark.svg` | SVG |
| Знаки ZEC, SOL, ETH | дизайнер скачает официальные | z.cash brand, solana.com/branding, ethereum.org/assets | SVG |
| Шрифты | есть | `web/node_modules/geist/dist/fonts/` | woff2 / ttf |
| Эффекты M1, M2, M4, M5, M8, tape-peel | дизайнер или frontend, Remotion | `motion-v2.md`, `tape-peel.md` | код |

### 4.4 Субтитры
- Озвучки нет. Титры на экране = субтитры, они вшиты (X по умолчанию запускает видео без звука).
- Дополнительно грузим `.srt` в X (в веб-композере: «Upload captions»). Текст тот же, что в титрах; для смысловых звуков в квадратных скобках: `[tape tears]`, `[drand round]`.
- Титры Geist Medium 48–56 px (16:9) или 56–64 px (9:16), `#EDEDF0` на фоне, без плашек. Контраст с `#0B0B0D` 17:1. Если под титром светлый UI — подложка `#0B0B0D` 70 % с размытием 12 px по контуру строки.
- Максимум 2 строки, 32 символа в строке.

### 4.5 Приватность кадров (проверяет analyst до публикации)
- Демо-ключ только одноразовый; 12 слов не видны ни в одном кадре (лента поверх).
- Адреса вывода свежие, одноразовые, на экране не дольше 8 кадров, потом лента.
- В кадр не попадают: viewing key, личные кошельки владельца, вкладки браузера, закладки, уведомления macOS, часы с часовым поясом.
- Fair-launch: не ставить рядом ключ и сумму его заявки у разных участников.
- Запись с телефона: проверить историю транзакций и адресную книгу в кадре.
- По `docs/analysis/`: все экранные тексты сверить с актуальным копирайтом UI на момент записи.

### 4.6 Анти-слоп-проверка (hallmark и impeccable, применено к ролику)
Hallmark заточен под страницы, поэтому его правила переложены на видео. Проверка по этой раскадровке:
| Правило | Как соблюдено |
|---|---|
| Honest copy, без выдуманных метрик (gate 46) | Цифры только из реальных прогонов; сцены по невключённым функциям вырезаются (2.1) |
| Re-drawn chrome (gate 47) | Нет нарисованных браузеров, корпусов телефона и окон. Скринкаст в hairline-рамке или в кадр целиком |
| Italic headers (38a) | Все титры прямые, акцент только цветом и лентой |
| Default-attractor sameness | Структура «ledger line», а не «проблема → решение → сетка фич → CTA»; одна сквозная метафора |
| Floating orb / aurora / shadow-glow on dark | Затмение только в переходе G-03 и только в нашей палитре; свечения вокруг UI нет (по гайду: без glow) |
| Bounce / elastic easing | Пружин нет, цифры без overshoot, все тайминги из `tape-peel.md` и `motion-v2.md` |
| Animate-on-scroll на всём / typewriter везде | Одно главное движение на сцену; печатной машинки нет, текст открывается снятием ленты |
| Celebratory toasts | Нет конфетти и галочек «Success!» поверх UI; Credited показан одной вспышкой 4 кадра |
| Генеративная «AI-иллюстрация» | AI только на фонах без объектов-клише; логотипы монет официальные |
| Clichés приватности | Нет замков, щитов, капюшонов, matrix-дождя, глитча, неона |

impeccable-ревью (иерархия и читаемость), что проверить на черновом рендере:
- в каждой сцене одна точка внимания: зум или лента, не оба сразу;
- титр читается за отведённое время (6 слов ≥ 1.5 с);
- UI при зуме не размыт (рендер 2×);
- жёлтый — единственный яркий цвет в кадре; зелёный и красный только в цифрах buy/sell в UI.

---

## 5. Экспорт для X

### 5.1 Основной ролик
- Контейнер MP4, видео H.264 High Profile, 1920×1080, 30 fps (постоянный), progressive, `yuv420p`, `-movflags +faststart`.
- Битрейт: VBR, цель 12 Мбит/с, максимум 16 Мбит/с (2 прохода). X всё равно перекодирует; больший битрейт качество не улучшит, а чёрный с зерном на меньшем начнёт «кашлять» блоками.
- Аудио: AAC-LC, 48 kHz, стерео, 256 кбит/с, громкость −14 LUFS integrated, true peak −1 dBTP.
- Ограничения X: до 2:20 и 512 МБ для обычного аккаунта. 84 с проходит с запасом.
- Зерно: в Remotion держать 3–4 %, не больше, иначе после перекодирования X фон станет пятнистым. Проверить, залив тестовым постом в приватный аккаунт.
- Пример ffmpeg из мастер-ProRes:
  ```
  ffmpeg -i master.mov -c:v libx264 -profile:v high -pix_fmt yuv420p -r 30 \
    -b:v 12M -maxrate 16M -bufsize 24M -preset slow -pass 1 -an -f mp4 /dev/null && \
  ffmpeg -i master.mov -c:v libx264 -profile:v high -pix_fmt yuv420p -r 30 \
    -b:v 12M -maxrate 16M -bufsize 24M -preset slow -pass 2 \
    -c:a aac -b:a 256k -ar 48000 -movflags +faststart unzeen-promo-1080p.mp4
  ```

### 5.2 Вертикальная версия
Те же настройки, 1080×1920, битрейт 10 Мбит/с.

### 5.3 Безопасные зоны
- 16:9: титры не ниже 90 % высоты (X рисует контролы снизу).
- 9:16: текст и ключевой UI в центральной зоне 1080×1420 (сверху отступ 200 px, снизу 300 px под интерфейс X и подпись поста).

### 5.4 Обложка
Во многих клиентах X постер берётся из первого кадра, поэтому **кадр 0 и есть обложка**: строка `7xKX…Fq2p bought 1.2M $X for 0.5 ZEC` с лентой, наполовину наехавшей на адрес (стоп-кадр с 0:01, поставленный в кадр 0, 8 кадров держим). Чёрный экран и лого в начале не ставить. Отдельно экспортировать PNG 1920×1080 этого кадра для поста-анонса и README.

---

## 6. Вертикальная нарезка 30 с (9:16, 1080×1920)

Другой порядок, не уменьшенная копия: хук → самое сильное (fair-launch) → доказательство → финал. UI кропом по зонам (кнопки и строки ленты крупно), без перемасштабирования целого экрана.

| Время | Сцена | Кроп / текст |
|---|---|---|
| 00:00–00:03 | Хук (сцена 0), строка в 2 строки | `unzeen bought 1.2M $X` / `who? nobody you can name.` |
| 00:03–00:07 | Депозит (сцена 2), QR сверху, статус снизу | `Pay in shielded ZEC.` |
| 00:07–00:12 | Buy → строка в ленте (сцены 4 + 1) | `Every trade on-chain. Who made it, not.` |
| 00:12–00:21 | Fair-launch (сцена 8, сокращённая): глифы → кольцо → reveal | `Sealed bids.` → `One price for everyone.` |
| 00:21–00:24 | Verify (сцена 11): путь Merkle и `Signed ✓` | `Check the pool. Not the people.` |
| 00:24–00:27 | Вывод (сцена 6): три линии | `Exit to fresh addresses.` |
| 00:27–00:30 | Финал: слоган, lockup peel | `Launch anywhere. Stay unzeen.` |

Музыка та же, отрезок с 0:40 по 1:10 основного трека, чтобы reveal попал на удар в 0:20.

---

## 7. Тексты для X

### 7.1 Пост с основным роликом (≤ 280 символов)
```
Every trade below is real and on-chain. Who made it is not.

unzeen: private trading for launchpads, paid in shielded ZEC. Buy, sell, launch, sealed-bid fair launches, exits to fresh addresses. Verifiable pool.

Launch anywhere. Stay unzeen.
```
Ссылку на сайт и репозиторий давать во втором твите треда: посты со ссылкой в первом твите X показывает хуже.

### 7.2 Три варианта первого твита треда
**A, хук (рекомендую):**
```
Someone just bought 1.2M $X.

The wallet is a pool vault. The money came from shielded ZEC. The buyer stays unzeen.

Here's how, in a thread:
```

**B, продуктовый:**
```
We built unzeen at ZECATHON: a privacy layer for launchpads.

Top up once with shielded ZEC. Then buy, sell, launch and exit on pump.fun, Meteora and more. On-chain, the trader is the pool.

84 seconds, every feature:
```

**C, fair-launch:**
```
Sealed bids, locked to a drand round. Nobody sees them, not even us.

At the round they open together. One price for everyone, one transaction.

That's a fair launch on unzeen. The rest of it in 84 seconds:
```

Перед публикацией: «1.2M $X» заменить реальной строкой из ролика; список площадок сверить с тем, что реально включено (2.1); проверить, что в тексте нет обещаний, которых нет в продукте (Robinhood Chain упоминать, только если сцена 12 вошла целиком).

### 7.3 Остальные твиты треда (каркас)
2. Ссылка на сайт и GitHub, одна строка про модель доверия: `How it works and what you trust: <link to /docs>`.
3. Вертикальная нарезка или GIF fair-launch reveal, с текстом про commitment root и якорь.
4. Verify: скриншот `Signed ✓` и Merkle path, `Don't trust the pool. Check it: <link /verify>`.
5. Благодарность ZECATHON и треку Private Markets, `#Zcash` (один хэштег, не больше).
