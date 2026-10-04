import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  testMatch: "safety.docker.spec.ts",
  timeout: 240000,
  retries: 0,
  workers: 1,
  reporter: "list",
  outputDir: process.env.LOCALDOT_SAFETY_OUT ?? "e2e/out/safety",
  use: {
    channel: "chrome",
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    actionTimeout: 15000,
    navigationTimeout: 20000,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "safety-desktop" },
    {
      name: "safety-phone",
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
});
