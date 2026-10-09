import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { microsToMs, msToMicros } from "@localdot/protocol";
import { type Browser, chromium, type Page } from "@playwright/test";
import { type ClockPing, lowestRttSample } from "../src/session/clock-sync.ts";
import { createReadyCell, launchApp, rawInput, removeCell } from "./cells.ts";
import { desktopContainer, type RunningDaemon, startDaemon } from "./daemon.ts";

const USAGE =
  "usage: pnpm --filter @localdot/web calibrate --compositor off|on [--scale 1|2] [--trials 500] [--injectors xtest,driver] [--kinds click,key] [--page down|up] [--out <file>]";
const OPTIONS = new Set(["compositor", "scale", "trials", "injectors", "kinds", "page", "out"]);

function usage(problem: string): never {
  console.error(`${problem}\n${USAGE}`);
  process.exit(2);
}

// pnpm 10 forwards a literal "--" to the script, and pairing from it would read each option as the
// previous one's value; so it is skipped, and anything unknown or unpaired stops the run.
function parseArgs(argv: string[]): Map<string, string> {
  const rest = argv[0] === "--" ? argv.slice(1) : argv;
  if (rest.length % 2 !== 0) usage(`options come in pairs: ${rest.join(" ")}`);
  const parsed = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const name = /^--([a-z]+)$/.exec(rest[i] ?? "")?.[1];
    if (!name || !OPTIONS.has(name)) usage(`unknown option ${rest[i]}`);
    parsed.set(name, rest[i + 1] ?? "");
  }
  return parsed;
}

const oneOf = <T extends string>(value: string, allowed: readonly T[], what: string): T =>
  allowed.includes(value as T)
    ? (value as T)
    : usage(`${what} must be one of ${allowed.join(", ")}`);

const args = parseArgs(process.argv.slice(2));
// off: the gate, S6's conditions (compositor off, kiosk window), which validates the harness and
// writes no table. on: the table, what users see (compositor on with Task 1's vsync mode, a
// maximized window through localdot-chromium; a kiosk window is unredirected and bypasses the
// compositor).
const compositor = oneOf(args.get("compositor") ?? "", ["off", "on"] as const, "--compositor");
const scale = oneOf(args.get("scale") ?? "2", ["1", "2"] as const, "--scale") === "1" ? 1 : 2;
const trials = Number(args.get("trials") ?? 500);
if (!Number.isInteger(trials) || trials < 1) usage("--trials must be a positive integer");
const injectors = (args.get("injectors") ?? "xtest")
  .split(",")
  .map((i) => oneOf(i, ["xtest", "driver"] as const, "--injectors"));
const kinds = (args.get("kinds") ?? "click,key")
  .split(",")
  .map((k) => oneOf(k, ["click", "key"] as const, "--kinds"));
const pageVariant = oneOf(args.get("page") ?? "down", ["down", "up"] as const, "--page");
const home = process.env.LOCALDOT_HOME || join(homedir(), ".localdot");
const out = args.get("out") ?? join(home, "calibration.json");
const gate = compositor === "off";
// Only the table on the press-acting page feeds the onsets: the gate and the release-acting
// control are a record, never the table.
const writesTable = !gate && pageVariant === "down" && trials >= 500;
const W = 1280 * scale;
const H = 800 * scale;

// S6 reference (xdotool stand-in, M3 Ultra, no compositor): p50 / p99 per group; the gate reads them.
// No driver key group (P3-C9).
const S6: Record<
  "xtest" | "driver",
  Partial<Record<"click" | "key", Record<1 | 2, readonly [number, number]>>>
> = {
  xtest: { click: { 1: [9.6, 19.6], 2: [13.8, 23.1] }, key: { 1: [10.2, 19.1], 2: [16.3, 29.3] } },
  driver: { click: { 1: [5.9, 18.4], 2: [14.2, 26.4] } },
};

type ProbeWindow = Window & {
  __localdot?: {
    probe?: {
      start(
        rect: { x: number; y: number; width: number; height: number },
        threshold?: number,
      ): void;
      clear(): void;
      flips(): { at: number }[];
    };
  };
};

// Nearest-rank percentile: the smallest value with at least p % of the sample at or below it
// (n = 500, p = 99 → the 495th value, index 494).
const pct = (sorted: number[], p: number) =>
  sorted[
    Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))
  ] as number;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// xfwm4 applies use_compositing live; xfconf-query reaches the session's xfconfd on its bus.
function setCompositing(cellId: string, on: boolean): void {
  execFileSync(
    "docker",
    [
      "exec",
      "-u",
      "abc",
      "-e",
      "DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/localdot-session-bus",
      desktopContainer(cellId),
      "xfconf-query",
      "-c",
      "xfwm4",
      "-p",
      "/general/use_compositing",
      "-s",
      String(on),
    ],
    { stdio: "ignore" },
  );
}

// The pings run in the page, whose clock the probe's flips use; the arithmetic is clock-sync.ts's.
async function viewerClock(page: Page, origin: string, token: string) {
  const pings: ClockPing[] = await page.evaluate(
    async ({ origin, token }) => {
      const taken: { sent: number; got: number; nowMicros: number }[] = [];
      for (let i = 0; i < 20; i++) {
        const sent = performance.timeOrigin + performance.now();
        const res = await fetch(`${origin}/api/clock`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const { nowMicros } = (await res.json()) as { nowMicros: number };
        taken.push({ sent, got: performance.timeOrigin + performance.now(), nowMicros });
      }
      return taken;
    },
    { origin, token },
  );
  return lowestRttSample(pings);
}

async function run() {
  const daemon: RunningDaemon = await startDaemon();
  let cellId = "";
  let browser: Browser | undefined;
  try {
    const cell = await createReadyCell(daemon, scale);
    cellId = cell.id;
    setCompositing(cellId, !gate);
    const windowArgs = gate ? ["--kiosk"] : ["--new-window"];
    await launchApp(daemon, cellId, "chromium", [
      ...windowArgs,
      `file:///opt/localdot/flash.html${pageVariant === "up" ? "#up" : ""}`,
    ]);
    await sleep(8000);
    // One untimed click: the page takes keyboard focus for the key groups.
    await rawInput(daemon, cellId, {
      input: { kind: "click", button: "left", count: 1, at: { x: W / 2, y: H / 2 } },
    });
    browser = await chromium.launch({ channel: "chrome" });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    await page.goto(`${daemon.origin}/?probe=1#token=${daemon.token}`);
    await page.getByTestId("hud-status").filter({ hasText: "Ready" }).waitFor({ timeout: 120_000 });
    await page.waitForFunction(
      () => Number(document.querySelector("canvas.stage-canvas")?.getAttribute("data-frames")) > 0,
      null,
      { timeout: 60_000 },
    );
    await page.evaluate(
      ({ W, H }) =>
        (window as ProbeWindow).__localdot?.probe?.start(
          { x: W / 2 - 16, y: H / 2 - 16, width: 32, height: 32 },
          128,
        ),
      { W, H },
    );

    const pass = gate ? "gate, compositor off" : "table, compositor on";
    const results: Record<string, unknown> = {};
    const onsetMs: Record<string, Record<string, Record<string, number>>> = {};
    for (const injector of injectors) {
      for (const kind of kinds) {
        const ref = S6[injector][kind];
        if (!ref) {
          console.log(
            `${scale}x ${injector} ${kind}: not measured (P3-C9: the driver's key path produces no raw press)`,
          );
          continue;
        }
        const latencies: number[] = [];
        let missed = 0;
        // One untimed input: a still screen gives the probe no baseline (S6).
        await rawInput(daemon, cellId, {
          input:
            kind === "click"
              ? { kind: "click", button: "left", count: 1, at: { x: W / 2, y: H / 2 } }
              : { kind: "key", combo: ["space"] },
          injector,
        });
        await sleep(600);
        await page.evaluate(() => (window as ProbeWindow).__localdot?.probe?.clear());
        let clockSample = await viewerClock(page, daemon.origin, daemon.token);
        for (let i = 0; i < trials; i++) {
          if (i % 100 === 0 && i > 0)
            clockSample = await viewerClock(page, daemon.origin, daemon.token);
          const side = i % 2 === 0 ? -1 : 1;
          const point = { x: Math.round(W / 2 + (side * W) / 32), y: Math.round(H / 2) };
          const before = await page.evaluate(
            () => (window as ProbeWindow).__localdot?.probe?.flips().length ?? 0,
          );
          const res = await rawInput(daemon, cellId, {
            input:
              kind === "click"
                ? { kind: "click", button: "left", count: 1, at: point }
                : { kind: "key", combo: ["space"] },
            injector,
          });
          const flip = await page
            .waitForFunction(
              (n) => ((window as ProbeWindow).__localdot?.probe?.flips().length ?? 0) > n,
              before,
              { timeout: 3000 },
            )
            .then(
              () =>
                page.evaluate((n) => (window as ProbeWindow).__localdot?.probe?.flips()[n], before),
              () => undefined,
            );
          if (!flip) {
            missed += 1;
          } else {
            const frameMicros = msToMicros(flip.at) + clockSample.offsetMicros;
            latencies.push(microsToMs(frameMicros - res.pressDaemonMicros));
          }
          await sleep(400 + Math.random() * 16.7);
        }
        const sorted = [...latencies].sort((a, b) => a - b);
        const stats = {
          n: sorted.length,
          missed,
          p5: pct(sorted, 5),
          p50: pct(sorted, 50),
          p95: pct(sorted, 95),
          p99: pct(sorted, 99),
          max: sorted.at(-1) ?? 0,
          min: sorted[0] ?? 0,
        };
        const line = `${scale}x ${injector} ${kind} [${pass}]: n=${stats.n} missed=${missed} p5=${stats.p5.toFixed(1)} p50=${stats.p50.toFixed(1)} p95=${stats.p95.toFixed(1)} p99=${stats.p99.toFixed(1)} max=${stats.max.toFixed(1)} ms`;
        const fewMissed = missed <= trials * 0.01;
        if (gate) {
          const [refP50, refP99] = ref[scale];
          const verdict =
            Math.abs(stats.p50 - refP50) <= 3 && stats.p99 <= refP99 + 16.7 && fewMissed
              ? "PASS"
              : "CHECK";
          console.log(`${line} (S6 p50 ${refP50} / p99 ${refP99}) ${verdict}`);
          results[`${injector}.${kind}`] = { ...stats, latencies, verdict };
        } else {
          console.log(
            `${line} ${fewMissed ? `→ onset ${stats.p99.toFixed(1)} ms` : "CHECK: over 1 % of the flips missed, not written"}`,
          );
          results[`${injector}.${kind}`] = { ...stats, latencies };
          if (writesTable && fewMissed) {
            const byKind = onsetMs[injector] ?? {};
            byKind[kind] = {
              ...(byKind[kind] ?? {}),
              [String(scale)]: Number(stats.p99.toFixed(1)),
            };
            onsetMs[injector] = byKind;
          }
        }
      }
    }
    await browser.close();

    mkdirSync("e2e/out", { recursive: true });
    const record = `e2e/out/calibrate-${scale}x-${compositor}-${pageVariant}-${Date.now()}.json`;
    writeFileSync(
      record,
      JSON.stringify({ scale, trials, compositor, pageVariant, results }, null, 1),
    );
    if (!writesTable || Object.keys(onsetMs).length === 0) {
      console.log(`recorded in ${record}; ${out} is unchanged`);
      return;
    }
    let existing: { onsetMs?: Record<string, Record<string, Record<string, number>>> } = {};
    try {
      existing = JSON.parse(readFileSync(out, "utf8"));
    } catch {}
    const merged = structuredClone(existing.onsetMs ?? {});
    for (const [injector, byKind] of Object.entries(onsetMs)) {
      const row = merged[injector] ?? {};
      for (const [kind, byScale] of Object.entries(byKind))
        row[kind] = { ...(row[kind] ?? {}), ...byScale };
      merged[injector] = row;
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      `${JSON.stringify({ v: 1, measuredAt: new Date().toISOString(), machine: hostname(), trials, onsetMs: merged }, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(`wrote ${out}; recorded in ${record}`);
  } finally {
    await browser?.close();
    if (cellId) await removeCell(daemon, cellId);
    await daemon.stop();
  }
}

await run();
