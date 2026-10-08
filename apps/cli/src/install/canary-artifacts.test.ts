import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CanaryOperation } from "../../../../packages/protocol/src/canary-operation.ts";
import { CanaryClosed, CanaryReady } from "../../../../packages/protocol/src/canary-process.ts";
import { prepareCanaryArtifactControl, verifyCanaryFinalArtifacts } from "./canary-artifacts.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
function audit(lines: Record<string, unknown>[]) {
  let previous = "0".repeat(64);
  return lines
    .map((line, index) => {
      const text = JSON.stringify({ ...line, v: 1, seq: index + 1, prev: previous });
      previous = sha(text);
      return `${text}\n`;
    })
    .join("");
}
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "canary-final-")));
  roots.push(directory);
  await chmod(directory, 0o700);
  const st = await lstat(directory, { bigint: true });
  const operation = CanaryOperation.parse({
    v: 1,
    owner: "a".repeat(32),
    engineId: "fixture",
    runId: "01234567-89ab-4cde-8fab-0123456789ab",
    cellId: "01JXYZ00000000000000000001",
    phase: "active",
    directory: { device: String(st.dev), inode: String(st.ino) },
    images: {
      desktop: {
        ref: `ghcr.io/fixture/localdot-desktop@sha256:${"a".repeat(64)}`,
        id: `sha256:${"b".repeat(64)}`,
      },
      gate: {
        ref: `ghcr.io/fixture/localdot-gate@sha256:${"c".repeat(64)}`,
        id: `sha256:${"d".repeat(64)}`,
      },
    },
    resources: {
      desktop: "1".repeat(64),
      gate: "2".repeat(64),
      internal: "3".repeat(64),
      egress: "4".repeat(64),
      home: true,
    },
  });
  const ready = CanaryReady.parse({
    v: 1,
    type: "ready",
    runId: operation.runId,
    cellId: operation.cellId,
    port: 49123,
    proxyToken: "t".repeat(43),
    caCertPem: `-----BEGIN CERTIFICATE-----\n${"A".repeat(128)}\n-----END CERTIFICATE-----\n`,
    surrogate: `ld_key_${"a".repeat(22)}_${"b".repeat(6)}`,
    syntheticSecret: `canary-${"e".repeat(64)}`,
    challenge: "a".repeat(32),
    url: `https://canary.localdot.invalid/v1/canary/${"a".repeat(32)}`,
  });
  const closed = CanaryClosed.parse({
    v: 1,
    type: "closed",
    runId: ready.runId,
    cellId: ready.cellId,
    gatewayClosed: true,
    echo: { started: 1, authenticated: 1, reflected: 1, active: 0, closed: true },
  });
  const controller = new AbortController();
  await mkdir(join(directory, "gateway"), { mode: 0o700 });
  const control = await prepareCanaryArtifactControl(directory, operation, controller.signal);
  const row = {
    kind: "request",
    mode: "https",
    method: "GET",
    host: "canary.localdot.invalid",
    path: `/v1/canary/${ready.challenge}`,
    cell: ready.cellId,
    port: ready.port,
    secretId: "diagnostic",
    swapped: true,
    status: 200,
    decision: "allow",
  };
  const auditPath = join(directory, "gateway/audit.jsonl");
  const writeAudit = (lines = [row]) => writeFile(auditPath, audit(lines), { mode: 0o600 });
  await writeAudit();
  const evidence = {
    stderr: Buffer.from(
      `canary:${ready.runId}:ready\nfixture stderr\ncanary:${ready.runId}:closed\n`,
    ),
    logs: {
      desktop: {
        stdout: Buffer.from("collected desktop stdout"),
        stderr: Buffer.from("collected desktop stderr"),
      },
      gate: {
        stdout: Buffer.from("collected gate stdout"),
        stderr: Buffer.from("collected gate stderr"),
      },
    },
  };
  return {
    directory,
    operation,
    ready,
    closed,
    control,
    controller,
    row,
    auditPath,
    writeAudit,
    evidence,
    verify: () =>
      verifyCanaryFinalArtifacts(
        directory,
        operation,
        ready,
        closed,
        control,
        evidence.stderr,
        evidence.logs,
        controller.signal,
      ),
  };
}

it("scans the actual remaining tree and all drained buffers with positive control and matching closed audit/echo evidence", async () => {
  const f = await fixture();
  await mkdir(join(f.directory, "gateway/cells"), { mode: 0o700 });
  // Normal helper shutdown may remove the CA and never write settings/spend.
  const verdict = await f.verify();
  expect(verdict).toMatchObject({ ok: true, files: 2, swappedRequests: 1 });
  expect(verdict.fileBytes).toBeGreaterThan(100);
  expect(verdict.logBytes).toBeGreaterThan(100);
  expect(JSON.stringify(verdict)).not.toMatch(/canary-|artifact-|ld_key_|\/tmp|\/private|fixture/);
  await expect(
    prepareCanaryArtifactControl(f.directory, f.operation, f.controller.signal),
  ).rejects.toThrow("artifacts could not be verified");
});

const encodings = [
  "raw",
  "base64-0",
  "base64-1",
  "base64-2",
  "base64url-0",
  "base64url-1",
  "base64url-2",
  "hex",
  "HEX",
  "utf16le",
];
function encoded(value: string, form: string) {
  if (form === "raw") return Buffer.from(value);
  if (form === "utf16le") return Buffer.from(value, "utf16le");
  if (form === "hex" || form === "HEX") {
    const text = Buffer.from(value).toString("hex");
    return Buffer.from(form === "HEX" ? text.toUpperCase() : text);
  }
  const [encoding, offset] = form.split("-");
  // Independent fixtures include arbitrary bytes before/after the secret. This
  // catches scanners that only search standalone padded base64 encodings.
  return Buffer.from(
    Buffer.concat([
      Buffer.alloc(Number(offset), 0x93),
      Buffer.from(value),
      Buffer.from([0xfa, 0x91]),
    ]).toString(encoding as "base64" | "base64url"),
  );
}
it.each(encodings)(
  "detects %s in a regular artifact, including across read-chunk boundaries",
  async (form) => {
    const f = await fixture(),
      bytes = encoded(f.ready.syntheticSecret, form);
    await writeFile(
      join(f.directory, "gateway/leak"),
      Buffer.concat([Buffer.alloc(65530, 120), bytes]),
      { mode: 0o600 },
    );
    await expect(f.verify()).rejects.toThrow("artifacts could not be verified");
  },
);
it.each(["helper", "desktop-stdout", "desktop-stderr", "gate-stdout", "gate-stderr"])(
  "scans all encodings in drained %s bytes",
  async (surface) => {
    const f = await fixture();
    for (const form of encodings) {
      const bytes = encoded(f.ready.syntheticSecret, form);
      if (surface === "helper")
        f.evidence.stderr = Buffer.concat([
          Buffer.from(`canary:${f.ready.runId}:ready\n`),
          bytes,
          Buffer.from(`\ncanary:${f.ready.runId}:closed\n`),
        ]);
      else {
        const [role, stream] = surface.split("-") as ["desktop" | "gate", "stdout" | "stderr"];
        f.evidence.logs[role][stream] = bytes;
      }
      await expect(f.verify()).rejects.toThrow("artifacts could not be verified");
    }
  },
);
it.each(["missing", "changed", "wrong-marker", "bad-marker"])(
  "refuses %s positive file controls",
  async (fault) => {
    const f = await fixture(),
      path = join(f.directory, "artifact-control");
    if (fault === "missing") await rm(path);
    if (fault === "changed") await writeFile(path, "unrelated");
    const control =
      fault === "wrong-marker"
        ? { marker: `artifact-${"f".repeat(32)}` }
        : fault === "bad-marker"
          ? { marker: "../escape" }
          : f.control;
    await expect(
      verifyCanaryFinalArtifacts(
        f.directory,
        f.operation,
        f.ready,
        f.closed,
        control,
        f.evidence.stderr,
        f.evidence.logs,
        f.controller.signal,
      ),
    ).rejects.toThrow("artifacts could not be verified");
  },
);
it.each([
  "missing-ready",
  "missing-closed",
  "duplicate",
  "reversed",
  "empty-log",
  "oversized-stderr",
])("refuses %s capture evidence", async (fault) => {
  const f = await fixture(),
    first = `canary:${f.ready.runId}:ready\n`,
    last = `canary:${f.ready.runId}:closed\n`;
  if (fault === "missing-ready") f.evidence.stderr = Buffer.from(last);
  if (fault === "missing-closed") f.evidence.stderr = Buffer.from(first);
  if (fault === "duplicate") f.evidence.stderr = Buffer.from(first + first + last);
  if (fault === "reversed") f.evidence.stderr = Buffer.from(last + first);
  if (fault === "empty-log") f.evidence.logs.gate.stderr = Buffer.alloc(0);
  if (fault === "oversized-stderr") f.evidence.stderr = Buffer.alloc(65537);
  await expect(f.verify()).rejects.toThrow("artifacts could not be verified");
});
it.each([
  "absent",
  "partial",
  "chain",
  "sequence",
  "unrelated",
  "unswapped",
  "wrong-port",
  "wrong-host",
  "wrong-path",
  "wrong-cell",
  "wrong-secret",
  "denied",
])("requires real matching audit evidence: %s", async (fault) => {
  const f = await fixture();
  if (fault === "absent") await rm(f.auditPath);
  else if (fault === "partial") await writeFile(f.auditPath, audit([f.row]).slice(0, -1));
  else if (fault === "chain")
    await writeFile(f.auditPath, audit([f.row]).replace('"prev":"0', '"prev":"1'));
  else if (fault === "sequence")
    await writeFile(f.auditPath, audit([f.row]).replace('"seq":1', '"seq":2'));
  else {
    const change = {
      unrelated: { kind: "admin" },
      unswapped: { swapped: false },
      "wrong-port": { port: 1 },
      "wrong-host": { host: "elsewhere.invalid" },
      "wrong-path": { path: "/other" },
      "wrong-cell": { cell: "other" },
      "wrong-secret": { secretId: "other" },
      denied: { decision: "deny" },
    }[fault];
    await f.writeAudit([{ ...f.row, ...change }]);
  }
  await expect(f.verify()).rejects.toThrow("artifacts could not be verified");
});
it.each(["zero", "mismatch", "other-run", "other-directory", "cancelled"])(
  "requires matching closed scope: %s",
  async (fault) => {
    const f = await fixture();
    if (fault === "zero") f.closed.echo.authenticated = f.closed.echo.reflected = 0;
    if (fault === "mismatch")
      f.closed.echo.started = f.closed.echo.authenticated = f.closed.echo.reflected = 2;
    if (fault === "other-run") f.closed.runId = "11234567-89ab-4cde-8fab-0123456789ab";
    if (fault === "other-directory" && f.operation.directory) f.operation.directory.inode = "1";
    if (fault === "cancelled") f.controller.abort(new Error("private fixture"));
    await expect(f.verify()).rejects.toThrow("artifacts could not be verified");
  },
);
it.each([
  "file-link",
  "directory-link",
  "hardlink",
  "public-directory",
  "writable-file",
  "oversized-file",
])("refuses incomplete or unsafe artifact trees: %s", async (fault) => {
  const f = await fixture(),
    target = join(f.directory, "gateway/extra");
  if (fault === "file-link") await symlink(f.auditPath, target);
  if (fault === "directory-link") await symlink(join(f.directory, "gateway"), target);
  if (fault === "hardlink") await link(f.auditPath, target);
  if (fault === "public-directory") await chmod(join(f.directory, "gateway"), 0o755);
  if (fault === "writable-file") await chmod(f.auditPath, 0o666);
  if (fault === "oversized-file")
    await writeFile(target, Buffer.alloc(16 * 1024 * 1024 + 1), { mode: 0o600 });
  await expect(f.verify()).rejects.toThrow("artifacts could not be verified");
});
it("checks additional private state files without requiring CA files that shutdown removed", async () => {
  const f = await fixture();
  await writeFile(join(f.directory, "gateway/settings.json"), "{}", { mode: 0o600 });
  await writeFile(join(f.directory, "gateway/public-ca.pem"), "public fixture", { mode: 0o644 });
  expect((await f.verify()).files).toBe(4);
  expect(
    (await readFile(join(f.directory, "artifact-control"))).includes(Buffer.from(f.control.marker)),
  ).toBe(true);
});
