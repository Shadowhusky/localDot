import { createHash, randomBytes } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CanaryOperation } from "../../../../packages/protocol/src/canary-operation.ts";
import { CanaryClosed, CanaryReady } from "../../../../packages/protocol/src/canary-process.ts";
import type { CanaryContainerLogs } from "./canary-container-logs.ts";
import { privateDirectory } from "./copy-inventory.ts";

const failure = () => new Error("The final diagnostic artifacts could not be verified.");
const CONTROL = "artifact-control";
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
export type CanaryArtifactControl = Readonly<{ marker: string }>;

/** Match embedded base64 at all three offsets, using only complete interior
 * groups whose bits do not depend on the surrounding bytes. Same forms as the
 * canonical in-container scanner, including upper hex and UTF-16LE. */
function patterns(value: string) {
  const raw = Buffer.from(value),
    result = [raw];
  for (const encoding of ["base64", "base64url"] as const) {
    for (let shift = 0; shift < 3; shift++) {
      const encoded = Buffer.concat([Buffer.alloc(shift), raw]).toString(encoding);
      result.push(
        Buffer.from(encoded.slice(shift ? 4 : 0, Math.floor((shift + raw.length) / 3) * 4)),
      );
    }
  }
  result.push(
    Buffer.from(raw.toString("hex")),
    Buffer.from(raw.toString("hex").toUpperCase()),
    Buffer.from(value, "utf16le"),
  );
  return result;
}
function controlBytes(marker: string) {
  if (!/^artifact-[a-f0-9]{32}$/.test(marker)) throw failure();
  return Buffer.concat(patterns(marker).flatMap((bytes) => [bytes, Buffer.from("\n")]));
}
async function rootIdentity(directory: string, operation: CanaryOperation) {
  const st = await privateDirectory(directory);
  if (
    String(st.dev) !== operation.directory?.device ||
    String(st.ino) !== operation.directory?.inode
  )
    throw failure();
  return st;
}
function same(a: BigIntStats, b: BigIntStats) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.uid === b.uid &&
    a.nlink === b.nlink &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

/** Call after helper readiness inside the held operation-directory lease. Never
 * before canary-run, which requires the new directory to be empty. */
export async function prepareCanaryArtifactControl(
  directory: string,
  input: CanaryOperation,
  signal: AbortSignal,
): Promise<CanaryArtifactControl> {
  try {
    const operation = CanaryOperation.parse(input);
    if (operation.phase !== "active") throw failure();
    signal.throwIfAborted();
    await rootIdentity(directory, operation);
    const marker = `artifact-${randomBytes(16).toString("hex")}`;
    const file = await open(
      join(directory, CONTROL),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(controlBytes(marker));
      await file.sync();
    } finally {
      await file.close();
    }
    await rootIdentity(directory, operation);
    signal.throwIfAborted();
    return Object.freeze({ marker });
  } catch {
    throw failure();
  }
}

function auditEvidence(bytes: Buffer, ready: CanaryReady) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.endsWith("\n")) throw failure();
  const lines = text.slice(0, -1).split("\n");
  if (!lines.length || lines.length > 4096) throw failure();
  let previous = "0".repeat(64),
    requests = 0;
  for (const [index, raw] of lines.entries()) {
    if (!raw || Buffer.byteLength(raw) > 256 * 1024) throw failure();
    for (const char of raw) if (char.charCodeAt(0) < 32) throw failure();
    const line: unknown = JSON.parse(raw);
    if (!object(line) || line.v !== 1 || line.seq !== index + 1 || line.prev !== previous)
      throw failure();
    previous = sha(raw);
    if (
      line.kind === "request" &&
      line.cell === ready.cellId &&
      line.port === ready.port &&
      line.mode === "https" &&
      line.method === "GET" &&
      line.host === "canary.localdot.invalid" &&
      line.path === `/v1/canary/${ready.challenge}` &&
      line.secretId === "diagnostic" &&
      line.swapped === true &&
      line.status === 200 &&
      line.decision === "allow"
    )
      requests++;
  }
  if (!requests) throw failure();
  return requests;
}

/** Only AFTER withCanaryProcess resolves (actual child close) and container log
 * collection confirms both containers stopped. Caller retains the directory
 * lease and install mutex until this and outer cleanup settle. Scans only this
 * run's private tree and drained buffers, never host processes or the user vault.
 * No raw paths, log text, markers or synthetic credentials escape the verdict. */
export async function verifyCanaryFinalArtifacts(
  directory: string,
  input: CanaryOperation,
  inputReady: CanaryReady,
  inputClosed: CanaryClosed,
  inputControl: CanaryArtifactControl,
  stderrInput: Buffer,
  inputLogs: CanaryContainerLogs,
  signal: AbortSignal,
) {
  try {
    const operation = CanaryOperation.parse(input),
      ready = CanaryReady.parse(inputReady),
      closed = CanaryClosed.parse(inputClosed),
      marker = inputControl.marker;
    if (
      operation.phase !== "active" ||
      operation.runId !== ready.runId ||
      operation.cellId !== ready.cellId ||
      closed.runId !== ready.runId ||
      closed.cellId !== ready.cellId ||
      closed.echo.authenticated < 1 ||
      closed.echo.reflected < 1
    )
      throw failure();
    const expectedControl = controlBytes(marker),
      positive = patterns(marker),
      secret = patterns(ready.syntheticSecret);
    signal.throwIfAborted();
    await rootIdentity(directory, operation);
    if (!Buffer.isBuffer(stderrInput) || stderrInput.length > 65536) throw failure();
    const stderr = Buffer.from(stderrInput),
      first = `canary:${ready.runId}:ready\n`,
      last = `canary:${ready.runId}:closed\n`;
    const start = stderr.indexOf(first),
      end = stderr.indexOf(last);
    if (
      start < 0 ||
      end <= start ||
      stderr.lastIndexOf(first) !== start ||
      stderr.lastIndexOf(last) !== end
    )
      throw failure();
    const buffers = [stderr];
    for (const role of ["desktop", "gate"] as const)
      for (const stream of ["stdout", "stderr"] as const) {
        const data = inputLogs[role][stream];
        if (!Buffer.isBuffer(data) || !data.length || data.length > 8 * 1024 * 1024)
          throw failure();
        buffers.push(Buffer.from(data));
      }
    function scan(bytes: Buffer) {
      signal.throwIfAborted();
      if (secret.some((needle) => bytes.includes(needle))) throw failure();
    }
    for (const buffer of buffers) scan(buffer);
    let files = 0,
      bytes = 0,
      entries = 0,
      controlSeen = false,
      audit: Buffer | undefined;
    const observed: { path: string; stat: BigIntStats }[] = [];
    async function visit(relative: string, depth: number) {
      signal.throwIfAborted();
      if (++entries > 512 || depth > 8) throw failure();
      const target = relative ? join(directory, relative) : directory;
      const before = await lstat(target, { bigint: true });
      if (before.isDirectory()) {
        await privateDirectory(target);
        const names = (await readdir(target)).sort();
        if (names.length > 512) throw failure();
        for (const name of names) await visit(relative ? `${relative}/${name}` : name, depth + 1);
        const after = await privateDirectory(target);
        if (!same(before, after)) throw failure();
      } else {
        if (
          !before.isFile() ||
          before.nlink !== 1n ||
          before.uid !== BigInt(process.getuid?.() ?? -1) ||
          ![0o600n, 0o644n].includes(before.mode & 0o7777n) ||
          before.size > 16n * 1024n * 1024n
        )
          throw failure();
        files++;
        bytes += Number(before.size);
        if (files > 256 || bytes > 64 * 1024 * 1024) throw failure();
        const file = await open(
          target,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        let data: Buffer;
        try {
          if (!same(before, await file.stat({ bigint: true }))) throw failure();
          data = Buffer.alloc(Number(before.size));
          let offset = 0;
          while (offset < data.length) {
            signal.throwIfAborted();
            const read = await file.read(
              data,
              offset,
              Math.min(65536, data.length - offset),
              offset,
            );
            if (!read.bytesRead) throw failure();
            offset += read.bytesRead;
          }
          if (
            !same(before, await file.stat({ bigint: true })) ||
            !same(before, await lstat(target, { bigint: true }))
          )
            throw failure();
        } finally {
          await file.close();
        }
        scan(data);
        if (relative === CONTROL) {
          if (!data.equals(expectedControl) || positive.some((needle) => !data.includes(needle)))
            throw failure();
          controlSeen = true;
        }
        if (relative === "gateway/audit.jsonl") audit = data;
      }
      observed.push({ path: target, stat: before });
    }
    await visit("", 0);
    if (!controlSeen || !audit || files < 2) throw failure();
    const swappedRequests = auditEvidence(audit, ready);
    // An emitted successful audit row and the closed upstream receipt must both
    // account for every authenticated reflected exercise request.
    if (swappedRequests !== closed.echo.reflected || swappedRequests !== closed.echo.authenticated)
      throw failure();
    for (const item of observed) {
      signal.throwIfAborted();
      if (!same(item.stat, await lstat(item.path, { bigint: true }))) throw failure();
    }
    await rootIdentity(directory, operation);
    signal.throwIfAborted();
    return {
      ok: true as const,
      files,
      fileBytes: bytes,
      logBytes: buffers.reduce((n, data) => n + data.length, 0),
      swappedRequests,
    };
  } catch {
    throw failure();
  }
}
