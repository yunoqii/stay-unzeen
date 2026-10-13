# Unzeen: бренд-гайд (финал, v4)

Утверждено владельцем 13.10.2026. Сравнение с прошлой версией: `../v4/compare.png`, общий лист: `sheet.png`.
- **Знак:** сложенная малярно-цензурная лента поверх тёмного второго куска, положенного под другим углом (двухслойная).
- **Wordmark:** D2a — лента лежит на месте «z», получается `un▬een`.
- **X:** аватар — лента-наклейка поверх аватара, баннер D — «Bought by ▬▬▬».
- **Вау-деталь сайта:** лента отклеивается и наклеивается обратно (`../../design/tape-peel.md`).

Исходники лежат в `src/`. Лента собирается из кода (`../v4/src/tape.py`), шрифт переведён в кривые. Пересборка: `sh src/render.sh`.

## Лента: два уровня детализации
| Уровень | Где | Что внутри |
|---|---|---|
| **full** | лого от 64 px, lockup, баннер, OG, аватар X | креповые рёбра, светлые края, две складки со светлым гребнем, загнутый уголок, ступенька тени, неровный рваный край |
| **simple** | favicon, иконка в шапке, app-icon, всё от 16 до 48 px | ступенька, уголок, одна складка, два крупных зуба |

Тона жёлтого — только из этого набора, без градиентов:
- `#F4B728` — база;
- `#F8CA5C` — свет, +12 %;
- `#D99E17` — складки, −12 %;
- `#B98410` — изнанка уголка;
- `#7A560A` — ступенька.

Тёмный второй кусок: `#34343B`, свет `#44444C`, складка `#232328`. Чистый чёрный не используем.

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
- **Минимум:** wordmark — 16 px высоты. В шапке сайта 20–24 px, там нужен `unzeen-wordmark-small-*` (уровень simple). Знак — от 16 px. Меньше 64 px используем `unzeen-mark-simple.svg`, меньше 24 px — `favicon.svg` (на тёмной плитке).
- Favicon всегда на тёмной плитке (`rx 12/64`): так жёлтый читается и на светлой, и на тёмной вкладке.

## Что нельзя
- Не перекрашивать ленту и не добавлять тона вне набора выше. Без градиентов, свечения, размытых теней. Тень у нас одна — ступенька.
- Не выпрямлять ленту и не менять углы: −20° жёлтая, +12° тёмная. Не убирать рваный край и уголок.
- Не ставить детализацию full в размер меньше 64 px: складки превращаются в шум.
- Тёмный кусок всегда под жёлтым, никогда сверху.
- Не возвращать «z» поверх ленты и не класть ленту на другие буквы. Не набирать wordmark живым шрифтом с лентой «на глаз»: только готовые SVG.
- Не ставить знак на жёлтый фон и **не делать из него жёлтый круг**: в круге X это читается как монета Zcash.
- Аватар X — только `x-avatar-400.png`. Это лента-наклейка поверх внутреннего тёмного диска. X всё равно обрежет аватар кругом, а внутренний диск даёт эффект «наклейка вылезает за край» внутри этого круга.
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
| `svg/favicon.svg`, `png/favicon-16/32/48.png`, `favicon.ico` (16+32+48) | вкладка браузера (simple) |
| `svg/unzeen-mark-simple.svg`, `png/unzeen-mark-simple-512.png` | знак до 64 px |
| `svg/unzeen-wordmark-small-*.svg` | wordmark для шапки 20–24 px (simple) |
| `svg/strip-banner.svg`, `svg/x-avatar.svg` | исходники ленты для баннера и OG, аватар |
| `peel-still.png`, `for-web/tape-peel.html` | стоп-кадр и прототип отклеивания |
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
| `svg/unzeen-wordmark-small-on-dark.svg`, `for-web/logo-mark.svg` (simple), `for-web/logo-mark-full.svg`, `svg/unzeen-lockup-dark.svg` | `web/public/brand/` |
| `for-web/tape-strip-simple.svg`, `for-web/tape-strip-full.svg` | `web/public/brand/` (лента для Peek и анимации лого) |
| `for-web/logo.tsx.example` | образец для `web/components/layout/logo.tsx`. **Обновлено под v4:** знак — `<img src="/brand/logo-mark.svg">` (двухслойная лента не влезает в один path). Анимация — по `docs/design/tape-peel.md` |
| `for-web/logo-wordmark.svg` | wordmark simple с `fill="currentColor"` для инлайна (SVGR) |
| `for-web/tape-peel.html` | прототип peel/stick: лого и Peek |
