import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // Unit tests import the published entry point (`dom2pdf-js`) from CLI
    // code; alias it to core *source* so unit runs never depend on a prior
    // build and always test the current code.
    alias: {
      "dom2pdf-js": path.join(root, "packages/core/src/index.ts"),
      "dom2pdf-benchmark": path.join(root, "packages/benchmark/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
    passWithNoTests: false,
  },
});
