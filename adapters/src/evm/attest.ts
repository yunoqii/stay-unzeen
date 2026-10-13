import { getAddress, verifyTypedData, type Address, type Hex, type LocalAccount } from "viem";

/**
 * Verify on EVM (docs/analysis/robinhood-chain.md §6): every pool address signs
 * an EIP-712 statement of the snapshot, no transaction needed. The browser
 * checks it with viem `verifyTypedData`. Domain is bound to the chain id, so a
 * Robinhood snapshot can never be replayed as a Solana one or across chains.
 */
export const VERIFY_TYPES = {
  Snapshot: [
    { name: "snapshotId", type: "string" },
    { name: "address", type: "address" },
    { name: "blockNumber", type: "uint256" },
  ],
} as const;

export function verifyDomain(chainId: number) {
  return { name: "unzeen-verify", version: "1", chainId } as const;
}

export interface VerifySnapshotStatement {
  snapshotId: string;
  address: Address;
  blockNumber: bigint;
}

/** Signs with the address's own key (the statement says "I, <address>, am a pool address in <snapshotId>"). */
export async function signVerifySnapshot(account: LocalAccount, chainId: number, snapshotId: string, blockNumber: bigint): Promise<Hex> {
  if (!account.signTypedData) throw new Error("account cannot sign typed data");
  return account.signTypedData({
    domain: verifyDomain(chainId),
    types: VERIFY_TYPES,
    primaryType: "Snapshot",
    message: { snapshotId, address: getAddress(account.address), blockNumber },
  });
}

export async function checkVerifySnapshot(chainId: number, st: VerifySnapshotStatement, signature: Hex): Promise<boolean> {
  return verifyTypedData({
    address: st.address,
    domain: verifyDomain(chainId),
    types: VERIFY_TYPES,
    primaryType: "Snapshot",
    message: { snapshotId: st.snapshotId, address: getAddress(st.address), blockNumber: st.blockNumber },
    signature,
  });
}
