import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BrowserStatus } from "../../../../packages/protocol/src/browser-control.ts";
import { runBrowser } from "./cli.ts";

const CELL = "01J00000000000000000000001",
  OTHER = "01J00000000000000000000003",
  TOKEN = "private-synthetic-token-0000000000000";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

function fixture(cells: { id: string; state: string }[], statuses: BrowserStatus[]) {
  const home = mkdtempSync(join(tmpdir(), "localdot-browser-"));
  roots.push(home);
  chmodSync(home, 0o700);
  writeFileSync(join(home, "daemon-token"), TOKEN, { mode: 0o600 });
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url).replace("http://127.0.0.1:4750", "");
    if (path === "/api/cells") return Response.json(cells);
    if (init?.method === "POST") return Response.json({ state: "restarting" }, { status: 202 });
    return Response.json(statuses.length > 1 ? statuses.shift() : statuses[0]);
  });
  const out = vi.fn(),
    err = vi.fn();
  const run = (operation: "status" | "restart", cellId?: string) =>
    runBrowser(
      { home, port: 4750, signal: new AbortController().signal, operation, cellId },
      { out, err, fetch: fetchImpl },
    );
  return { fetchImpl, out, err, run };
}

it("shows each computer's web browser and what last went wrong with it", async () => {
  const f = fixture(
    [
      { id: CELL, state: "ready" },
      { id: OTHER, state: "stopped" },
    ],
    [
      {
        state: "ready",
        restarts: 2,
        problem: "A tab crashed (renderer oom) and was reloaded.",
        problemAt: "2026-10-26T12:00:00.000Z",
      },
      { state: "off", problem: "The computer is not running." },
    ],
  );
  expect(await f.run("status")).toBe(0);
  const printed = f.out.mock.calls.map(([line]) => line);
  expect(printed[0]).toBe(`Computer ${CELL}: web browser ready, restarted in place 2 times`);
  expect(printed[1]).toMatch(/A tab crashed \(renderer oom\) and was reloaded\.$/u);
  expect(printed[2]).toBe(`Computer ${OTHER}: web browser off`);
  expect(JSON.stringify(f.out.mock.calls)).not.toContain(TOKEN);
});

it("restarts the running computer's browser and waits until it is back", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const f = fixture(
    [{ id: CELL, state: "ready" }],
    [{ state: "ready" }, { state: "restarting" }, { state: "starting" }, { state: "ready" }],
  );
  const done = f.run("restart");
  await vi.advanceTimersByTimeAsync(5000);
  expect(await done).toBe(0);
  expect(
    f.fetchImpl.mock.calls.some(
      ([url, init]) =>
        String(url).endsWith(`/api/cells/${CELL}/browser/restart`) && init?.method === "POST",
    ),
  ).toBe(true);
  expect(f.out).toHaveBeenLastCalledWith("The web browser is running again.");
});

it("asks which computer when more than one is running, and refuses an off browser", async () => {
  const two = fixture(
    [
      { id: CELL, state: "ready" },
      { id: OTHER, state: "ready" },
    ],
    [{ state: "ready" }],
  );
  expect(await two.run("restart")).toBe(2);
  expect(two.err).toHaveBeenCalledWith(expect.stringContaining("--cell"));
  const off = fixture(
    [{ id: CELL, state: "ready" }],
    [{ state: "off", problem: "keyd is offline" }],
  );
  expect(await off.run("restart")).toBe(1);
  expect(off.fetchImpl.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});

it("says why a browser is off, what clears it and when localDot tries again", async () => {
  const f = fixture(
    [{ id: CELL, state: "ready" }],
    [
      {
        state: "off",
        reason: "recovering",
        problem: "localDot couldn't yet confirm that the previous web browser stopped.",
        clears: "Nothing: localDot tries again by itself.",
        retryAt: "2026-10-29T08:00:30.000Z",
      },
    ],
  );
  expect(await f.run("status")).toBe(0);
  const printed = f.out.mock.calls.map(([line]) => line);
  expect(printed[0]).toBe(`Computer ${CELL}: web browser off (recovering)`);
  expect(printed[1]).toBe("  localDot couldn't yet confirm that the previous web browser stopped.");
  expect(printed[2]).toBe(
    `  Nothing: localDot tries again by itself. localDot tries again at ${new Date("2026-10-29T08:00:30.000Z").toLocaleTimeString()}.`,
  );
});
