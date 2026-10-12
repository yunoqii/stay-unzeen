# Unzeen — промпты для генерации ассетов

Ассеты генерирует владелец (или лид) вне репозитория. Фронт ничего не тянет из сети: готовые файлы кладутся в `web/public/…` по путям ниже. Пока файла нет, в коде работает fallback (указан для каждого ассета).

Общая палитра для всех промптов: почти чёрный `#060607` / `#0B0B0D` / `#18181C`, туман `#73737D` / `#B9B9C1`, единственный акцент — Zcash yellow `#F4B728`. Никаких других ярких цветов, без синего/фиолетового, без текста и логотипов чужих брендов. Стиль: «тень» — силуэты, размытие, зерно, диагональная штриховка (hatch) как «лента цензуры».

---

## 1. OG / social preview
- **Где:** превью ссылки (Twitter «stay unzeen», Telegram), `metadata.openGraph.images` в `web/app/layout.tsx`.
- **Файл:** `web/public/og.png`, 1200×630, PNG, ≤ 300 КБ.
- **Fallback:** превью без картинки (только title/description). В код ссылку добавить вместе с файлом.
- **Промпт:**
  > A minimal dark social preview card, 1200x630. Near-black background (#060607) with subtle film grain. On the right, a large solar-eclipse ring: a black disc with a thin glowing golden-yellow rim (#F4B728), soft bloom, slightly offset. On the left, empty space for a headline (do not render any text). A thin band of diagonal hatch lines in muted gray runs along the bottom edge like redaction tape. Calm, expensive, quiet. No people, no logos, no other colors.

## 2. Hero video loop (опционально, альтернатива WebGL)
- **Где:** фон героя на `/` для устройств без WebGL / с `saveData`; сейчас там статичный CSS-эклипс.
- **Файл:** `web/public/hero/eclipse-loop.mp4` (H.264, 1920×1080, 8–10 с, бесшовный цикл, ≤ 3 МБ) + постер `web/public/hero/eclipse-poster.webp`.
- **Fallback:** текущий статичный CSS-эклипс (`components/feed/hero.tsx`). При `prefers-reduced-motion` — только постер.
- **Промпт:**
  > Seamless 10-second loop, 1920x1080, for a website hero background. Pure near-black space (#060607). A slow, drifting solar eclipse: a matte black disc covering a star, only a thin corona ring of warm Zcash yellow (#F4B728) visible, gently breathing in brightness, with faint soft light rays and fine film grain. Very slow camera drift, no cuts, no text, no particles flying at the viewer. Moody, minimal, high-end. Keep the left 55% of the frame dark and empty for headline text.

## 3. Иконки токенов для моков
- **Где:** `TokenGlyph` в ленте, горячих токенах, на странице токена — только в мок-режиме (на реальном беке картинки приходят через наш `/media`).
- **Файлы:** `web/public/mock-tokens/<symbol>.webp`, 256×256, WebP, ≤ 30 КБ каждый. Символы: PEPE, GHOST, UMBRA, NOX, VEIL, MOTH, WRAITH, SHADE, HUSH, MASK, NULL, DUSK, CLOAK, ZEEN, ECHO.
- **Fallback:** монограмма (первые две буквы тикера) на тёмной плитке — уже работает.
- **Подключение (когда будут файлы):** мок отдаёт `image` в виде `/media/<sha40>.webp`, а `web/lib/media.ts` пропускает только `/media/…`. Для моков нужно будет добавить путь `/mock-tokens/` в белый список **только при `NEXT_PUBLIC_API_MODE=mock`**.
- **Промпт (один на набор, подставлять имя):**
  > A meme-coin avatar for "{NAME}", 256x256, square, centered subject on a near-black background (#0B0B0D). The subject is shown as a dark silhouette or half-lit shape with a single rim light in warm yellow (#F4B728); everything else in grays. Soft blur at the edges, subtle grain, no text, no letters, no frame, no other colors. Consistent style across a set of 15 icons: shadowy, mysterious, playful.

## 4. Текстура зерна (опционально)
- **Где:** класс `.grain` (оверлей на весь экран).
- **Файл:** `web/public/textures/grain-256.png`, 256×256, бесшовная, PNG с альфой, ≤ 40 КБ.
- **Fallback:** текущая inline SVG `feTurbulence` в `globals.css` — работает без файла.
- **Промпт:**
  > Seamless tileable film grain texture, 256x256, monochrome white noise on fully transparent background, fine and even, no patterns, no vignette, suitable as a 5% opacity overlay on a dark UI.

## 5. Пустые состояния: силуэт
- **Где:** `EmptyState` (портфель без токенов, лента токена без сделок, 404).
- **Файл:** `web/public/illustrations/silhouette.svg` (векторный, ≤ 15 КБ) или `.webp` 480×480.
- **Fallback:** текущий размытый круг (`page-shell.tsx`).
- **Промпт:**
  > A single anonymous human silhouette from the shoulders up, seen from behind, dissolving into soft blur at the bottom, rendered in dark grays on transparent background, with a faint thin yellow (#F4B728) rim light along one shoulder. Minimal, flat, no face, no details, no text. Vector-like, simple shapes.

## 6. Fair-launch reveal: частицы → логотип (будущее)
- **Где:** `/launch`, момент раскрытия (FRONTEND.md, момент 4). Сейчас превью раскрывает заявки расшифровкой глифов без частиц.
- **Файл:** не нужен: частицы рисуются кодом из картинки токена (`/media/…`). Если нужна заглушка-логотип: `web/public/launch/placeholder-mark.svg`, 128×128.
- **Fallback:** монограмма токена.
- **Промпт:**
  > A simple abstract coin mark, 128x128, a thin yellow (#F4B728) ring with a small offset black disc inside (eclipse motif), transparent background, flat vector, no text.
