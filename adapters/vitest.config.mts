import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: {
    // pump-sdk 4.0.0's ESM build fails in Node: its dependency
    // @pump-fun/agent-payments-sdk does `import { BN } from "@coral-xyz/anchor"`
    // (a CJS module). Force the CJS build, same as the runtime package uses.
    alias: { "@pump-fun/pump-sdk": require.resolve("@pump-fun/pump-sdk") },
  },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
