import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { staleBuild, startUiFixture } from "../fixtures/start-ui-fixture.ts";
import { bootStep, uiScenario } from "../fixtures/ui-scenarios.ts";

// The harness's own plumbing. None of it needs a browser, so one project runs it.
test.beforeEach(() => {
  test.skip(test.info().project.name !== "c14", "The harness checks run once");
});

const WEB = fileURLToPath(new URL("../..", import.meta.url));

test("each build is checked against its own inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "ui-builds-"));
  const web = join(root, "apps/web");
  const write = (path: string, seconds: number) => {
    const file = join(web, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "");
    utimesSync(file, seconds, seconds);
  };
  const stale = () => [
    staleBuild("app", web) !== undefined,
    staleBuild("gallery", web) !== undefined,
  ];
  // A change to each input, and whether it leaves the app and the gallery build out of date.
  const CHANGES: [path: string, app: boolean, gallery: boolean][] = [
    ["src/main.tsx", true, true],
    ["../../packages/stage/src/index.ts", true, true],
    ["vite.config.ts", true, true],
    ["index.html", true, false],
    ["src/gallery/pages.tsx", false, true],
    ["gallery.html", false, true],
    ["vite.gallery.config.ts", false, true],
    ["e2e/fixtures/ui-assets/frame-1.webp", false, true],
    ["src/main.test.tsx", false, false],
  ];
  try {
    write("dist/index.html", 2000);
    write("dist-gallery/gallery.html", 2000);
    for (const [path] of CHANGES) write(path, 1000);
    expect(stale()).toEqual([false, false]);
    for (const [path, app, gallery] of CHANGES) {
      write(path, 3000);
      expect(stale(), path).toEqual([app, gallery]);
      write(path, 1000);
    }
    write("gallery.html", 3000);
    expect(staleBuild("gallery", web)).toBe(
      "dist-gallery/gallery.html is older than gallery.html: run pnpm --filter @localdot/web build:gallery.",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a scenario takes its step at boot only when it says so", () => {
  expect(bootStep({ about: "", boot: { QA_KEYS: "0" }, step: "approval", stepAtBoot: true })).toBe(
    "approval",
  );
  expect(bootStep({ about: "", boot: { QA_CELL: "paused" }, step: "cell/paused" })).toBe(undefined);
  expect(bootStep(uiScenario("approval"))).toBe("approval");
  expect(bootStep(uiScenario("paused"))).toBe(undefined);
});

test("a fixture whose launcher dies stops and removes its home", async () => {
  const launcher = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { startUiFixture } from "./e2e/fixtures/start-ui-fixture.ts";
      console.log(JSON.stringify(await startUiFixture({}, "ui-orphan")));
      setInterval(() => {}, 60_000);`,
    ],
    { cwd: WEB, stdio: ["ignore", "pipe", "inherit"] },
  );
  try {
    const lines = createInterface({ input: launcher.stdout });
    const line = await new Promise<string>((resolve) => lines.once("line", resolve));
    const fixture = JSON.parse(line) as { origin: string; home: string };
    expect(existsSync(fixture.home)).toBe(true);
    launcher.kill("SIGKILL");
    const answers = () =>
      fetch(`${fixture.origin}/__qa/state`).then(
        () => true,
        () => false,
      );
    await expect.poll(answers, { timeout: 10_000 }).toBe(false);
    await expect.poll(() => existsSync(fixture.home), { timeout: 5_000 }).toBe(false);
  } finally {
    launcher.kill("SIGKILL");
  }
});

test("a running fixture's errors reach the test output", async () => {
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
    written.push(String(chunk));
    return write.call(process.stderr, chunk, ...rest);
  }) as typeof process.stderr.write;
  const fixture = await startUiFixture({ QA_SCENARIO: "takeover" }, "ui-harness");
  try {
    // A question while control is handed over is refused, and the daemon logs the failed request.
    const reply = await fetch(`${fixture.origin}/__qa/ask`, { method: "POST" });
    expect(reply.status).toBe(500);
    await expect
      .poll(() => written.join(""))
      .toContain("request /__qa/ask failed (ControlHeldError)");
  } finally {
    process.stderr.write = write;
    await fixture.close();
  }
});
