import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Pin to a date supported by the bundled workerd binary.
      wrangler: {
        configPath: "./test/wrangler.d1.toml",
      },
      miniflare: {
        // Must not exceed the newest date supported by the locked workerd binary.
        compatibilityDate: "2026-07-22",
        d1Databases: ["DB"],
      },
    }),
  ],
  test: {
    include: ["packages/**/*.d1.test.ts"],
    testTimeout: 30_000,
  },
});
