import { defineConfig } from "@playwright/test";

const chrome = { browserName: "chromium" as const, channel: "chrome" };
const webkit = { browserName: "webkit" as const };
const desktop = (width: number, height: number) => ({
  viewport: { width, height },
  deviceScaleFactor: 1,
});
const phone = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};

// The UI matrix. Every test boots its own fixture daemon on a port the system picks, so workers
// run side by side.
export default defineConfig({
  testDir: "e2e/ui",
  testMatch: "*.spec.ts",
  globalSetup: "./e2e/ui/fresh-build.ts",
  snapshotPathTemplate: "{testDir}/../__screenshots__/{projectName}/{arg}{ext}",
  outputDir: "e2e/out/ui",
  fullyParallel: true,
  workers: 4,
  retries: 0,
  reporter: "list",
  timeout: 60_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: "disabled", caret: "hide" },
  },
  use: {
    reducedMotion: "reduce",
    colorScheme: "dark",
    locale: "en-GB",
    timezoneId: "UTC",
    serviceWorkers: "block",
  },
  projects: [
    { name: "c14", use: { ...chrome, ...desktop(1440, 900) } },
    { name: "c12", use: { ...chrome, ...desktop(1280, 800) } },
    { name: "c39", use: { ...chrome, ...phone } },
    { name: "w14", use: { ...webkit, ...desktop(1440, 900) } },
    { name: "w39", use: { ...webkit, ...phone } },
  ],
});
