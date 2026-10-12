# Unzeen — решения по фронту

Согласовано с владельцем проекта 12.10.2026. Менять только через лида.

## Визуальный стиль: «Тень / минимализм»
- Почти чёрный фон, приглушённые серые, **один акцент — жёлтый Zcash** (`#F4B728`). Никаких других ярких цветов, кроме зелёного/красного для buy/sell в цифрах.
- Образ: «кто-то есть, но не видно» — силуэты, размытие (blur), мягкие тени, зерно. Никаких аватаров у трейдеров — только «unzeen».
- Спокойная, «дорогая» типографика; крупные цифры в ленте. Мало элементов, много воздуха.
- Анимации сдержанные: новое событие в ленте «проявляется» из размытия.
- Только тёмная тема.

## Главная = живая лента
- Центр экрана — лента в реальном времени: **«unzeen купил 1.2M $PEPE за 0.4 SOL · pump.fun · 12s»**.
- Сбоку (на мобиле — вкладкой) — горячие токены.
- Сверху — слоган *Launch anywhere. Stay unzeen.* и кнопки «Launch» / «Buy».

## Без Solana-кошельков
- **Никакого Phantom / wallet-adapter.** Все платежи — shielded ZEC по QR (ZIP-321).
- Адрес для вывода пользователь вставляет вручную; показываем предупреждение: «используй новый адрес, не свой основной кошелёк».

## anon-ключ: фраза из 12 слов
- Генерируется в браузере (BIP-39 мнемоника → ed25519 через `@noble/curves` / `@scure/bip39`).
- При создании — экран бэкапа: показать 12 слов, попросить подтвердить 2–3 слова.
- В браузере хранится **только зашифрованно паролем** (WebCrypto, PBKDF2/Argon2 → AES-GCM). Ключ и фраза никогда не уходят на сервер.
- Вход на другом устройстве — ввод 12 слов.

## Страницы
1. `/` — лента + горячие токены
2. `/token/[mint]` — график, сделки, купить / продать
3. `/launch` — название, тикер, картинка, площадка (pump.fun / Meteora), режим fair-launch
4. `/pay/[intentId]` — QR ZIP-321, адрес, сумма, статус (ждём → увидели → исполнено)
5. `/portfolio` — балансы по anon-ключу, продажа, вывод на новый адрес
6. `/verify` — как проверить честность (viewing key, сверка сделок)
7. `/key` — создать / восстановить anon-ключ

---

## UI-стек
| Что | Библиотека | Почему |
|---|---|---|
| Компоненты | **shadcn/ui** (Radix + Tailwind) | Доступные примитивы, легко перекрасить под «тень» |
| Анимации | **Motion** (`motion/react`, НЕ `framer-motion`) | Springs, `AnimatePresence`, `layout`/`layoutId`, `useScroll` |
| Иконки | **Phosphor Icons** (`@phosphor-icons/react`, веса `thin`/`light`/`duotone`) | Тонкие веса = минимализм; fallback — Lucide |
| Шрифты | **Geist + Geist Mono** через пакет `geist` (self-hosted) | Никаких запросов к Google Fonts — приватность |
| График токена | **lightweight-charts** (TradingView, Apache-2.0) | Лёгкий, профессиональный свечной график |
| QR | `qrcode.react` | ZIP-321 URI → QR |
| Тосты | `sonner` | Статусы оплаты/сделок |
| Шейдер героя | `three` + `@react-three/fiber` (lazy, только на `/`) | Один WebGL-фон, не больше |

Все ассеты (иконки, шрифты, логотипы площадок, ZEC-лого) — **локально в `web/public/`**, никаких CDN.
Логотип Zcash — по brand guidelines z.cash; логотипы pump.fun/Meteora — только как метка площадки.

## Интерактив — фирменные моменты
Каждая анимация показывает смену состояния или обратную связь, не декор. Цифры и цены — **без overshoot** (bounce 0), это трейдинг.

1. **Лента «проявляется».** Новое событие въезжает сверху: `filter: blur(12px)→0`, `opacity 0→1`, сдвиг списка через `layout`. Суммы — count-up. Слово «unzeen» на 300 мс прогоняется через scramble-эффект (свой, без motion-plus).
2. **Затмение в герое.** Тёмный шар с тонким жёлтым ободком (eclipse) на WebGL, слегка следует за курсором. Fallback для `prefers-reduced-motion` и слабых устройств — статичный градиент.
3. **Тень курсора.** На главной за курсором с задержкой (spring) тянется размытый силуэт — «кто-то здесь есть».
4. **Fair-launch reveal.** Кольцо-таймер (SVG progress ring) до раунда drand. Пока окно открыто — заявки показываются как зашифрованные глифы `▓▒░`. В момент раскрытия — глифы «расшифровываются» (scramble → цифры), частицы собираются в логотип токена.
5. **Оплата.** QR в пульсирующем кольце; шаги «ждём → увидели в мемпуле → исполнено» переключаются через `layoutId`-индикатор; на «исполнено» — короткий жёлтый flash.
6. **Сид-фраза.** 12 слов размыты; «удерживай, чтобы увидеть» (press-and-hold) — проявление. Подтверждение слов — плитки с drag-to-place.
7. **Режим приватности в портфеле.** Балансы размыты по умолчанию, иконка-глаз «подсмотреть». Вывод — токен «растворяется» (blur + scale→0.9 + fade).
8. **Карточка токена → страница.** Shared element через `layoutId` (картинка и тикер «перелетают»). Hover — лёгкий tilt (≤4°) и border-fade.
9. **Всегда:** `<MotionConfig reducedMotion="user">` в корне, длительности 150–300 мс для мелочей, до 500 мс для крупных поверхностей.

## Ассеты MotionSites (motionsites.org/assets)
Полный текст промптов открывается после входа на сайте — владелец проекта копирует нужные в `docs/motion-prompts/<имя>.md`, фронт адаптирует под нашу палитру (почти чёрный + жёлтый `#F4B728`). Проверять лицензию в каждом промпте (многие — MIT от ThreeUI).

| Ассет | Ссылка | Где у нас |
|---|---|---|
| Glowing Eclipse Ring Orb Background | motionsites.org/assets/backgrounds (orb) | Герой главной (п.2) |
| Liquid Form (шейдер) | motionsites.org/prompts/liquid-form | Альтернатива героя: тёмная «жидкая тень» вместо серебра |
| Warp Field (шейдер) | motionsites.org/prompts/warp-field | Экран ожидания fair-launch |
| Particle Gather | motionsites.org/prompts/particle-gather-animation | Reveal fair-launch (п.4) |
| SVG Progress Ring | motionsites.org/prompts/svg-progress-ring-animation | Таймер drand, статус оплаты |
| Number Count Up | motionsites.org/prompts/number-count-up-animation | Суммы в ленте, market cap |
| Staggered List Entrance | motionsites.org/prompts/staggered-list-entrance-animation | Лента, список токенов |
| Typewriter Reveal | motionsites.org/prompts/typewriter-reveal-animation | Слоган, расшифровка заявок |
| Smooth Pointer Follow | motionsites.org/prompts/smooth-pointer-follow-animation | Тень курсора (п.3) |
| Border Fade / Hollow Hover | motionsites.org/prompts/border-fade-hover-effect | Кнопки и карточки |

## Скиллы для фронта
- **`motion`** (в проекте, `.claude/skills/motion/`) — правила Motion: CSS или Motion, React-паттерны, springs, reduced motion. Поиск по докам требует Motion MCP (motion.dev/docs/ai-kit) — без него работает `best-practices/`.
- **`impeccable`** — дизайн-ревью, полировка, иерархия, микро-взаимодействия.
- **`ui-ux-pro-max:ui-styling`** — shadcn/ui + Tailwind, тёмная тема.
- **`ui-ux-pro-max:design-system`** — токены (цвета, отступы, типографика).
