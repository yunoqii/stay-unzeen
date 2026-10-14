import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: {
    // pump-sdk 4.0.0's ESM build fails in Node: its dependency
    // @pump-fun/agent-payments-sdk does `import { BN } from "@coral-xyz/anchor"`
    // (a CJS module). Force the CJS build, same as the runtime package uses.
    alias: [
      { find: "@pump-fun/pump-sdk", replacement: require.resolve("@pump-fun/pump-sdk") },
      // Tests only: the hood e2e test loads the browser's Verify code (web/lib/verify) as-is;
      // its "@/..." imports are the Next.js alias for the web root. adapters/src never uses "@/".
      { find: /^@\/(.*)$/, replacement: `${path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web")}/$1` },
    ],
  },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
