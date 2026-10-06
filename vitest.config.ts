import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@remote-mcp/contracts": `${root}packages/contracts/src/index.ts`,
      "@remote-mcp/control-plane": `${root}packages/control-plane/src/index.ts`,
      "@remote-mcp/persistence": `${root}packages/persistence/src/index.ts`,
      "@remote-mcp/runtime": `${root}packages/runtime/src/index.ts`,
      "@remote-mcp/adapters": `${root}packages/adapters/src/index.ts`,
      "@remote-mcp/test-support": `${root}packages/test-support/src/index.ts`
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
