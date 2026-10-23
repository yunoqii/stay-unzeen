# Аудит перед сдачей: логи VPS, доступы, секреты в git (23.10.2026)

Проверено 23.10, 13:00–13:20 CEST. Сервер: `unzeen-vps` (Contabo, релиз `e311af0`), репозиторий: все 196 коммитов всех веток. На сервере ничего не менял. Логи с сервера не выгружались: разбор шёл на месте, наружу выходили только счётчики и шаблоны строк, в которых адреса, хеши, суммы и IP заменены масками.

## Вывод

Логи Unzeen чистые. Во всех 16 контейнерах `unzeen-vps-*`, в Caddy, journald, syslog и Postgres нет IP клиентов, anon-pubkey, txid, memo или сумм рядом с идентификаторами. Данные пула лежат на LUKS2, свопа нет. В git секретов нет: все 63 срабатывания gitleaks ложные.

**Один настоящий блокер приватности на сервере.** Соседние проекты (mitsuke, bundler) через `sudo` кладут свои сниппеты в Caddy, который обслуживает Unzeen. Адреса сайтов в этих сниппетах никто не проверяет. Сосед может объявить сайт `api-mainnet.<host>/api/*` или `<web-host>/_next/*`. Такой маршрут встаёт раньше маршрута Unzeen, поэтому сосед получит IP пользователей вместе с подписанными запросами или отдаст свой JS вместо нашего. Это проверено на Caddy v2.10.

Попутно нашёл функциональный блокер демо: на devnet цена устарела примерно на 5 суток (`stale_price`), поэтому buy/sell для судей на devnet не работают.

---

## BLOCKER

### B1 · Сосед по серверу может перехватить трафик Unzeen через общий Caddy · владелец (сегодня)
**Где:** `/etc/sudoers.d/91-bundler`, `/etc/sudoers.d/92-mitsuke`, `/usr/local/sbin/bundler-caddy-apply`, `/usr/local/sbin/mitsuke-caddy-apply`. Импорт: `infra/deploy/Caddyfile:157` (`import /etc/caddy/sites/*.caddy`), `infra/deploy/compose.yml` (bind `/etc/unzeen/caddy.d` → `/etc/caddy/sites`).

**Что не так:**
- Пользователи `bundler` и `mitsuke` могут без пароля запускать `*-caddy-apply`. Скрипт копирует их файл в `/etc/unzeen/caddy.d/` и перезагружает **контейнер Caddy Unzeen** (`unzeen-vps-caddy-1`).
- `mitsuke-caddy-apply` запрещает часть директив (`log`, `file_server`, `import`, `tls`, …) и разрешает `reverse_proxy` только на `host.docker.internal:8400`. **Адрес сайта он не проверяет.**
- `bundler-caddy-apply` вообще ничего не фильтрует. Ему доступны `log`, `file_server`/`root` (каталог `/data` в контейнере Caddy = приватные TLS-ключи сертификатов Unzeen), `import`, плейсхолдеры `{env.*}`, `{file.*}`.
- Проверка (локально, `caddy adapt`, v2.10). Сайт `api-mainnet.example.test/api/actions*` в отдельном блоке рядом с `api-mainnet.example.test { reverse_proxy api-mainnet:8080 }` попадает в JSON **первым** маршрутом: `match host + path`, upstream `:8400`. `caddy validate` проходит, есть только предупреждение «path in site address is deprecated».
- Последствия. Сосед получает все запросы на выбранные пути Unzeen: IP (Caddy по умолчанию добавляет `X-Forwarded-For`, а `header_up -X-Forwarded-For` стоит только в нашем блоке), `x-unzeen-pubkey`, тела. Это прямая связка IP ↔ anon-ключ ↔ действия, то есть дисквалифицирующая утечка третьей стороне. Хуже того, на путях `WEB_HOST/_next/static/*` он может отдать свой JS, который вытащит 12 слов. А подмена `/api/pool` даст чужой UA для депозитов.

**Сейчас:** `mitsuke.caddy` состоит только из комментария, `bundler.caddy` нет, `preagents.caddy` безвреден (только `preagents.xyz`). То есть атаки сейчас нет, но возможность есть, и даёт её sudo-право.

**Исправление (по убыванию надёжности):**
1. До 29.10 (лучше — до конца жизни демо) удалить `/etc/sudoers.d/91-bundler` и `92-mitsuke`. Сайты соседей менять только руками владельца.
2. Соседям — отдельный Caddy (свой контейнер или rootless) на другом IP или порту, либо отдельный VPS. Общий Caddy с Unzeen означает общий TLS-стор, общий ACME-аккаунт и общий журнал ошибок.
3. Если sudo-скрипты оставить, в оба нужно добавить:
   - список разрешённых адресов сайта: точное совпадение с доменами соседа, без пути, без `*`, без `:порт`, без `http://`, без хостов из `/etc/unzeen/stack.env`;
   - блок-лист mitsuke перенести в bundler целиком;
   - запрет `handle_path`/`route` с путями, совпадающими с путями Unzeen, становится неважен, если хосты проверены.

### B2 · Devnet: цена токенов устарела на ~5 суток, торговля для судей не работает · backend (функционал, не приватность)
**Где:** `unzeen-monitor` (journald): `ALERT devnet: newest token price is 430379s old (stale_price for buy/sell; indexer/relayer down?)`. Алерт держится постоянно (253 раза за 2 дня, последний в 13:15 23.10). При этом `intel-devnet` считает тики без ошибок (`errors=0`, `saved=28`).

**Что делать:** выяснить, почему цены не пишутся в таблицу, которую читает проверка `stale_price` (кривые devnet, `curves=poll`?), и восстановить до записи видео. Отдельно проверить, что алерт уходит владельцу в Telegram, потому что 5 суток его никто не заметил.

---

## HIGH

### H1 · При открытии репо станет публичной вся история, в том числе внутренние доки и этот аудит · владелец/лид (28.10)
Если 28.10 просто удалить `docs/analysis`, `docs/sessions`, `docs/STATUS.md`, `CLAUDE.md` и `.claude/` последним коммитом, они останутся в истории. В истории останутся:
- `docs/RUNBOOK.md:744` (IP, логин `unzeen`, имя SSH-ключа);
- подробности инфраструктуры;
- все найденные уязвимости, включая B1, если он ещё не закрыт.

**Варианты:**
- (а) `git filter-repo --invert-paths --path docs/analysis --path docs/sessions --path docs/STATUS.md --path CLAUDE.md --path .claude` на копии, затем force-push в новый публичный репо. Даты коммитов сохранятся, и это доказательство, что код написан в окне хакатона. Сквошить историю в один коммит **нельзя**: это доказательство потеряется.
- (б) Оставить историю как есть, но к 28.10 закрыть всё, что описано в доках как открытая уязвимость.

Решение за владельцем.

### H2 · Verify: якоря на mainnet и hood не публикуются в цепочку · владелец (пополнить) + backend (backoff)
**Где:**
- `relayer-mainnet`: `failed attest internal` ×54, последний 23.10 01:40 UTC; `api-mainnet`: `verify anchor re-queued after a failed attest` ×50;
- `relayer-hood`: `retry attest venue_unavailable` ×101 699 за 4 дня, каждые несколько секунд;
- при старте обоих: `WARN Verify attestation key balance < N` и `fair-launch attestation key …`.

**Что делать:**
- владелец пополняет ключи аттестаций (не с vault);
- backend добавляет экспоненциальный backoff в retry attest на hood (иначе 30 МБ лога крутятся за пару суток, и при разборе инцидента истории не останется);
- до видео проверить, что `/verify` показывает свежий якорь.

---

## MEDIUM

### M1 · Порт 3000 (preagents, пользователь `side`) открыт всему интернету: влияние на Unzeen · владелец
**Факты:**
- `ufw allow 3000/tcp` (v4+v6);
- там слушает `/home/side/bin/caddy` на `*:3000`: `auto_https off`, `admin off`, сжатие;
- `/api/*` → `127.0.0.1:4000`, остальное → `next-server v14.2.15` на `127.0.0.1:3001`; `http://169.58.209.71:3000/` отвечает 200;
- у `side` lingering-сессия и rootless docker.

**Прямого влияния нет:**
- Caddy соседа не проксирует к Unzeen;
- трафик Unzeen идёт через опубликованные docker-порты 80/443;
- к `/etc/unzeen`, `/srv/unzeen` и `docker.sock` у `side`, `bundler`, `mitsuke` доступа нет (проверено `sudo -u <user> test -r/-w/-x` и `ls`, везде отказ);
- `hidepid=invisible` скрывает процессы Unzeen.

**Косвенный риск.** Это вторая публичная поверхность атаки на том же хосте: plain HTTP, старая ветка Next 14.2.x, собственный API. RCE в ней даёт шелл `side`, а из шелла `side` можно:
- обращаться к `127.0.0.1:8080–8082` (API Unzeen в обход rate-limit Caddy; per-IP лимит core ослаблен, A9) и `127.0.0.1:3100`, то есть устроить DoS во время судейства;
- достучаться до IP контейнеров в docker-сетях, включая `pg-mainnet 172.21.0.2:5432` (проверено, доступен с хоста). Защита там — только scram-пароль, без fail2ban, так что возможен перебор;
- съесть CPU и RAM общего хоста;
- использовать локальные уязвимости ядра.

**Исправление:**
1. `ufw delete allow 3000/tcp`. preagents уже подключён через `preagents.caddy` → `host.docker.internal:3000` (по образцу правила mitsuke-bridge оставить `allow from 172.19.0.0/16 to 172.17.0.1 port 3000`). Как только у `preagents.xyz` появится DNS, у него будет TLS.
2. Закрыть локальным пользователям доступ к сервисам Unzeen:
   ```
   iptables -I OUTPUT -m owner --uid-owner 1002-1004 -d 172.16.0.0/12 -j REJECT
   iptables -I OUTPUT -m owner --uid-owner 1002-1004 -o lo -p tcp -m multiport --dports 3100,8080:8082 -j REJECT
   ```
   Правила сохранить через `ufw` `before.rules`. Учесть, что rootless docker соседей ходит через slirp4netns от их uid, поэтому их собственный трафик в интернет не пострадает.

### M2 · Сканеры периодически стоят больше 15 минут на всех трёх сетях · backend
Монитор: `scanner made no scan pass in 900s` (mainnet 30, hood 29, devnet 16 срабатываний за 2 дня, потом `resolved`). В логах сканеров ошибки lightwalletd: `transport error`, `Timeout expired`, `block N is newer than the latest block`. Во время судейства депозит может зачисляться с задержкой до 15+ минут. Нужно проверить, что `LIGHTWALLETD_FALLBACK_URLS` реально используется при таймауте, и что таймаут прохода меньше 900 с.

### M3 · 1Click-котировки и публичные курсы не обновляются с момента деплоя · backend/владелец
`api-mainnet`/`api-hood`: `1Click quote failed kind="http_status"` ×1270–1333, `public rates refresh failed kind="http_status"` ×1264–1267 (devnet тоже). Возможные причины: неверный или протухший `ONECLICK_JWT` или изменился эндпоинт. Если от курсов зависит конвертация ZEC↔SOL в UI или ребаланс, судьи увидят старые цены. Проверить вручную одним запросом с VPS.

---

## LOW

- **L1 · ufw logging.** `ufw logging low` пишет `SRC=` заблокированных пакетов в `/var/log/ufw.log` и `kern.log` (4 недели, rsyslog) и в journald (7 дней, 200 МБ). Пользователи Unzeen туда не попадают: TCP 80/443 идёт через DNAT docker и не логируется. Из 80/443 в логе всего 6 строк, все UDP, это сканеры. Для чистоты модели «без IP» сделать `ufw logging off`. Кто: владелец.
- **L2 · Журнал Caddy содержит домены соседей.** Там ACME-ошибки `preagents.xyz` (NXDOMAIN, ретраи) и литерал `domain` (судя по всему, шаблон mitsuke). ACME-аккаунт Let's Encrypt общий для Unzeen и соседей, так что LE видит связь доменов. Решается вместе с B1, п. 2. Кто: владелец.
- **L3 · Лишние секреты в env.** Все сервисы получают все переменные общего env-файла: в `api-mainnet` есть `PINATA_JWT`, `BAGS_API_KEY`, `JUPITER_API_KEY`, `DATABASE_URL_RELAYER`, `DATABASE_URL_INDEXER`, `ONECLICK_JWT`, `SHYFT_API_KEY`. После сдачи стоит разделить env по сервисам. Кто: backend.
- **L4 · Скриншоты devnet в репо.** `docs/screenshots/2026-10-15/devnet-live/04-key.png`, `05-pay-qr.png`, `07-…`, `08-…` показывают префикс anon-ключа (`A2Av…`) и полный memo `unz1…` тестового devnet-аккаунта. Реальных средств там нет. Нужно убедиться, что это не один из demo-ключей судей; если он, то это не страшно, но лучше выдать судьям другие. Кто: лид.
- **L5 · Не подтверждено утверждение в README про бэкапы.** `README.md:164` утверждает «Provider snapshots and backups are off», а `docs/RUNBOOK.md:745` говорит, что это ещё надо проверить в панели Contabo. Из ОС это не видно. Владельцу проверить Auto Backup и Snapshots и только потом оставлять фразу.
- **L6 · Сбои пароля `unzeen_indexer` в Postgres.** 26–27 строк `password authentication failed for user "unzeen_indexer"` в `pg-mainnet` и `pg-devnet`, все 19.10 в 13:33 UTC (во время миграции), больше не повторялись. IP в строке нет: `log_line_prefix = '%m [%p] '`. Ничего делать не нужно.
- **L7 · Пробы Server Actions в логе web.** 1 119 ошибок `failed-to-find-server-action` / `Server Reference ID …` (почти все 20.10). Это сканеры, IP в лог не пишутся. Next 16.4.0, `NEXT_TELEMETRY_DISABLED=1`. Ничего делать не нужно, только держать Next на последнем патче.

---

## Пройдено (чек-лист H9 и N2)

| Пункт | Результат |
|---|---|
| Caddy: access-лог | нет (ни одного `log` в сайтах; глобальный лог `ERROR`, IP/URI/заголовки/TLS вырезаны); 68 строк за 4 дня, только ACME |
| Caddy: XFF к upstream | вырезается (`no_client_headers`); core XFF не читает (`core/api/src/lib.rs:6`) |
| Сжатие на API | нет `Content-Encoding` при `Accept-Encoding: gzip, br, zstd` (проверено curl) |
| `Server`/`Via`/`X-Powered-By` | не отдаются |
| HTTP/3 / Alt-Svc | нет (`protocols h1 h2`) |
| Логи api/scanner/relayer/intel (3 сети) | 0 внешних IP, 0 base58 32–44 (pubkey/mint/vault), 0 подписей Solana, 0 hex64 (txid), 0 EVM-адресов, 0 Zcash-адресов, 0 упоминаний memo/unz1. RPC-ключи в логах замаскированы (`?***`) |
| Postgres | `log_statement=none`, `log_connections=off`, `log_min_error_statement=panic`, префикс без `%h` |
| Docker logging | `json-file`, 10m×3, в daemon.json и в каждом контейнере |
| journald | `SystemMaxUse=200M`, `MaxRetentionSec=7day`; данных пользователей нет (монитор пишет только тексты алертов) |
| Telegram-алерты | тексты без данных пользователей |
| Шифрование данных | `/srv/unzeen` = LUKS2 aes-xts-plain64/512, файл `/var/lib/unzeen/vault.img`, ключ в keyring, `crypttab` пуст (ручная разблокировка). `pg` (3 сети) и `home` всех сервисов примонтированы с тома; именованных томов с данными нет (только `caddy_data`/`caddy_config`) |
| Своп | нет |
| Ключи | `/etc/unzeen/keys/<net>/*` 0600 uid 10001, каталоги 0700; seed монтируется только в scanner, solana-ключ только в relayer |
| Права | `/etc/unzeen` 750 root:unzeen, `/srv/unzeen` 750 root:unzeen, `docker.sock` 660 root:docker (в группе только `unzeen`); `side`/`bundler`/`mitsuke` вне `docker`/`sudo`/`adm`; проверено от их имени: R/W/X везде отказ |
| `/proc` | `hidepid=invisible` |
| SSH | ключи only, root запрещён, `AllowUsers unzeen side bundler mitsuke`, fail2ban sshd, ufw `LIMIT 22` |
| История shell | `/home/unzeen/.bash_history` без секретов |
| sudo в auth.log | значения env-set идут через stdin, в журнал попадают только несекретные хосты и pubkey |

---

## Часть 2. Секреты в git

**gitleaks 8.30.1**, `detect --log-opts="--all"`: 195 коммитов, ~10 МБ, **63 срабатывания, все ложные:**
- 52 — подписи транзакций и адреса в `adapters/test/fixtures/*.json` (публичные данные цепочки);
- 7 — тестовые векторы: `core/testdata/unz1-vectors.json` (`secretKeyHex` 4 шт.: `eb64…`, `d025…`, `27db…`, `5d86…`, выведены из публичных мнемоник BIP-39), `web/lib/crypto/testdata/{sign,unz1-web}-vectors.json` (`9d61…` — тестовый вектор 1 из RFC 8032), `core/testdata/verify-v3-vectors.json` (`1111…`);
- 4 — EVM-адреса в тестах hood, константа `Sec-WebSocket-Key` из RFC 6455, слово в комментарии `core/scanner/src/service.rs:34`.

**Ручной поиск по всем объектам истории:**

| Что искал | Результат |
|---|---|
| Мнемоники BIP-39 (12+ слов подряд из словаря 2048) | только публичные тестовые: `abandon … about` (core/web тесты), `legal winner …` (вектор BIP-39), `test … junk` (Hardhat, `adapters/test/evm/cases.ts`) |
| `AGE-SECRET-KEY-1` с телом | нет (только строки в коде парсера) |
| uview/uivk/zxview/spending keys/WIF | нет |
| Solana keypair (JSON из 64 чисел, base58 87–88) | массивов нет; base58 87–88 только в fixtures (подписи tx) |
| JWT (`eyJ…`) | нет |
| Helius/Shyft/Alchemy ключи в URL | только плейсхолдеры (`api-key=0000…`, `<SHY…>`) |
| UUID-ключи вне fixtures | нет |
| Telegram bot token | нет |
| PEM/SSH-ключи | нет |
| `.env`, `*.key`, `*.agekey`, `keys/` в истории | никогда не коммитились; есть только `.env.example` (3 шт., без значений); `.gitignore` покрывает `.env*`, `keys/`, `*.sqlite` |

**Открытый вопрос:** demo-ключи судей не должны выводиться из тестовых мнемоник (`abandon…`, `legal…`), иначе кто угодно восстановит их из публичного репо. Лиду подтвердить у backend, как генерировались 3–5 demo-ключей.

### Детали tlock / Jito: что видно сейчас и что вынести 28.10
**Сейчас публично ничего не раскрыто:**
- репо приватный;
- живой сайт собран как `build:public`: в HTML 7 страниц и в 163 JS-чанках (~2.6 МБ) нет строк `tlock`/`drand`/`jito`/`fair launch`;
- API всех трёх сетей отдаёт `404` на `/api/launches`, в `features` нет `fairLaunch`;
- упоминание «fair-launch multi-vault Jito bundles» есть только в стартовой строке лога relayer-mainnet (не публично).

**Код** (`core/fair`, `core/api`, `core/ledger`, `core/migrations`, `adapters/src`, `adapters/test`, `adapters/scripts`, `web/lib`, `web/components`, `infra/deploy`, `.env.example`, `adapters/.env.example`, `web/.env.example`) реализует tlock и Jito и неизбежно раскроет их при открытии. Это нормально, если репо открывается 28.10 перед сдачей.

**Документы публичной части с деталями** (подсчёт строк с упоминаниями tlock/drand / Jito). Это кандидаты на вынос или перенос во внутренние, если владелец не хочет публиковать внутреннюю кухню:

| Файл | tlock/drand | Jito | Рекомендация |
|---|---|---|---|
| `docs/API.md` | 14 | 2 | внутренний (рус.), вынести |
| `docs/RELAYER.md` | 1 | 6 | внутренний, вынести |
| `docs/RUNBOOK.md` | 3 | 1 | вынести (ещё и IP/логин/ключ SSH, см. H1) |
| `docs/ARCHITECTURE.md`, `docs/FEATURES.md`, `docs/STACK.md`, `docs/FRONTEND.md` | 1–2 | 0–2 | внутренние, вынести |
| `docs/design/promo-video.md`, `docs/design/asset-prompts.md` | 7 / 1 | 0 | вынести |
| `docs/submission/*.draft.md`, `checklist.md`, `mainnet-demo-run*.md` | 1–8 | 0–1 | черновики, вынести |
| `docs/screenshots/2026-10-13/tour/15-launch-fair-revealed.png` | UI fair-launch | — | оставить или вынести по решению |
| `README.md` (4/1), `docs/submission/description.md` (1/0) | — | — | **это сабмит**, остаются: там то, что раскрывается 28.10 намеренно |

Удалить из HEAD недостаточно, см. H1.

---

## Кто что делает

| # | Кто | Когда |
|---|---|---|
| B1 | владелец: убрать sudoers соседей / вынести их сайты из Caddy Unzeen | сегодня |
| B2 | backend: цены devnet | до записи видео |
| H1 | владелец + лид: способ публикации истории | до 28.10 |
| H2 | владелец (пополнить ключи аттестаций), backend (backoff hood) | до видео |
| M1 | владелец: закрыть 3000, iptables owner-match | до 28.10 |
| M2, M3 | backend | до видео |
| L1, L2, L5 | владелец | до 28.10 |
| L3 | backend | после сдачи |
| L4 | лид | до 28.10 |

## Открытые вопросы лиду
1. Соседи (side/preagents, bundler, mitsuke) на демо-сервере до 22.11 — это осознанное решение владельца? Для модели угроз в README («оператор и его сервер») это отдельная доверенная сторона.
2. Как сгенерированы demo-ключи для судей (не из тестовых мнемоник)?
3. Публикация 28.10: filter-repo (сохраняет даты) или как есть?
4. Пополнение ключей аттестаций mainnet/hood: кто и на какую сумму?

Примечание: для проверки на Mac владельца поставлены `gitleaks` и `caddy` (brew). Caddy используется только для `caddy adapt`, сервис не запускался. Удалить: `brew uninstall gitleaks caddy`.
