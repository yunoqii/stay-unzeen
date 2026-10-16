# Ревью GAP-фиксов перед mainnet-прогоном (коммит 59b23f1, 16.10.2026)

Сохранено лидом из отчёта analyst.

## Вердикт
Critical/high нет. Утечек со стороны пользователя нет: H1 цел, t-адрес пула не светится в API/UI/логах. Две medium — только ручные операции оператора `review-job` на hood. Прогон можно запускать; M1/M2 и low L1/L2/L5/L8 закрываются кодом до прогона (решение лида).

## Находки
| Sev | Файл:строка | Сценарий | Фикс |
|---|---|---|---|
| medium M1 | `core/ledger/src/review.rs:212-221`, `core/api/src/main.rs` (Fail) | `--fail --yes` на задании с легшей tx → возврат пользователю; для `transfer` — двойная выплата | Перед `--fail` читать receipt; разрешать только при reverted / `--hash` = `job.signature` |
| medium M2 | `core/ledger/src/review.rs:222-242` | `--confirm` пишет только `relayer_jobs`, пропуская `tokens`/`mint_vaults`/`trades`/цену/`network_fee` — create на hood ломается | Запретить ручной `--confirm` для create/fair_create (только `--reparse`) или дописывать строки |
| low L1 | `core/scanner/src/transparent.rs:156,250`, `config.rs:355` | Без `LIGHTWALLETD_SEND_URL` shield спрашивает UTXO t-адреса у scan-сервера (A8) | На mainnet bail без send_url |
| low L2 | `transparent.rs:187-198,239` | `--dry-run` пишет UTXO в wallet DB | Писать после проверки dry-run |
| low L5 | `core/scanner/src/deposits.rs:74` | После восстановления из сида нота shield может стать «депозитом без memo» | Фильтр по external scope + проверка is_change в тесте |
| low L6 | `core/ledger/src/verify.rs:479-494` | Refund/зависший в 1Click ZEC не в reserve до shield | В плане: shield до снимка Verify |
| low L7 | `transparent.rs`, `main.rs:449` | shield/send без `serve.lock` → возможен `database is locked` | Принято |
| low L8 | `adapters/scripts/meteora-config.ts` | pubkey конфига печатается после подтверждения; при таймауте повтор создаст второй конфиг | Печатать до отправки |
| info | `adapters/src/evm/funders.ts` | Комментарий про триггер top-up неточен | Поправить комментарий |
| info | `adapters/src/mainnet-setup.ts:48` | trim только у одного флага | Косметика |

## Чисто
H1/sync (нет запросов по t-адресу кроме shield); shield тратит только t-входы, выход — Ironwood change, OvkPolicy::Discard; обычные выплаты не берут UTXO; reserve Verify только shielded; t-адрес не в UA/API/UI/логах; review-job без гонок и двойного сеттла; mainnet-гарды (4 условия + pubkey payer); GAP-5 на двух уровнях; GAP-9 маркер + flock; Q5 — hood-фиксы на месте, stale_price и minOut>0 работают.
