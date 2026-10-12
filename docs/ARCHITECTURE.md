# Unzeen — архитектура

> Launch anywhere. Stay unzeen.

Zcash shielded-пул — приватный вход и выход. Solana — рынок. Пользователь никогда не светит свой Solana-кошелёк в сделках.

## Компоненты

```
 Пользователь (ZODL / любой Zcash-кошелёк)
        │ shielded ZEC + зашифрованное memo
        ▼
 ┌──────────────────────────┐
 │ core/ (Rust)             │  сканер Orchard (lightwalletd, testnet)
 │  - scanner               │  парсинг memo → команда
 │  - ledger                │  балансы по anon-ключу (приватный реестр)
 │  - payouts               │  возвраты / продажи → shielded ZEC
 └──────────┬───────────────┘
            │ команды buy / sell / create / withdraw
            ▼
 ┌──────────────────────────┐
 │ relayer + adapters/ (TS) │  vault-кошельки (шардированы) на Solana
 │  - pump.fun              │
 │  - meteora DBC           │
 │  - jupiter (вторичка)    │
 └──────────┬───────────────┘
            ▼
     Solana: pump.fun / Meteora / DEX     ← лента: «unzeen купил …»
            ▲
 NEAR Intents — пакетный ребаланс ZEC → SOL для запаса SOL у пула
```

## Потоки

**Покупка.** Shielded ZEC на адрес пула, memo: `{v, op:"buy", venue, mint, min_out, anon_pubkey, sig}` → сканер → реестр зачисляет эквивалент по курсу ZEC/SOL → релейер покупает из запаса SOL через адаптер с одного из vault → реестр записывает токены на anon-ключ → событие в ленту.

**Продажа.** Memo `op:"sell"` (подписано anon-ключом, может идти с минимальным депозитом-комиссией) → релейер продаёт → выплата shielded ZEC на refund UA.

**Вывод.** Memo `op:"withdraw"` → токены уходят с vault на новый Solana-адрес (с задержкой/батчингом).

**Запуск.** Memo `op:"create"` + комиссия → vault создаёт токен на выбранной площадке. Creator fees пересылаются создателю в shielded ZEC.

**Fair-launch (киллер-фича).** Окно заявок N минут, суммы зашифрованы drand tlock → после раунда drand: Jito-бандл `create + buy(сумма всех заявок)` атомарно → токены делятся пропорционально, одна цена для всех, снайперы невозможны.

## Адаптер

```ts
interface LaunchpadAdapter {
  id: "pumpfun" | "meteora-dbc" | "jupiter";
  create(meta: TokenMeta, initialBuyLamports: bigint): Promise<TxResult>;
  buy(mint: string, lamportsIn: bigint, minOut: bigint): Promise<TxResult>;
  sell(mint: string, amount: bigint, minLamports: bigint): Promise<TxResult>;
  quote(mint: string, side: "buy" | "sell", amount: bigint): Promise<Quote>;
  status(mint: string): Promise<"curve" | "graduated">;
}
```

## Модель доверия (честно, для README)
- MVP: оператор пула хранит vault-ключи и реестр → доверие к оператору.
- Roadmap: мультисиг на vault (Squads), FROST t-of-n на стороне Zcash, публикация viewing key для аудита.

## Защита приватности
- Шардирование vault + ротация (нет «одного гигантского холдера»).
- Задержки и батчинг между депозитом и сделкой; округление сумм.
- Ни один лог не содержит связки депозит ↔ anon-ключ ↔ сделка в открытом виде.
