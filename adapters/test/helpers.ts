import fs from "node:fs";
import path from "node:path";
import { PUMP_SDK, type FeeConfig, type Global } from "@pump-fun/pump-sdk";
import { PublicKey, type AccountInfo } from "@solana/web3.js";

interface RawAcc {
  owner: string;
  data: string;
}

function acc(raw: RawAcc): AccountInfo<Buffer> {
  return { data: Buffer.from(raw.data, "base64"), owner: new PublicKey(raw.owner), executable: false, lamports: 1 };
}

/** Real devnet Global + FeeConfig snapshot (scripts/snapshot-params.ts). */
export function loadParams(): { global: Global; feeConfig: FeeConfig } {
  const file = path.resolve(__dirname, "fixtures/pump-params.json");
  const j = JSON.parse(fs.readFileSync(file, "utf8")) as { global: RawAcc; feeConfig: RawAcc };
  return { global: PUMP_SDK.decodeGlobal(acc(j.global)), feeConfig: PUMP_SDK.decodeFeeConfig(acc(j.feeConfig)) };
}
