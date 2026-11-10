import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { freeBytes as measuredFree } from "../recorder/disk.ts";

export type SpeechDownloadProblemName = "network" | "stalled" | "disk" | "verify";

export class SpeechDownloadProblem extends Error {
  constructor(
    readonly problem: SpeechDownloadProblemName,
    message: string,
  ) {
    super(message);
    this.name = "SpeechDownloadProblem";
  }
}

const STALL_MS = 30_000;
// Tries in a row that get next to nowhere, about three minutes of them with the waits doubling, so a
// blip doesn't stop a download nobody is watching. One that really gets further starts the count again.
const ATTEMPTS = 6;
const REAL_PROGRESS = 256 * 1024;
const WAIT_MS = 2_000;
const LONGEST_WAIT_MS = 30_000;

export interface VerifiedDownload {
  url: string;
  bytes: number;
  sha256: string;
  to: string;
  // Holds the partial file, so a dropped connection or a restart picks up where it stopped.
  partials: string;
  signal: AbortSignal;
  report(done: number, total: number): void;
  fetch?: (
    url: string,
    init: { signal: AbortSignal; headers: Record<string, string> },
  ) => Promise<Response>;
  open?: typeof open;
  freeBytes?: (path: string) => number;
  stallMs?: number;
  attempts?: number;
  realProgress?: number;
  waitMs?: number;
}

const noSpace = (error: unknown) =>
  !!error && typeof error === "object" && "code" in error && error.code === "ENOSPC";
const diskFull = () =>
  new SpeechDownloadProblem("disk", "There isn't enough free disk space for the download.");

export async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export const partialPath = (partials: string, sha256: string) =>
  join(partials, `${sha256.slice(0, 16)}.part`);

// One request: appends what it can to the partial file. Throws when the stream ends early.
async function fetchPart(input: VerifiedDownload, part: string, have: number) {
  const fetchFile = input.fetch ?? fetch;
  const stallMs = input.stallMs ?? STALL_MS;
  const stalled = new AbortController();
  const stop = () =>
    stalled.abort(new SpeechDownloadProblem("stalled", "The download stopped moving."));
  let timer = setTimeout(stop, stallMs);
  timer.unref?.();
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(stop, stallMs);
    timer.unref?.();
  };
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const response = await fetchFile(input.url, {
      signal: AbortSignal.any([input.signal, stalled.signal]),
      headers: have ? { range: `bytes=${have}-` } : {},
    });
    const resumed =
      have > 0 &&
      response.status === 206 &&
      response.headers.get("content-range")?.startsWith(`bytes ${have}-`);
    if (!response.ok || !response.url.startsWith("https://") || !response.body)
      throw new SpeechDownloadProblem("network", `The download failed (${response.status}).`);
    let size = resumed ? have : 0;
    file = await (input.open ?? open)(part, resumed ? "a" : "w", 0o600);
    for await (const chunk of response.body) {
      touch();
      size += chunk.length;
      if (size > input.bytes)
        throw new SpeechDownloadProblem("verify", "The download is larger than expected.");
      await file.write(chunk);
      input.report(size, input.bytes);
    }
    await file.sync();
  } catch (error) {
    if (noSpace(error)) throw diskFull();
    throw stalled.signal.aborted ? stalled.signal.reason : error;
  } finally {
    clearTimeout(timer);
    await file?.close().catch(() => {});
  }
}

// Downloads to `to`, resuming over dropped connections and across restarts, and resolves only with
// the exact bytes the catalog pins. Nothing reaches `to` before its hash has matched.
export async function downloadVerified(input: VerifiedDownload): Promise<void> {
  await mkdir(input.partials, { recursive: true, mode: 0o700 });
  const part = partialPath(input.partials, input.sha256);
  const sizeOf = () =>
    stat(part).then(
      (found) => found.size,
      () => 0,
    );
  if ((await sizeOf()) > input.bytes) await rm(part, { force: true });
  if ((input.freeBytes ?? measuredFree)(input.partials) < input.bytes - (await sizeOf()))
    throw diskFull();
  const attempts = input.attempts ?? ATTEMPTS;
  let fruitless = 0;
  let wholeAgain = false;
  // A file built on bytes kept from earlier may hold a bad partial, so it gets one fresh try. One that
  // came whole from a single request and doesn't match is the server's fault: the next source is.
  let resumed = false;
  for (;;) {
    input.signal.throwIfAborted();
    const before = await sizeOf();
    if (before > 0) resumed = true;
    let failure: unknown;
    if (before < input.bytes)
      try {
        await fetchPart(input, part, before);
      } catch (error) {
        failure = error;
      }
    input.signal.throwIfAborted();
    if (failure instanceof SpeechDownloadProblem && failure.problem === "disk") throw failure;
    const after = await sizeOf();
    if (after === input.bytes) {
      if ((await sha256Of(part)) === input.sha256) break;
      await rm(part, { force: true });
      if (wholeAgain || !resumed)
        throw new SpeechDownloadProblem(
          "verify",
          "The download didn't match the release's checksum. Nothing was installed.",
        );
      wholeAgain = true;
      resumed = false;
      continue;
    }
    if (failure instanceof SpeechDownloadProblem && failure.problem === "verify") {
      await rm(part, { force: true });
      throw failure;
    }
    fruitless = after - before >= (input.realProgress ?? REAL_PROGRESS) ? 0 : fruitless + 1;
    if (fruitless >= attempts)
      throw failure instanceof SpeechDownloadProblem
        ? failure
        : new SpeechDownloadProblem("network", "The download couldn't reach the server.");
    const wait = (input.waitMs ?? WAIT_MS) * 2 ** Math.max(0, fruitless - 1);
    await new Promise((resolve) => setTimeout(resolve, Math.min(wait, LONGEST_WAIT_MS)));
  }
  await mkdir(dirname(input.to), { recursive: true, mode: 0o700 });
  await rename(part, input.to);
}
