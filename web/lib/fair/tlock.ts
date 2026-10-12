// Sealing a bid with drand tlock in the browser (tlock-js@0.9.0). The chain client is STATIC: it only
// answers info() with hard-coded quicknet parameters. Nothing here ever reaches drand or any third
// party (CSP would block it anyway): encryption needs the public key and the round number, nothing else.

import { Buffer, defaultChainInfo, timelockDecrypt, timelockEncrypt, type ChainClient, type ChainInfo } from "tlock-js";
import type { FairLaunchParams } from "@/lib/api/types";
import { parseTlockArmor } from "./armor";
import { assertQuicknet, QUICKNET } from "./drand";

const INFO: ChainInfo = {
  public_key: QUICKNET.publicKey,
  period: QUICKNET.period,
  genesis_time: QUICKNET.genesis,
  hash: QUICKNET.chainHash,
  groupHash: "f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e",
  schemeID: QUICKNET.scheme,
  metadata: { beaconID: "quicknet" },
};

/** Guard against a swapped dependency: the library's own quicknet must equal ours. */
function assertLibrary() {
  if (defaultChainInfo.hash !== QUICKNET.chainHash || defaultChainInfo.public_key !== QUICKNET.publicKey || defaultChainInfo.schemeID !== QUICKNET.scheme)
    throw new Error("tlock-js quicknet parameters changed");
}

type Beacon = { round: number; randomness: string; signature: string };

/**
 * Offline ChainClient. `get`/`latest` throw unless a beacon was handed in explicitly (tests only:
 * decrypting needs the round signature, which the browser never fetches).
 */
export function staticQuicknetClient(beacons: Beacon[] = []): ChainClient {
  return {
    options: { disableBeaconVerification: true, noCache: true },
    chain: () => ({ baseUrl: "", info: async () => INFO }),
    latest: async () => {
      throw new Error("offline: no drand access from the browser");
    },
    get: async (round: number) => {
      const b = beacons.find((x) => x.round === round);
      if (!b) throw new Error("offline: no drand access from the browser");
      return b;
    },
  };
}

/** age-armored tlock ciphertext of a 64-byte bid plaintext, sealed to `round`. */
export async function sealBid(round: number, plaintext: Uint8Array, drand: FairLaunchParams["drand"] | undefined): Promise<string> {
  assertLibrary();
  assertQuicknet(drand);
  if (!Number.isSafeInteger(round) || round < 1) throw new Error("bad drand round");
  const armor = await timelockEncrypt(round, Buffer.from(plaintext), staticQuicknetClient());
  const head = parseTlockArmor(armor);
  if (!head || head.round !== round || head.chainHash !== QUICKNET.chainHash) throw new Error("tlock output does not carry the expected round");
  return armor;
}

/** Tests: open a ciphertext with a known round signature. */
export async function openWithBeacon(ciphertext: string, beacon: Beacon): Promise<Uint8Array> {
  return new Uint8Array(await timelockDecrypt(ciphertext, staticQuicknetClient([beacon])));
}
