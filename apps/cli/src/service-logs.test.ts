import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { printServiceLogs } from "./service-logs.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function home() {
  const dir = mkdtempSync(join(tmpdir(), "service-logs-"));
  dirs.push(dir);
  mkdirSync(join(dir, "logs"));
  return dir;
}

it("shows the end of each service log, whole lines only and with sign-in codes hidden", async () => {
  const dir = home();
  writeFileSync(
    join(dir, "logs", "daemon.log"),
    `${Array.from({ length: 150 }, (_, i) => `line ${i}`).join("\n")}\nopen http://127.0.0.1:4750/#code=abc\nhalf`,
  );
  writeFileSync(join(dir, "logs", "keyd.log"), "keyd ready\n");
  const out: string[] = [];
  const io = { out: (line: string) => out.push(line), err: () => {} };
  expect(
    await printServiceLogs({ home: dir, signal: new AbortController().signal, follow: false }, io),
  ).toBe(0);
  expect(out).toHaveLength(101);
  expect(out[0]).toBe("[daemon.log] line 51");
  expect(out[99]).toBe("[daemon.log] open http://127.0.0.1:4750/#code=[redacted]");
  expect(out[100]).toBe("[keyd.log] keyd ready");
});

it("follows appended lines until interrupted", async () => {
  const dir = home();
  writeFileSync(join(dir, "logs", "daemon.log"), "first\n");
  const controller = new AbortController();
  const out: string[] = [];
  const io = {
    out: (line: string) => {
      out.push(line);
      if (line.endsWith("first")) appendFileSync(join(dir, "logs", "daemon.log"), "second\n");
      if (line.endsWith("second")) controller.abort();
    },
    err: () => {},
  };
  await expect(
    printServiceLogs({ home: dir, signal: controller.signal, follow: true }, io),
  ).rejects.toThrow();
  expect(out).toEqual(["[daemon.log] first", "[daemon.log] second"]);
});

it("says when there is nothing to show", async () => {
  const out: string[] = [];
  await printServiceLogs(
    { home: home(), signal: new AbortController().signal, follow: false },
    { out: (line) => out.push(line), err: () => {} },
  );
  expect(out[0]).toMatch(/^No service log entries yet in /);
});
