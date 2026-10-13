# Unzeen brand v3: 5 directions (draft, not approved)

Сравнительный лист: `overview.png`. Детали знаков: `logo-sheet.png` (16/32/48, светлая версия, круг X). Профиль X: `preview-profile.png` (desktop и mobile, био, закреп). Safe zones баннера: `preview-banner-safezone.png`. Ресёрч: `docs/design/x-research.md`.

| Направление | Знак | Баннер X |
|---|---|---|
| A · Proof (zk) | коммитмент-скобки `[■]`: значение связано, но не читается | бумага-сетка: `trade = unzeen bought …` публично, `trader = [■■■]` скрыто |
| B · Root (zk) | Merkle-корень: корень сплошной, листья заштрихованы | Fig. 1, Merkle-sum дерево: «Every balance adds up. None has a name.» |
| C · Bite | жёлтая плитка, сверху диск «откусывает» жирную u | продукт: лента «unzeen bought …» |
| D · Tape | рваная цензурная лента; в wordmark лежит на «zee» | мем-типографика: «Bought by ▬▬▬» |
| E · Visor | маскот: бугор с цензурной полосой, без лица | жёлтый баннер-«опознание»: «Pick the buyer.» |

Файлы: `svg/` (знаки, lockup, wordmark, favicon; текст переведён в кривые, шрифт не нужен), `png/` (512, @4x lockup, favicon 16/32/48/180), `x/` (avatar 400 и @2x, banner 1500×500 и @2x).

Пересборка (офлайн): `PYTHON=<python с fonttools> PUPPETEER_CORE=<путь к puppeteer-core> sh src/render.sh` (`ONLY=<regex>` — часть). Шрифты Geist лежат локально в `src/fonts` (OFL), сеть не используется.

## D2: доработка wordmark Tape (`d2-sheet.png`)
Владелец выбрал D · Tape. В исходном wordmark лента идёт по середине «zee» и читается как зачёркивание. Два исправления:
- **D2a · z only** (`svg/d2a-tape-*`, `png/d2a-tape-*`): лента закрывает только «z» → «un▬een», читается как «unseen». Плюс: в знаке нет буквы Z (правила бренда Zcash).
- **D2b · low strip** (`svg/d2b-tape-*`, `png/d2b-tape-*`): тонкая лента-ярлык по базовой линии под «zee». Слово читается целиком.

Во всех текстах v3 нет слова «Solana»: бренд не привязан к одной сети. Био: «Private trading for launchpads, paid in shielded ZEC. Launch anywhere. Stay unzeen.»
