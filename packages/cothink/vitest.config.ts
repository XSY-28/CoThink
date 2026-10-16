import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: {
      "@onevcat/argue/agent-sync/project": resolve(__dirname, "../argue/src/agent-sync/project/index.ts"),
      "@onevcat/argue/agent-sync/legacy-v1": resolve(__dirname, "../argue/src/agent-sync/legacy-v1/index.ts"),
      "@onevcat/argue/agent-sync": resolve(__dirname, "../argue/src/agent-sync/index.ts"),
      "@onevcat/argue": resolve(__dirname, "../argue/src/index.ts")
    }
  }
});
