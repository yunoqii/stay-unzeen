// Landing copy that is data: lists, table rows, FAQ. Sources: README.md (trust and threat model),
// docs/FEATURES.md. Keep it honest: what is live, what is only in the code, what you trust the operator with.

/** Handle from docs/brand/final/GUIDE.md. */
export const X_URL = "https://x.com/stayunzeen";

export type Visibility = "hidden" | "public" | "operator";

export const PRIVACY_ROWS: { what: string; who: Visibility; note: string }[] = [
  { what: "Who placed a trade", who: "hidden", note: "The chain shows a pool vault as the signer. Never you, never your anon key." },
  { what: "The link between your deposit and your trades", who: "hidden", note: "You top up once, in shielded ZEC. Trades are signed requests, not Zcash transactions." },
  { what: "Your balance and positions", who: "hidden", note: "They live in the pool’s ledger, not on any chain." },
  { what: "Your 12-word phrase", who: "hidden", note: "Generated and encrypted in your browser. The server only sees the public key." },
  { what: "That the pool bought or sold a token", who: "public", note: "Every vault trade is on chain. That is the feed: “unzeen bought 1.2M $PEPE”." },
  { what: "The amounts of vault trades", who: "public", note: "The bonding curve is public, so the price and the size of each trade are too." },
  { what: "That a shielded Zcash transaction happened", who: "public", note: "Its sender, amount and memo are encrypted. Paying from a transparent address or an exchange would reveal you." },
  { what: "That your withdrawal address was funded by the pool", who: "public", note: "The gas drop comes from a vault. Withdraw to a fresh address, never your main wallet." },
  { what: "Which anon key holds what, and what it did", who: "operator", note: "Unzeen is a custodial pool in this version. The operator could link an anon key to its trades, but never learns who is behind it." },
  { what: "The vault keys and the pool’s Zcash key", who: "operator", note: "The operator could move funds. Verify proves liabilities and vault balances; the ZEC reserve is attested, not proven." },
];

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  hidden: "Hidden",
  public: "Public",
  operator: "Operator sees",
};

export const INTEGRATIONS: { name: string; role: string; status: "live" | "built"; note: string }[] = [
  { name: "Zcash", role: "Shielded deposits and payouts", status: "live", note: "One shielded top-up from ZODL or any shielded wallet. Payouts go out shielded, delayed and batched." },
  { name: "pump.fun", role: "Launch, buy, sell", status: "live", note: process.env.NEXT_PUBLIC_DEVNET !== "0" ? "Bonding-curve tokens on Solana, devnet and mainnet." : "Bonding-curve tokens on Solana mainnet." },
  process.env.NEXT_PUBLIC_DEVNET !== "0"
    ? { name: "Meteora DBC", role: "Launch, buy, sell", status: "live", note: "Dynamic bonding curve on Solana devnet." }
    : { name: "Meteora DBC", role: "Launch, buy, sell", status: "built", note: "Adapter written and tested on devnet; not switched on for mainnet yet." },
  { name: "Jupiter", role: "Graduated tokens", status: "live", note: "Routes on Solana mainnet, checked and simulated by our own pipeline." },
  { name: "NEAR Intents", role: "Pool liquidity", status: "live", note: "Converts the pool’s own ZEC to SOL in fixed lots. It never sees a user." },
  { name: "Raydium LaunchLab", role: "Launch, buy, sell", status: "built", note: "Adapter written and tested; not switched on in the demo." },
  { name: "Bags", role: "Launch, buy, sell", status: "built", note: "Adapter written and tested; not switched on in the demo." },
];

export const ROADMAP: { when: string; title: string; items: string[] }[] = [
  {
    when: "Now",
    title: "Working in this build",
    items: [
      "12-word anon key, made in your browser",
      "Top up with a ZIP-321 QR from ZODL",
      "Buy, sell and launch from one ZEC balance",
      "Private limit, take-profit and stop-loss orders",
      "Withdrawals to fresh addresses, with gas and delay",
      "Verify: proof of liabilities in your browser",
    ],
  },
  {
    when: "Next",
    title: "Less trust in the operator",
    items: ["Multisig vaults on Solana", "FROST threshold key for the pool’s Zcash wallet", "Zero-knowledge proof of the ZEC reserve", "Tor mirror and our own Zcash node"],
  },
  {
    when: "Later",
    title: "A bigger crowd to hide in",
    items: ["Cover activity in every batch", "Anonymous creator reputation, without linking launches", "A privacy meter for each action", "Signed export of your own trades, for taxes", "More launchpads"],
  },
];

export const FAQ: { q: string; a: string }[] = [
  {
    q: "Do I need a Solana wallet?",
    a: "No. You pay in shielded ZEC by scanning a QR code, and your account is a 12-word anon key made in your browser. When you withdraw tokens, you paste a fresh address.",
  },
  {
    q: "What does someone watching the chain see?",
    a: "That the pool traded: “unzeen bought 1.2M $PEPE for 0.4 SOL”, signed by a public pool vault. Not who asked for it, not which deposit paid for it, not your balance.",
  },
  {
    q: "Is Unzeen custodial?",
    a: "Yes, in this version. The operator holds the vault keys and the pool’s Zcash key, and the ledger knows which anon key did what. It never learns who is behind an anon key. Verify lets anyone check that the pool owes no more than it holds; multisig and threshold keys are next on the roadmap.",
  },
  {
    q: "Why shielded ZEC?",
    a: "A shielded deposit hides the sender, the amount and the memo. After that one top-up, nothing you do touches Zcash again until you withdraw, so the time of your deposit is not tied to the time of your trades.",
  },
  {
    q: "Is a “Now” trade as private as a delayed one?",
    a: "On chain, yes: it looks exactly like every other pool trade. On the network, no: someone watching your connection could match the moment you clicked to the trade 1–3 s later. Delayed, the default, runs actions in batches every 30–60 s in random order. For Now, use Tor or a trusted VPN.",
  },
  {
    q: "Can the creator of an Unzeen launch dump on me?",
    a: "The pool enforces two rules on the launching key: the creator’s initial buy is locked for 24 hours, and the creator can hold at most 5% of supply through the pool. Mint and freeze authority are revoked. A creator with a second anon key can get around the cap; the app says so.",
  },
  {
    q: "What if I lose my 12 words?",
    a: "Your balance is tied to the key, and only you have it. Back the phrase up when you create it; the app asks you to confirm a few words. Nobody, including us, can recover it.",
  },
  {
    q: "Can I check that the pool is solvent?",
    a: "Yes. /verify shows a daily Merkle-sum tree of liabilities. Your browser checks that your balance is inside it, that the roots are signed and anchored on chain, and that the vaults hold the tokens. The ZEC reserve is attested by the operator, not proven.",
  },
];
