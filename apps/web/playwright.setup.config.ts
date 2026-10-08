import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  testMatch: "setup.spec.ts",
  tsconfig: "./e2e/tsconfig.setup.json",
  timeout: 30000,
  retries: 0,
  workers: 1,
  reporter: "list",
  outputDir: process.env.LOCALDOT_SETUP_OUT ?? "e2e/out/setup",
  use: {
    ...(process.env.LOCALDOT_TEST_CHROMIUM
      ? { launchOptions: { executablePath: process.env.LOCALDOT_TEST_CHROMIUM } }
      : { channel: "chrome" }),
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    actionTimeout: 5000,
    navigationTimeout: 10000,
  },
  projects: [
    { name: "setup-desktop" },
    { name: "setup-phone", use: { viewport: { width: 390, height: 844 } } },
  ],
});
