/**
 * Read-only check of the intel read providers (task 3, day 6–7):
 *   pnpm intel:probe [devnet|mainnet|both] [wsSeconds=20]
 * - HTTP: getSlot, getMultipleAccounts, getTokenLargestAccounts on the READ
 *   provider (Shyft) and, if configured, on the INDEX provider;
 * - WS: one accountSubscribe on the Clock sysvar for N seconds (counts
 *   notifications), on SOLANA_READ_WS_URL_* or https->wss of the read URL.
 * Only public data, no transactions. Prints statuses and error codes; never
 * a URL, key or response body beyond a short provider error string.
 */
import https from "node:https";
import { loadRepoEnv, redactSecrets } from "../src/env";
import { loadIntelConfig } from "../src/intel/config";

loadRepoEnv();
const TEST_MINT = {
  devnet: "2pYxXseqGTcBSKL5MtoXW7u86p2KAUs6b8r523Rwbp4T", // pump create_v2 devnet mint (token-intel.md)
  "mainnet-beta": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK (public, large)
} as const;
const CLOCK = "SysvarC1ock11111111111111111111111111111111";

const clean = (s: string) => redactSecrets(s).replace(/api[_-]?key=[^&\s"']+/gi, "api_key=***").slice(0, 160);

async function rpc(url: string, method: string, params: unknown[]): Promise<string> {
  const t = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    const txt = await r.text();
    let j = null as { error?: unknown; result?: unknown } | null;
    try {
      j = JSON.parse(txt) as { error?: unknown; result?: unknown };
    } catch {
      /* non-json */
    }
    const ms = Date.now() - t;
    if (j?.error) return `HTTP ${r.status} ${ms}ms ERROR ${clean(JSON.stringify(j.error))}`;
    if (!j) return `HTTP ${r.status} ${ms}ms non-JSON: ${clean(txt.replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, "<addr>"))}`;
    return `HTTP ${r.status} ${ms}ms ok`;
  } catch (e) {
    return `failed: ${clean(e instanceof Error ? e.message : String(e))}`;
  }
}

/** Raw handshake status (why a WS fails: 101 / 429 / 503 ...). */
function handshake(wsUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const u = new URL(wsUrl.replace(/^wss:/, "https:"));
    const req = https.request({
      host: u.hostname,
      path: `${u.pathname || "/"}${u.search}`,
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" },
      timeout: 10_000,
    });
    req.on("upgrade", (res, sock) => {
      sock.destroy();
      resolve(`handshake ${res.statusCode}`);
    });
    req.on("response", (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve(`handshake HTTP ${res.statusCode} ${clean(b.trim())}`));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve(`handshake error ${clean(e.message)}`));
    req.end();
  });
}

function subscribe(wsUrl: string, seconds: number): Promise<string> {
  return new Promise((resolve) => {
    let n = 0;
    let sub = "no reply";
    let settled = false;
    const ws = new WebSocket(wsUrl);
    const finish = (why: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* closed */
      }
      resolve(`accountSubscribe: ${sub}, notifications=${n} in ${seconds}s (${why})`);
    };
    const timer = setTimeout(() => finish("window end"), seconds * 1000);
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "accountSubscribe", params: [CLOCK, { encoding: "base64", commitment: "confirmed" }] }));
    ws.onmessage = (ev) => {
      const j = JSON.parse(String(ev.data)) as { id?: number; error?: unknown; method?: string };
      if (j.id === 1) sub = j.error ? `ERROR ${clean(JSON.stringify(j.error))}` : "ok";
      if (j.method === "accountNotification") n++;
    };
    ws.onerror = () => finish("socket error");
    ws.onclose = (e) => finish(`closed ${e.code}`);
  });
}

async function probe(cluster: "devnet" | "mainnet-beta", wsSeconds: number): Promise<void> {
  const cfg = loadIntelConfig({ ...process.env, SOLANA_CLUSTER: cluster, UNZEEN_SOLANA_CLUSTER: cluster });
  console.log(`\n== ${cluster}: read=${cfg.readSource} index=${cfg.indexSource ?? "none"}`);
  const mint = TEST_MINT[cluster];
  console.log(`read  getSlot                 ${await rpc(cfg.readUrl, "getSlot", [])}`);
  console.log(`read  getMultipleAccounts     ${await rpc(cfg.readUrl, "getMultipleAccounts", [[mint], { encoding: "base64" }])}`);
  console.log(`read  getTokenLargestAccounts ${await rpc(cfg.readUrl, "getTokenLargestAccounts", [mint])}`);
  if (cfg.indexUrl) console.log(`index getTokenLargestAccounts ${await rpc(cfg.indexUrl, "getTokenLargestAccounts", [mint])}`);
  if (cfg.readWsUrl) {
    console.log(`ws    ${await handshake(cfg.readWsUrl)}`);
    console.log(`ws    ${await subscribe(cfg.readWsUrl, wsSeconds)}`);
  }
}

async function main(): Promise<void> {
  const which = process.argv[2] ?? "both";
  const secs = Number(process.argv[3] ?? 20);
  if (which === "devnet" || which === "both") await probe("devnet", secs);
  if (which === "mainnet" || which === "both") await probe("mainnet-beta", secs);
}

main().catch((e) => {
  console.error(`probe failed: ${clean(e instanceof Error ? e.message : String(e))}`);
  process.exit(1);
});
