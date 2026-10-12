/**
 * DEV ONLY: serves the published token media (UNZEEN_METADATA_DIR, default
 * $UNZEEN_HOME/<cluster>/media) on 127.0.0.1, so a local UNZEEN_METADATA_BASE_URL
 * resolves. Production: nginx / CDN serving the same directory.
 *   pnpm media:serve [port=8787]   ->  http://127.0.0.1:8787/media/<sha>.<ext>
 * No access log (no IPs are recorded).
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { loadConfig } from "../src/config";
import { loadRepoEnv } from "../src/env";
import { defaultMediaDir } from "../src/relayer/runtime";

loadRepoEnv();
const cfg = loadConfig();
const dir = process.env.UNZEEN_METADATA_DIR?.trim() || defaultMediaDir(cfg);
const port = Number(process.argv[2] ?? 8787);
const TYPES: Record<string, string> = { ".json": "application/json", ".jpg": "image/jpeg", ".png": "image/png" };

http
  .createServer((req, res) => {
    const m = /^\/media\/([0-9a-f]{40}\.(?:json|jpg|png))$/.exec(req.url ?? "");
    const file = m ? path.join(dir, m[1]!) : null;
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*",
    });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, "127.0.0.1", () => console.log(`serving ${dir} at http://127.0.0.1:${port}/media/`));
