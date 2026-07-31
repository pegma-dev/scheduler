import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**", "**/*.d1.test.ts"],
    globalSetup: ["./test/azurite.ts"],
    testTimeout: 30_000,
  },
});
