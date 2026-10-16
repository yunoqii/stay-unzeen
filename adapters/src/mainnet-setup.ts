import { createInterface } from "node:readline/promises";

/**
 * One-time pool setup scripts on MAINNET (Meteora DBC config, Raydium LaunchLab
 * platform): what a run may do and how much SOL the payer needs.
 *
 * Gate (all of them, otherwise the script only describes / simulates):
 * - `--send` on the command line;
 * - UNZEEN_ALLOW_MAINNET=yes (already required by loadConfig) AND
 *   UNZEEN_ALLOW_MAINNET_SETUP=yes (separate, set only for this one run);
 * - explicit confirmation: `--confirm-mainnet <payer pubkey>` (exact match) or,
 *   on a TTY, typing the payer pubkey at the prompt.
 *
 * Funding rule on mainnet: the payer (the pool's partner key) is funded from the
 * OPERATOR's external wallet, never from a vault (a vault -> partner transfer
 * would publicly link the pool's trading wallets to the fee claimer). The
 * script only prints the address and the missing amount.
 */
export type SetupMode = "dry" | "simulate" | "send";

export interface SetupGateInput {
  cluster: string;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
}

export interface SetupGate {
  mode: SetupMode;
  mainnet: boolean;
  /** `--confirm-mainnet <x>` value (mainnet send only). */
  confirm: string | null;
}

export function argValue(argv: readonly string[], name: string): string | null {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1] ?? "";
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : null;
}

/** Decides the mode; throws when `--send` is asked on mainnet without the env flag. */
export function setupGate(i: SetupGateInput): SetupGate {
  const mainnet = i.cluster === "mainnet-beta";
  const send = i.argv.includes("--send");
  const simulate = i.argv.includes("--simulate");
  if (!send) return { mode: simulate ? "simulate" : "dry", mainnet, confirm: null };
  if (!mainnet) return { mode: "send", mainnet, confirm: null };
  if (i.env.UNZEEN_ALLOW_MAINNET !== "yes" || i.env.UNZEEN_ALLOW_MAINNET_SETUP?.trim() !== "yes") {
    throw new Error("mainnet --send refused: set UNZEEN_ALLOW_MAINNET=yes and UNZEEN_ALLOW_MAINNET_SETUP=yes for this run only (lead's approval)");
  }
  return { mode: "send", mainnet, confirm: argValue(i.argv, "--confirm-mainnet") };
}

/**
 * Explicit confirmation before a mainnet send: the operator repeats the payer
 * address (flag or prompt). `ask` = null means no TTY.
 */
export async function confirmMainnet(payer: string, confirm: string | null, ask: ((q: string) => Promise<string>) | null): Promise<void> {
  if (confirm !== null) {
    if (confirm.trim() !== payer) throw new Error("--confirm-mainnet does not match the payer address: nothing sent");
    return;
  }
  if (!ask) throw new Error("mainnet send needs --confirm-mainnet <payer pubkey> (no TTY to ask)");
  const typed = await ask(`MAINNET: type the payer address ${payer} to send: `);
  if (typed.trim() !== payer) throw new Error("confirmation did not match: nothing sent");
}

/** Prompt on a TTY, null otherwise. */
export function ttyAsk(): ((q: string) => Promise<string>) | null {
  if (!process.stdin.isTTY) return null;
  return async (q) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(q);
    } finally {
      rl.close();
    }
  };
}

/** Network fee + priority + Sender tip headroom of one setup tx, lamports (0.002 SOL). */
export const SETUP_FEE_MARGIN_LAMPORTS = 2_000_000n;

/**
 * SOL the payer must hold before the send: rent of every new account + fee margin.
 * Returns the missing part (0 = enough).
 */
export function setupFunding(rentLamports: readonly bigint[], balance: bigint, margin = SETUP_FEE_MARGIN_LAMPORTS): { need: bigint; missing: bigint } {
  const need = rentLamports.reduce((a, b) => a + b, 0n) + margin;
  return { need, missing: balance >= need ? 0n : need - balance };
}

/** Operator instruction when the payer is short: address + amount, the funding source rule. */
export function fundingHint(payer: string, missing: bigint, need: bigint): string {
  const sol = (l: bigint) => `${(Number(l) / 1e9).toFixed(6)} SOL`;
  return [
    `partner ${payer} holds less than needed: need ${sol(need)}, missing ${sol(missing)}`,
    `fund it from the OPERATOR's external wallet (never from a vault, never from the rebalance address), then re-run`,
  ].join("\n");
}
