import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // e2e/ui runs under playwright.ui.config.ts, with its own matrix and build check.
  testIgnore: ["**/*.docker.spec.ts", "ui/**"],
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
  projects: [
    { name: "hidpi", use: { deviceScaleFactor: 2 } },
    { name: "lodpi", testMatch: /pixel-oracle\.spec\.ts/, use: { deviceScaleFactor: 1 } },
  ],
});
