import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 420_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  outputDir: "e2e/out/results",
  use: {
    channel: "chrome",
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  },
});
