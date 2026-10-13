# Unzeen: бренд-гайд (финал)

Утверждено владельцем 13.10.2026: **знак — D · Tape** (рваная лента-цензура), **wordmark — D2a** (лента закрывает только «z»: `un▬een`), X — аватар и баннер D («Bought by ▬▬▬»). Лист: `sheet.png`. Исходники: `src/` (геометрия в `../v3/src/build.py`), пересборка — `sh src/render.sh`.

## Цвета
| Токен | Hex | Роль |
|---|---|---|
| `--zec` | `#F4B728` | лента: знак, «z» в wordmark, акцент. **Единственный** яркий цвет |
| `--ink-1` | `#0B0B0D` | фон знака, favicon, app-icon, OG, баннера |
| `--paper` | `#EDEDF0` | wordmark на тёмном |
| ink на светлом | `#0B0B0D` | wordmark на светлом; у ленты на светлом обводка 1.2/64 ink (без неё жёлтый на белом даёт 1.7:1) |
| `--fog-3` / `--fog-2` | `#8B8B95` / `#7C7C86` | вторичный текст («Stay unzeen.», подписи) |

Зелёный и красный только для чисел buy/sell, в бренд-ассетах их нет.

## Охранное поле и размеры
- **Охранное поле:** высота x-height wordmark (≈ высота «u») со всех сторон lockup. Для знака отдельно — ¼ его ширины.
- **Lockup:** знак слева, зазор = 0.3 высоты знака; базовая линия wordmark — по нижней трети знака (как в `svg/unzeen-lockup-*.svg`).
- **Минимум:** wordmark — 16 px высоты (в шапке сайта 20–24 px). Знак — 16 px; меньше 24 px используем `favicon.svg` (утолщённая лента на тёмной плитке).
- Favicon всегда на тёмной плитке (`rx 12/64`): так жёлтый читается и на светлой, и на тёмной вкладке.

## Что нельзя
- Не перекрашивать ленту (только `#F4B728`), не делать градиент, свечение, тень, обводку на тёмном.
- Не выпрямлять ленту и не менять угол (−14° знак, −4° на «z»), не убирать рваный край.
- Не возвращать «z» поверх ленты и не класть ленту на другие буквы. Не набирать wordmark живым шрифтом с лентой «на глаз»: только готовые SVG.
- Не ставить знак на жёлтый фон и **не делать из него жёлтый круг** (в круге X это читается как монета Zcash). Аватар X — только `x-avatar-400.png` (тёмный фон).
- Не сочетать со знаком Zcash в одном lockup, не использовать Z, «Zcash» и жёлтую монету в своём бренде. Метка «Pay with shielded ZEC» — отдельно, официальным файлом, мельче нашего бренда, со ссылкой на z.cash.
- Не привязывать бренд к одной сети: в бренд-текстах **нет «Solana»** («Private trading for launchpads»). Сети и площадки — только в продуктовых местах (лента, выбор площадки).
- До 28.10.2026 23:59 UTC на публичных ассетах — без деталей архитектуры, закрытых до дедлайна (список в CLAUDE.md и в роли designer).

## Как сохранить читаемость имени «unzeen» при `un▬een`
Wordmark — картинка, имя должно жить в тексте рядом с ним всегда:
- **Доступность:** контейнер логотипа — `role="img" aria-label="unzeen"`; само SVG wordmark — `alt=""`/`aria-hidden` (чтобы не прочиталось дважды). В SVG-файлах уже есть `<title>unzeen</title>` и `aria-label`.
- **Title страницы:** `unzeen · Launch anywhere. Stay unzeen.`; внутренние — `<Page> · unzeen`. Слово всегда строчными и полностью, без ленты.
- **Мета и OG:** `og:site_name = unzeen`, `og:title` с «unzeen» текстом; `og:image:alt = "unzeen — Bought by [redacted]. Launch anywhere. Stay unzeen."`. На самой OG-картинке имя в wordmark + «Stay unzeen.» текстом.
- **X:** имя профиля `unzeen`, хэндл `@stayunzeen` (если свободен), био: «Private trading for launchpads, paid in shielded ZEC. Launch anywhere. Stay unzeen.» — имя повторяется текстом.
- **Лента на сайте:** «unzeen bought …» — всегда текстом, это главное место, где имя читается.
- **Произношение/поиск:** в README и на /docs один раз: «unzeen (reads as *unseen*)».
- В тексте **не** пишем `un▬een`, `un█een` или `unZeen`: приём с лентой — только в графике.

## Файлы
| Файл | Назначение |
|---|---|
| `svg/favicon.svg`, `png/favicon-16/32/48.png`, `favicon.ico` (16+32+48) | вкладка браузера |
| `png/apple-touch-icon-180.png`, `png/app-icon-192.png`, `png/app-icon-512.png` (+@2x), `svg/app-icon.svg` | iOS, PWA manifest (full-bleed, маску делает ОС) |
| `svg/unzeen-mark*.svg`, `png/unzeen-mark*-512.png` | знак: прозрачный, для светлого UI, на плитке |
| `svg/unzeen-lockup-{dark,light}.svg`, `png/…@4x.png` | знак + wordmark |
| `svg/unzeen-wordmark-{dark,light}.svg` (с фоном), `…-on-{dark,light}.svg` (прозрачные) | wordmark |
| `og.png`, `og.jpg` (1200×630), `og@2x.png` | Open Graph / Twitter card |
| `x-avatar-400.png` (+@2x), `x-banner-1500x500.png` (+@2x) | профиль X |
| `for-web/` | файлы для frontend (см. ниже) |

## Подключение во `web/` (делает frontend)
| Откуда (`docs/brand/final/…`) | Куда (`web/…`) |
|---|---|
| `for-web/icon.svg` | `web/app/icon.svg` (заменить) |
| `favicon.ico` | `web/app/favicon.ico` (заменить) |
| `png/apple-touch-icon-180.png` | `web/app/apple-icon.png` (заменить) |
| `png/app-icon-192.png`, `png/app-icon-512.png` | `web/public/brand/`, прописать в `web/app/manifest.ts` (`purpose: "any"`) |
| `og.jpg` | `web/public/og.jpg` (заменить); `alt` — см. выше |
| `svg/unzeen-wordmark-on-dark.svg`, `for-web/logo-mark.svg`, `svg/unzeen-lockup-dark.svg` | `web/public/brand/` |
| `for-web/logo.tsx.example` | образец для `web/components/layout/logo.tsx`: `EclipseMark` → `TapeMark` (путь ленты внутри), wordmark — SVG вместо живого текста |
| `for-web/logo-wordmark.svg` | вариант wordmark с `fill="currentColor"` для инлайна (SVGR), если нужен цвет от темы |
