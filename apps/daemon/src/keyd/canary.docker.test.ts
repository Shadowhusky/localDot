import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerClient } from "../cells/docker.ts";
import { DOCKER_TESTS } from "../cells/testing/docker-cli.ts";
import { type CanaryControls, canaryScanVerdict } from "../diagnostics/canary-verdict.ts";
import { KillSwitch } from "../gateway/kill-switch.ts";
import { LiveSessions } from "../gateway/live.ts";
import { auditLines, type KeydCell, startKeydCell } from "./testing/keyd-cell.ts";

const CANARY = `canary-${randomBytes(16).toString("hex")}`;
const SCAN = fileURLToPath(new URL("./testing/canary-scan.py", import.meta.url));
const SESSION = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
const CONTROL_DIR = "/tmp/localdot-canary-controls";
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

interface ScanResult {
  processes: number;
  bytes: number;
  files: number;
  fileBytes: number;
  fileErrors: string[];
  unreadableMemory: number;
  hits: string[];
  memoryHits: { pid: number; comm: string; needle: string; form: string }[];
  memoryReads: { pid: number; comm: string; bytes: number }[];
  processErrors: {
    pid: number;
    comm: string;
    surface: string;
    errno: number;
    vanished: boolean;
    mapping?: string;
  }[];
}

// Existing docker() has no subprocess timeout and uses the default 1MiB buffer.
// These read-heavy acceptance probes fail explicitly on a stall or excessive output.
function docker(...args: string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 330_000,
    maxBuffer: 16 << 20,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function eventually(label: string, predicate: () => boolean, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(500);
  }
}

function checkedScan(raw: string): ScanResult {
  const result = JSON.parse(raw) as ScanResult;
  for (const number of [result.processes, result.bytes, result.files, result.fileBytes]) {
    expect(Number.isSafeInteger(number) && number >= 0).toBe(true);
  }
  expect(Array.isArray(result.hits)).toBe(true);
  expect(result.fileErrors).toEqual([]);
  return result;
}

describe.skipIf(!DOCKER_TESTS)("the canary never reaches a cell", () => {
  let cell: KeydCell;
  let desktop = "";
  let surrogate = "";
  let work = "";
  // '?' makes base64 and base64url controls exercise different alphabets too.
  const marker = `marker-???-${randomBytes(12).toString("hex")}`;
  const markerHits: string[] = [];
  const markerFiles: CanaryControls["files"] = [];
  const clipboardMarker = `clipboard-only-${randomBytes(12).toString("hex")}`;
  let proxyToken = "";
  let caPath = "";
  const hostRequest = () =>
    execFileSync(
      "curl",
      [
        "-sS",
        "--max-time",
        "20",
        "--noproxy",
        "",
        "--cacert",
        caPath,
        "--proxy",
        `http://127.0.0.1:${cell.record.keydPort}`,
        "--proxy-user",
        `cell:${proxyToken}`,
        "-D",
        "-",
        "-o",
        "/dev/null",
        "-H",
        `Authorization: Bearer ${surrogate}`,
        "https://postman-echo.com/get",
      ],
      { encoding: "utf8", timeout: 25_000 },
    );
  const httpStatus = (raw: string) => [...raw.matchAll(/^HTTP\/[\d.]+ (\d{3})/gm)].at(-1)?.[1];

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "localdot-canary-"));
    cell = await startKeydCell([
      {
        binding: {
          id: "canary",
          kind: "http",
          hosts: ["postman-echo.com"],
          header: "Authorization",
          format: "bearer",
        },
        value: CANARY,
      },
    ]);
    desktop = cell.record.docker.desktop;
    const token = cell.sh("cat /etc/localdot/cell/proxy-token");
    expect(token.status).toBe(0);
    proxyToken = token.out.trim();
    expect(proxyToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    caPath = join(work, "cell-ca.pem");
    docker("cp", `${desktop}:/etc/localdot/cell/ca.pem`, caPath);
    docker("cp", SCAN, `${desktop}:/tmp/canary-scan.py`);
    expect(cell.sh(`mkdir -p ${CONTROL_DIR}`).status).toBe(0);
    const control = (label: CanaryControls["files"][number]["form"], value: Buffer) => {
      const name = label.replace("+", "-");
      const source = join(work, name);
      const target = `${CONTROL_DIR}/${name}`;
      writeFileSync(source, value);
      docker("cp", source, `${desktop}:${target}`);
      markerHits.push(`${marker}|${label}|file ${target}`);
      markerFiles.push({ form: label, path: target });
    };
    control("raw", Buffer.from(marker));
    control("hex", Buffer.from(Buffer.from(marker).toString("hex")));
    control("HEX", Buffer.from(Buffer.from(marker).toString("hex").toUpperCase()));
    control("utf16le", Buffer.from(marker, "utf16le"));
    for (const encoding of ["base64", "base64url"] as const) {
      for (const shift of [0, 1, 2] as const) {
        const source = shift ? `${"x".repeat(shift)}${marker}tail` : marker;
        control(
          shift === 0 ? encoding : `${encoding}+${shift}`,
          Buffer.from(Buffer.from(source).toString(encoding)),
        );
      }
    }
    for (const target of ["/dev/localdot-canary-control", "/localdot-canary\ncontrol"]) {
      // docker cp writes beneath /dev's active tmpfs. Plant through the live mount instead.
      const planted = docker(
        "exec",
        "-u",
        "root",
        desktop,
        "python3",
        "-c",
        "from pathlib import Path; import sys; p=Path(sys.argv[1]); p.write_text(sys.argv[2]); print(p.read_text())",
        target,
        marker,
      );
      expect(planted).toBe(marker);
      markerHits.push(`${marker}|raw|file ${target}`);
      markerFiles.push({ form: "raw", path: target });
    }
    markerHits.push(`${marker}|raw|environ`, `${marker}|raw|cmdline`, `${marker}|raw|memory`);
    docker(
      "exec",
      "-d",
      "-u",
      "abc",
      "-e",
      `LOCALDOT_MARKER=${marker}`,
      desktop,
      "bash",
      "-c",
      'exec -a "$LOCALDOT_MARKER" sleep 3600',
    );
    const printed = cell.sh('printf %s "$LOCALDOT_KEY_CANARY"');
    expect(printed.status).toBe(0);
    surrogate = printed.out;
    expect(surrogate).toMatch(/^ld_key_[0-9A-Za-z]{22}_[0-9A-Za-z]{6}$/);
    docker("exec", "-d", "-u", "abc", "-e", `HOLDS=${surrogate}`, desktop, "sleep", "3600");
  }, 600_000);

  afterAll(async () => {
    try {
      await cell?.close();
    } finally {
      if (work) rmSync(work, { recursive: true, force: true });
    }
  });

  const writtenPaths = async () => {
    const excluded = (path: string) =>
      path === "/" ||
      path === "/proc" ||
      path.startsWith("/proc/") ||
      path === "/sys" ||
      path.startsWith("/sys/");
    const changes = await new DockerClient().request<{ Path: string; Kind: number }[]>({
      method: "GET",
      path: `/containers/${encodeURIComponent(desktop)}/changes`,
    });
    // Structured paths retain newlines and other characters that the CLI's line format loses.
    expect(Array.isArray(changes)).toBe(true);
    const changed = changes
      .filter((entry) => entry.Kind === 0 || entry.Kind === 1)
      .map((entry) => entry.Path)
      .filter((path) => !excluded(path));
    // /proc/mounts escapes spaces/backslashes. Parse inside the cell rather than
    // treating the escaped spelling as a path or shell argument.
    const mounted = docker(
      "exec",
      desktop,
      "python3",
      "-c",
      [
        "import json,re",
        "paths=[]",
        "for line in open('/proc/mounts'):",
        " f=line.split()",
        " if f[2]=='tmpfs': paths.append(re.sub(r'\\\\([0-7]{3})',lambda m:chr(int(m[1],8)),f[1]))",
        "print(json.dumps(paths))",
      ].join("\n"),
    );
    const mounts = (JSON.parse(mounted) as string[]).filter((path) => !excluded(path));
    return [...new Set([...changed, ...mounts, "/config"])];
  };
  const scan = async (...needles: string[]) =>
    checkedScan(
      docker(
        "exec",
        "--privileged",
        "-u",
        "root",
        desktop,
        "/usr/bin/python3",
        "/tmp/canary-scan.py",
        ...needles,
        "--files",
        ...(await writtenPaths()),
      ),
    );
  const coverage = (result: ScanResult) => {
    expect(result.processes).toBeGreaterThan(20);
    expect(result.bytes).toBeGreaterThan(100 * 1024 * 1024);
    expect(result.files).toBeGreaterThan(100);
    expect(result.hits).toEqual(
      expect.arrayContaining([
        ...markerHits,
        `${surrogate}|raw|environ`,
        `${surrogate}|raw|memory`,
      ]),
    );
    const clipboard = result.memoryHits.filter(
      (hit) => hit.comm === "xclip" && hit.needle === clipboardMarker && hit.form === "raw",
    );
    expect(clipboard.length).toBeGreaterThan(0);
    for (const hit of clipboard)
      expect(result.memoryReads.find((read) => read.pid === hit.pid)?.bytes).toBeGreaterThan(0);
    expect(result.processErrors.filter((error) => !error.vanished)).toEqual([]);
  };

  it("swaps the key upstream and keeps the reflected response and clipboard scrubbed", () => {
    const echo = cell.sh(
      'curl -sS -m 30 https://postman-echo.com/headers -H "Authorization: Bearer $LOCALDOT_KEY_CANARY"',
    );
    expect(echo.status).toBe(0);
    expect(JSON.parse(echo.out).headers.authorization).toBe(`Bearer ${surrogate}`);
    expect(echo.out).not.toContain(CANARY);
    expect(
      auditLines(cell.keyd, cell.id).some(
        (line) => line.secretId === "canary" && line.swapped === true,
      ),
    ).toBe(true);
    const copied = cell.sh(
      `printf %s ${shellQuote(`${echo.out}\n${clipboardMarker}`)} | DISPLAY=:1 xclip -quiet -selection clipboard -loops 0 >/dev/null 2>&1 & sleep 1; DISPLAY=:1 xclip -o -selection clipboard`,
    );
    expect(copied.status).toBe(0);
    expect(copied.out).toContain(`Bearer ${surrogate}`);
    expect(copied.out).not.toContain(CANARY);
    expect(copied.out).toContain(clipboardMarker);
  });

  it("finds every planted encoding and the live surrogate across files and processes", async () => {
    coverage(await scan(marker, surrogate, clipboardMarker));
  }, 360_000);

  it("finds no canary in a cell scan whose controls and actual coverage pass in that same run", async () => {
    const result = await scan(CANARY, marker, surrogate, clipboardMarker);
    expect(
      canaryScanVerdict(result, {
        canary: CANARY,
        marker,
        surrogate,
        clipboard: clipboardMarker,
        files: markerFiles,
      }),
    ).toMatchObject({ ok: true, reason: "passed" });
    console.info("canary scan coverage", {
      processes: result.processes,
      memoryBytes: result.bytes,
      files: result.files,
      fileBytes: result.fileBytes,
      unreadableMemory: result.unreadableMemory,
      processErrors: result.processErrors,
    });
    coverage(result);
    expect(result.hits.filter((hit) => hit.startsWith(`${CANARY}|`))).toEqual([]);
  }, 360_000);

  it("freezes the request loop, refuses its old surrogate after Resume, and mints a working replacement", async () => {
    const live = new LiveSessions();
    const killSwitch = new KillSwitch({ live, keyd: cell.wiring, cells: cell.orchestrator });
    const logPath = "/tmp/localdot-canary-loop.log";
    const pidPath = "/tmp/localdot-canary-loop.pid";
    const loopTag = `canary-loop-${randomBytes(6).toString("hex")}`;
    const loop = `echo $$ > ${pidPath}; n=0; while :; do n=$((n+1)); printf 'begin:%s\\n' "$n" >> ${logPath}; code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $LOCALDOT_KEY_CANARY" https://postman-echo.com/get?${loopTag}); printf 'end:%s:%s\\n' "$n" "$code" >> ${logPath}; sleep 1; done`;
    docker("exec", "-d", "-u", "abc", desktop, "bash", "-lc", loop);
    const lines = () => {
      const result = cell.sh(`cat ${logPath}`);
      expect(result.status).toBe(0);
      return result.out.split("\n").filter(Boolean);
    };
    try {
      expect(httpStatus(hostRequest())).toBe("200");
      await eventually(
        "two successful old-surrogate requests",
        () => lines().filter((line) => /^end:\d+:200$/.test(line)).length >= 2,
      );
      live.start(
        cell.id,
        SESSION,
        (signal) =>
          new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
      );
      expect(await killSwitch.stopSession(SESSION)).toEqual({
        revoked: true,
        paused: true,
        closed: false,
        stopped: false,
        errors: [],
      });
      expect(docker("inspect", "-f", "{{.State.Paused}}", desktop)).toBe("true");
      expect(cell.orchestrator.get(cell.id)).toMatchObject({ state: "ready", paused: true });
      // docker cp reads through the Engine; it does not try to exec in a paused cell.
      const frozenLog = join(work, "frozen-loop.log");
      docker("cp", `${desktop}:${logPath}`, frozenLog);
      const beganBeforeFreeze = Math.max(
        0,
        ...readFileSync(frozenLog, "utf8")
          .split("\n")
          .filter((line) => /^begin:\d+$/.test(line))
          .map((line) => Number(line.slice(6))),
      );
      // Probe from outside the frozen desktop before Resume's independent revoke can mask Stop.
      const revoked = hostRequest();
      expect(httpStatus(revoked)).toBe("403");
      expect(revoked).toMatch(/^x-keyd-reason: unknown-surrogate\s*$/im);
      const frozenAt = auditLines(cell.keyd, cell.id).length;
      await sleep(4000);
      expect(auditLines(cell.keyd, cell.id).length).toBe(frozenAt);
      await killSwitch.resume(cell.id);
      expect(docker("inspect", "-f", "{{.State.Paused}}", desktop)).toBe("false");
      const afterResume = () =>
        lines()
          .filter((line) => /^end:\d+:\d+$/.test(line))
          .map((line) => line.split(":"))
          .filter((parts) => Number(parts[1]) > beganBeforeFreeze)
          .map((parts) => parts[2]);
      await eventually("three requests begun after Resume", () => afterResume().length >= 3);
      expect(afterResume().every((code) => code === "403")).toBe(true);
      const freshSurrogate = cell.sh('printf %s "$LOCALDOT_KEY_CANARY"');
      expect(freshSurrogate.status).toBe(0);
      expect(freshSurrogate.out).not.toBe(surrogate);
      expect(freshSurrogate.out).toMatch(/^ld_key_[0-9A-Za-z]{22}_[0-9A-Za-z]{6}$/);
      expect(
        cell.sh(
          'curl -sS -m 30 -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $LOCALDOT_KEY_CANARY" https://postman-echo.com/get',
        ),
      ).toEqual({ status: 0, out: "200" });
      expect(afterResume().every((code) => code === "403")).toBe(true);
    } finally {
      if (docker("inspect", "-f", "{{.State.Paused}}", desktop) === "false") {
        // Exact owned loop PID, checked against this run's tag; no broad pkill.
        cell.sh(
          `pid=$(cat ${pidPath}); case "$pid" in ''|*[!0-9]*) exit 1;; esac; if tr '\\0' ' ' < /proc/$pid/cmdline | grep -F ${shellQuote(loopTag)} >/dev/null; then kill "$pid"; fi`,
        );
      }
    }
  }, 150_000);
  it("finds no raw or encoded canary in either container's logs, keyd stderr, or keyd files", async () => {
    const artifacts: string[] = [];
    const logControls: { marker: string; path: string }[] = [];
    const sources = (
      [
        ["desktop", desktop],
        ["gate", cell.record.docker.gate],
      ] as const
    ).map(([name, container]) => ({
      name,
      container,
      stdoutMarker: `log-${name}-stdout-${randomBytes(12).toString("hex")}`,
      stderrMarker: `log-${name}-stderr-${randomBytes(12).toString("hex")}`,
    }));
    for (const { container, stdoutMarker, stderrMarker } of sources) {
      execFileSync(
        "docker",
        [
          "exec",
          "--privileged",
          "-u",
          "root",
          container,
          "/bin/sh",
          "-c",
          'set -eu; printf "%s\\n" "$1" > /proc/1/fd/1; printf "%s\\n" "$2" > /proc/1/fd/2',
          "localdot-log-control",
          stdoutMarker,
          stderrMarker,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
    }
    // Capture logs only after the last request and container shutdown; no later process output
    // can fall outside this scan. The owned objects remain available until close() below.
    await cell.orchestrator.stop(cell.id);
    for (const { name, container, stdoutMarker, stderrMarker } of sources) {
      const logs = () => {
        const result = spawnSync("docker", ["logs", container], {
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 16 << 20,
          stdio: ["ignore", "pipe", "pipe"],
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        return result;
      };
      await eventually(
        "both container log streams",
        () => {
          const result = logs();
          return result.stdout.includes(stdoutMarker) && result.stderr.includes(stderrMarker);
        },
        5000,
      );
      const result = logs();
      expect(result.stdout).toContain(stdoutMarker);
      expect(result.stderr).toContain(stderrMarker);
      const path = join(work, `${name}.log`);
      writeFileSync(path, result.stdout + result.stderr);
      expect(readFileSync(path, "utf8")).toContain(stdoutMarker);
      expect(readFileSync(path, "utf8")).toContain(stderrMarker);
      artifacts.push(path);
      logControls.push({ marker: stdoutMarker, path }, { marker: stderrMarker, path });
    }
    // close() drains keyd's pipe through process close and preserves immutable artifacts before
    // deleting owned state. Calling close again from afterAll is idempotent.
    const finalArtifacts = join(work, "final-keyd");
    await cell.close({ artifactsTo: finalArtifacts });
    const stderrPath = join(finalArtifacts, "stderr.log");
    expect(readFileSync(stderrPath, "utf8")).toMatch(/^keyd ready socket=.+ boot=[0-9a-f]{16}$/m);
    artifacts.push(stderrPath);
    const control = join(work, "host-control");
    writeFileSync(control, marker);
    const result = checkedScan(
      execFileSync(
        "python3",
        [
          SCAN,
          CANARY,
          marker,
          ...logControls.map((entry) => entry.marker),
          "--no-processes",
          "--files",
          ...artifacts,
          join(finalArtifacts, "keyd-home"),
          control,
        ],
        { encoding: "utf8", timeout: 60_000, maxBuffer: 16 << 20 },
      ),
    );
    expect(result.files).toBeGreaterThan(artifacts.length + 1);
    expect(result.hits).toContain(`${marker}|raw|file ${control}`);
    for (const entry of logControls)
      expect(result.hits).toContain(`${entry.marker}|raw|file ${entry.path}`);
    expect(result.hits.filter((hit) => hit.startsWith(`${CANARY}|`))).toEqual([]);
  });
});
