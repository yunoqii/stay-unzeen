/**
 * Bags API key by wallet signature (agent auth), signed by the pool's SEPARATE Bags auth key
 * (m/44'/501'/2147483645'/5' of the creator master seed: never a vault, never a creator).
 *
 *   pnpm bags:auth                         # prints the auth address and the plan; no network
 *   pnpm bags:auth --register [--key-name unzeen]
 *                                          # OWNER ONLY: creates a Bags account + API key
 *   pnpm bags:auth --register --auth-code <code> --mfa <code>   # if Bags asks for MFA
 *
 * The key is written to <keys dir>/bags-api-key (0600) and printed once; put it in the repo-root
 * .env as BAGS_API_KEY (git-ignored). What Bags learns: the auth address, our server IP.
 */
import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import { loadConfig } from "../src/config";
import { signDetached } from "../src/ed25519";
import { loadRepoEnv, redactSecrets } from "../src/env";
import { BagsApi, deriveBagsAuthKeypair, deriveBagsFunderKeypair } from "../src/bags";
import { openKeys } from "../src/relayer/runtime";

loadRepoEnv();
const argv = process.argv.slice(2);
const arg = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function main(): Promise<void> {
  const cfg = loadConfig();
  const keys = await openKeys(cfg, process.env, (m) => console.error(`WARN ${m}`));
  const auth = deriveBagsAuthKeypair(keys.creatorSeed);
  console.log(`Bags auth address (signs the challenge only): ${auth.publicKey.toBase58()}`);
  console.log(`Bags launch-wallet funder (fund it with SOL, never from a vault): ${deriveBagsFunderKeypair(keys.creatorSeed).publicKey.toBase58()}`);
  if (!argv.includes("--register")) {
    console.log("Plan: POST /agent/v2/auth/init {address} -> sign the base58 challenge -> POST /agent/v2/auth/callback -> API key.");
    console.log("This creates a Bags account for the auth address. Owner decision: re-run with --register.");
    return;
  }
  const api = new BagsApi(null);
  const keyName = arg("--key-name") ?? "unzeen";
  let res;
  if (arg("--auth-code")) {
    res = await api.authCallback({ authCode: arg("--auth-code")!, mfaCode: arg("--mfa") ?? "", keyName });
  } else {
    const ch = await api.authInit(auth.publicKey.toBase58());
    const signature = signDetached(auth, bs58.decode(ch.message)); // base58 ed25519 over the decoded challenge
    res = await api.authCallback({ signature, address: auth.publicKey.toBase58(), nonce: ch.nonce, keyName });
  }
  if (res.mfaRequired) {
    console.log(`MFA required: re-run with --register --auth-code ${res.authCode} --mfa <code>`);
    return;
  }
  if (!res.apiKey) throw new Error("no API key in the answer");
  const file = path.join(cfg.keysDir, "bags-api-key");
  fs.writeFileSync(file, res.apiKey, { mode: 0o600 });
  console.log(`API key written to ${file} (0600). Add BAGS_API_KEY=<that key> to the repo-root .env; key id ${res.keyId ?? "?"}.`);
}

main().catch((e) => {
  console.error(redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 400));
  process.exit(1);
});
