// Mirrors docs/API.md (draft v0). Do not diverge: change the contract first.

export type Venue = "pumpfun" | "meteora-dbc" | "jupiter";

export interface FeedEvent {
  id: string;
  kind: "buy" | "sell" | "create";
  venue: Venue;
  mint: string;
  symbol: string;
  tokenAmount: string; // string to keep precision
  solAmount: string;
  solanaTx: string; // public signature, visible in explorers
  ts: number; // unix ms
  // no user data, only "unzeen"
}

export interface Token {
  mint: string;
  symbol: string;
  name: string;
  image?: string;
  venue: Venue;
  status: "curve" | "graduated";
  priceSol: string;
  marketCapSol: string;
  createdAt: number;
}

export type TokenWithTrades = Token & { trades: FeedEvent[] };

export interface IntentRequest {
  op: "buy" | "sell" | "create" | "withdraw";
  venue?: Venue;
  mint?: string;
  amount?: string;
  minOut?: string;
  anonPubkey: string;
  sig: string;
  meta?: { name: string; symbol: string; image?: string };
  withdrawTo?: string; // fresh Solana address
  refundUA?: string; // shielded address for payouts
}

export interface PaymentRequest {
  intentId: string;
  address: string;
  amountZec: string;
  memo: string;
  zip321Uri: string;
  expiresAt: number;
}

export type IntentStatus = "awaiting_payment" | "seen" | "executed" | "failed";

export interface IntentStatusResponse {
  status: IntentStatus;
  tx?: string;
}

export interface Portfolio {
  holdings: { mint: string; amount: string }[];
}
