import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReportBundle } from "../../../packages/protocol/src/reports.ts";
import { ReportStore } from "../../daemon/src/reports/store.ts";
import { parseArgs } from "./args.ts";
import { CommandError } from "./local-dot.ts";
import { type ReportDeps, runReport } from "./report.ts";
import { fakeLocalDot } from "./testing/fake-local-dot.ts";

const RECEIPT = { id: "LD-7K3P-Q9XA", token: "t".repeat(43) };
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "localdot-cli-report-"));
  dirs.push(dir);
  return dir;
};

const bundle: ReportBundle = {
  format: 1,
  createdAt: "2026-10-29T08:00:00.000Z",
  installId: "0123456789abcdef0123456789abcdef",
  source: "cli",
  summary: "The page stayed blank",
  message: "The page stayed blank",
  app: { version: "1.4.0", channel: "stable", install: "services", state: "running" },
  host: {
    os: "darwin",
    arch: "arm64",
    release: "25.6.0",
    node: "v24.11.0",
    cpus: 10,
    memoryGB: 32,
  },
  services: { keyd: "ready", docker: "running" },
  doctor: [{ name: "docker-engine", ok: false, detail: "Docker isn't running" }],
  computers: [],
  tasks: [],
  logs: [{ name: "logs/daemon.log", lines: ["daemon started"], truncated: false }],
};

function setup(options: { app?: "running" | "stopped"; answer?: boolean; confirm?: boolean } = {}) {
  const home = scratch();
  const f = fakeLocalDot({
    app: options.app ?? "running",
    routes: {
      "POST /api/reports/drafts": (body: unknown) => {
        expect(body).toMatchObject({ source: "cli" });
        return { draft: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", bundle, bytes: 300 };
      },
    },
  });
  const l = { ...f.l, home };
  const posted: unknown[] = [];
  const service = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted.push(JSON.parse(gunzipSync(init.body as Buffer).toString()));
      return new Response(JSON.stringify(RECEIPT), { status: 201 });
    }
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const cwd = scratch();
  const deps: ReportDeps = {
    env: {},
    version: "1.4.0",
    cwd,
    ...(options.confirm === false ? {} : { confirm: vi.fn(async () => options.answer ?? true) }),
    fetch: service,
    now: () => new Date("2026-10-29T09:00:00.000Z"),
  };
  return { ...f, l, home, deps, posted, service, cwd };
}
const send = (args: string[]) => {
  const command = parseArgs(["report", ...args]);
  if (command?.kind !== "report") throw new Error("not a report command");
  return command.report;
};

describe("localdot report", () => {
  it("shows the whole report, asks, sends exactly it and prints the ID to quote", async () => {
    const f = setup();
    expect(await runReport(f.l, f.io, send(["--message", "The page stayed blank"]), f.deps)).toBe(
      0,
    );
    expect(f.out[0]).toBe(JSON.stringify(bundle, null, 2));
    expect(f.out).toContain("  Checks        1, 1 failed");
    expect(f.deps.confirm).toHaveBeenCalledWith(
      "Send this report to reports.localdot.dev? [y/N] ",
      f.l.signal,
    );
    expect(f.posted).toEqual([bundle]);
    expect(f.out.slice(-2)).toEqual([
      `Sent. Report ID: ${RECEIPT.id}`,
      `Quote ${RECEIPT.id} when you ask for help. To delete it: localdot report delete ${RECEIPT.id}`,
    ]);
    expect(new ReportStore(f.home).find(RECEIPT.id)?.token).toBe(RECEIPT.token);
  });

  it("sends nothing when the user says no, or when there is no terminal to ask on", async () => {
    const declined = setup({ answer: false });
    expect(await runReport(declined.l, declined.io, send([]), declined.deps)).toBe(1);
    expect(declined.out.at(-1)).toBe("Nothing was sent.");
    const unattended = setup({ confirm: false });
    await expect(runReport(unattended.l, unattended.io, send([]), unattended.deps)).rejects.toThrow(
      /add --yes/,
    );
    expect(declined.service).not.toHaveBeenCalled();
    expect(unattended.service).not.toHaveBeenCalled();
    const json = setup();
    expect(await runReport(json.l, json.io, send(["--yes", "--json"]), json.deps)).toBe(0);
    expect(JSON.parse(json.out.join(""))).toMatchObject({ id: RECEIPT.id });
  });

  it("makes the report from the log files while the app isn't answering", async () => {
    const f = setup({ app: "stopped" });
    mkdirSync(join(f.home, "logs"));
    writeFileSync(join(f.home, "logs", "daemon.log"), "daemon shutdown requested (SIGTERM)\n");
    expect(await runReport(f.l, f.io, send(["--yes"]), f.deps)).toBe(0);
    expect(f.err).toEqual(["localDot isn't running, so this report is made from its log files."]);
    expect(f.calls).not.toContain("POST /api/reports/drafts");
    const sent = f.posted[0] as ReportBundle;
    expect(sent).toMatchObject({
      source: "cli",
      summary: "localDot isn't running",
      app: { version: "1.4.0", state: "stopped", install: "services" },
      services: { keyd: "ready", docker: "running" },
      logs: [{ name: "logs/daemon.log", lines: ["daemon shutdown requested (SIGTERM)"] }],
    });
    expect(sent.doctor).toBeUndefined();
  });

  it("saves a dry run to a private file and sends nothing", async () => {
    const f = setup();
    expect(await runReport(f.l, f.io, send(["--dry-run"]), f.deps)).toBe(0);
    const [name] = readdirSync(f.cwd);
    expect(name).toBe("localdot-report-2026-10-29T09-00-00.json");
    const file = join(f.cwd, name as string);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(bundle);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(f.out).toEqual([`Saved the report to ${file}. Nothing was sent.`]);
    expect(f.service).not.toHaveBeenCalled();
  });

  it("refuses while reports are off, and deletes only reports this localDot sent", async () => {
    const f = setup();
    new ReportStore(f.home).setEnabled(false);
    await expect(runReport(f.l, f.io, send(["--yes"]), f.deps)).rejects.toThrow(
      /turned off for localDot/,
    );
    await expect(runReport(f.l, f.io, send(["delete", RECEIPT.id]), f.deps)).rejects.toThrow(
      CommandError,
    );
    new ReportStore(f.home).record({
      ...RECEIPT,
      sentAt: "2026-10-29T09:00:00.000Z",
      summary: "s",
    });
    expect(await runReport(f.l, f.io, send(["delete", RECEIPT.id]), f.deps)).toBe(0);
    expect(f.service).toHaveBeenCalledWith(
      new URL(`https://reports.localdot.dev/v1/reports/${RECEIPT.id}`),
      expect.objectContaining({
        method: "DELETE",
        headers: { authorization: `Bearer ${RECEIPT.token}` },
      }),
    );
    expect(new ReportStore(f.home).find(RECEIPT.id)).toBeUndefined();
  });

  it("accepts the user's own words but never a flag, a key or control characters", () => {
    expect(parseArgs(["report"])).toEqual({ kind: "report", report: { operation: "send" } });
    expect(
      parseArgs(["report", "--message", "Blank page\nafter login", "--yes", "--json"]),
    ).toEqual({
      kind: "report",
      report: { operation: "send", message: "Blank page\nafter login", yes: true, json: true },
    });
    expect(parseArgs(["report", "--dry-run", "--dot", "Work"])).toEqual({
      kind: "report",
      report: { operation: "send", dryRun: true },
      dot: "Work",
    });
    for (const args of [
      ["--message"],
      ["--message", ""],
      ["--message", "--yes"],
      ["--message", `my key is sk-proj-${"a".repeat(40)}`],
      ["--message", "bell\u0007"],
      ["--message", "x".repeat(2001)],
      ["--yes", "--yes"],
      ["--dry-run", "--yes"],
      ["--url", "https://example.com"],
      ["delete"],
      ["delete", "LD-0000"],
      ["delete", RECEIPT.id, "--yes"],
    ])
      expect(parseArgs(["report", ...args])).toBeUndefined();
    expect(parseArgs(["report", "delete", RECEIPT.id])).toEqual({
      kind: "report",
      report: { operation: "delete", id: RECEIPT.id },
    });
  });
});
