import { defineConfig } from "@playwright/test";
// Explicit opt-in only. Ordinary UI CI never creates a container or contacts a model.
export default defineConfig({
  testDir: "e2e",
  testMatch: "assembled-app.docker.spec.ts",
  timeout: 360_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  outputDir: "e2e/out/assembled",
  use: {
    channel: "chrome",
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "assembled-hidpi" },
    {
      name: "assembled-phone",
      use: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
