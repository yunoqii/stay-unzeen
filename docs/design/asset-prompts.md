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

## 5. Пустые состояния: «отредактированная» строка (v2, по замечанию владельца)
- **Где:** `EmptyState` (портфель без токенов, лента токена без сделок, 404).
- **Файл:** `web/public/illustrations/empty.svg` (вектор, ≤ 15 КБ) или `empty.webp` 960×480 с прозрачным фоном.
- **Идея:** не человек-силуэт (клише), а наш собственный язык — строка ленты, закрытая «цензурной лентой». Есть запись, но не видно, чья.
- **Fallback:** текущий размытый круг (`page-shell.tsx`).
- **Промпт (вариант A — ledger):**
  > Minimal flat vector illustration on a fully transparent background. Three thin horizontal hairline rows like a financial ledger, drawn in dark graphite gray (#2A2A30) with 1px strokes. The middle row is covered by a strip of diagonal hatching, 45-degree thin lines in warm yellow (#F4B728) at 40% opacity, like redaction tape over a document line. At the left end of the hidden row, a tiny solid yellow dot. Generous negative space, no text, no letters, no numbers, no people, no gradients, no shadows, no 3D. Precise, editorial, quiet. Aspect 2:1.
- **Промпт (вариант B — тень без объекта):**
  > Minimal flat vector illustration on a fully transparent background: a soft elliptical cast shadow on an invisible floor, in dark gray (#1C1C20) with blurred edges, but no object casting it — the space above the shadow is empty. A single thin yellow (#F4B728) hairline arc hovers where the object's top edge would be, like an eclipse rim. No text, no people, no gradients except the shadow blur, no 3D render. Quiet, mysterious, editorial. Aspect 2:1.

## 6. Fair-launch: знак «запечатанной заявки» (v2, по замечанию владельца)
- **Где:** `/launch` (режим sealed bids), карточка запуска до reveal, заглушка логотипа токена.
- **Файл:** `web/public/launch/sealed-mark.svg`, 128×128 viewBox, прозрачный фон, ≤ 6 КБ.
- **Идея:** не «монета с затмением» (повтор героя), а печать: круг, разрезанный по горизонтали «цензурной» штриховкой — до раунда drand содержимое скрыто, после reveal штриховка уходит (это анимирует фронт).
- **Fallback:** монограмма токена.
- **Промпт (вариант A — печать):**
  > Flat vector icon, 128x128, transparent background. A circular seal outline in thin warm yellow (#F4B728) 2px stroke. A horizontal band across the middle third of the circle is filled with 45-degree thin diagonal hatching in the same yellow, like redaction tape sealing the center. Above and below the band, inside the circle, solid near-black (#0B0B0D). Twelve tiny evenly spaced tick marks on the outer edge of the circle like a timer dial. Geometric, crisp, no text, no letters, no gradients, no 3D, no glow.
- **Промпт (вариант B — конверт-глиф):**
  > Flat vector icon, 128x128, transparent background. Three stacked horizontal bars of block glyph texture (like ▓▒░ characters, rendered as tiny squares) in decreasing density from left to right, warm yellow (#F4B728) on near-black, enclosed by a thin rounded-square outline. Feels like encrypted data waiting to be revealed. Pixel-precise, no text, no gradients, no 3D.
- Частицы «собираются в логотип» по-прежнему рисуются кодом из картинки токена — отдельный ассет не нужен.
