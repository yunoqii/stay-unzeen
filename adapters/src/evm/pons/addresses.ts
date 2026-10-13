import type { Address, Hex } from "viem";

/**
 * Pons V2 on Robinhood Chain mainnet (4663). No testnet deployment exists
 * (eth_getCode on 46630 is empty, docs/analysis/robinhood-chain.md §2).
 *
 * Code hashes = keccak256(eth_getCode) read 2026-10-13 (block ~87.76M) and
 * pinned: the adapter refuses to SEND if the live code differs (owner cannot
 * upgrade the factory, it is not a proxy, but a forwarder rotation or a new
 * factory must be reviewed before we route money through it). Reads never check.
 */
export const PONS_V2_MAINNET = {
  chainId: 4663,
  factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as Address,
  launchAndBuy: "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948" as Address,
  feeEscrow: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e" as Address,
  launchDeployer: "0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42" as Address,
  memeHook: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044" as Address,
  /** Uniswap v4 Universal Router (graduated tokens trade there; via LI.FI later). */
  universalRouter: "0x8876789976DeCBFcBBBe364623C63652Db8c0904" as Address,
  /** Launch config used for every Unzeen launch (only config on chain today). */
  launchConfigId: 0n,
  codeHash: {
    factory: "0x89a27da6f703e0a7cdd4f233e7cb57604ff75b164530962d3ff7cf8483a67d84" as Hex,
    launchAndBuy: "0xed9065184519eaa24a22c2556403d5d8bbb230ff94dbc5c414cf5028e20e52e7" as Hex,
    feeEscrow: "0xf25f75cfbc1637ba068dc34f69098fa4e8a80f8ee8fe7bf7820594e0b3fed2f1" as Hex,
  },
} as const;

export type PonsDeployment = {
  chainId: number;
  factory: Address;
  launchAndBuy: Address;
  feeEscrow: Address;
  launchConfigId: bigint;
  codeHash: { factory: Hex; launchAndBuy: Hex; feeEscrow: Hex };
};

/** Native ETH as the pair token (the only quote Unzeen uses on Pons). */
export const NATIVE_QUOTE: Address = "0x0000000000000000000000000000000000000000";
