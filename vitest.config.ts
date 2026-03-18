/**
 * @file vitest.config.ts
 * @description Vitest configuration for the stocks-interface project.
 *
 * Uses the Node test environment and includes all test files under
 * `src/` matching `*.test.ts`.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: true,
  },
});
