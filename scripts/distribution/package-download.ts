import { createHash } from "node:crypto";
import { createReadStream, statfsSync } from "node:fs";
import { chmod, copyFile, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

// Told to the updater through its exit code, which a shell installer can read too.
export const PROBLEM_EXIT = { network: 3, stalled: 4, disk: 5, verify: 6, channel: 7 } as const;
export type PackageProblemName = keyof typeof PROBLEM_EXIT;
export class PackageProblem extends Error {
  constructor(
    readonly problem: PackageProblemName,
    message: string,
  ) {
    super(message);
  }
}

const STALL_MS = 30_000;
// Tries in a row that get no further. Any try that does starts the count again.
const ATTEMPTS = 4;
const WAIT_MS = 2_000;

export interface PackageDownload {
  url: string;
  bytes: number;
  sha512: string;
  to: string;
  // Holds the partial file, so a dropped connection or a crash picks up where it stopped.
  partials: string;
  signal: AbortSignal;
  report(done: number, total: number): void;
  fetch?: (
    url: string,
    init: { signal: AbortSignal; headers: Record<string, string> },
  ) => Promise<Response>;
  open?: typeof open;
  // Free space wanted before starting: the package and the files it unpacks to.
  needs?: number;
  freeBytes?: (path: string) => number;
  stallMs?: number;
  attempts?: number;
  waitMs?: number;
}

const noSpace = (error: unknown) =>
  !!error && typeof error === "object" && "code" in error && error.code === "ENOSPC";
const disk = () => new PackageProblem("disk", "There isn't enough free disk space for the update.");
const measured = (path: string) => {
  const { bavail, bsize } = statfsSync(path);
  return Number(bavail) * Number(bsize);
};

async function hashOf(path: string) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

// One request: appends what it can to the partial file. Throws when the stream ends early.
async function fetchPart(input: PackageDownload, part: string, have: number) {
  const fetchFile = input.fetch ?? fetch;
  const stallMs = input.stallMs ?? STALL_MS;
  const stalled = new AbortController();
  const stop = () => stalled.abort(new PackageProblem("stalled", "The download stopped moving."));
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
      throw new PackageProblem("network", `Download unavailable (${response.status}).`);
    let size = resumed ? have : 0;
    file = await (input.open ?? open)(part, resumed ? "a" : "w", 0o600);
    for await (const chunk of response.body) {
      touch();
      size += chunk.length;
      if (size > input.bytes) throw new PackageProblem("verify", "The download is too large.");
      await file.write(chunk);
      input.report(size, input.bytes);
    }
    await file.sync();
  } catch (error) {
    if (noSpace(error)) throw disk();
    throw stalled.signal.aborted ? stalled.signal.reason : error;
  } finally {
    clearTimeout(timer);
    await file?.close().catch(() => {});
  }
}

/** Downloads the signed package to `to`, resuming over dropped connections and across runs, and
 * resolves only with the exact bytes the catalog names. */
export async function downloadPackage(input: PackageDownload): Promise<void> {
  await mkdir(input.partials, { recursive: true, mode: 0o700 });
  const name = `app-${input.sha512.slice(0, 16)}.part`;
  const part = join(input.partials, name);
  for (const other of await readdir(input.partials))
    if (other !== name && /^app-[0-9a-f]{16}\.part$/.test(other))
      await rm(join(input.partials, other), { force: true });
  const sizeOf = () =>
    stat(part).then(
      (found) => found.size,
      () => 0,
    );
  if ((await sizeOf()) > input.bytes) await rm(part, { force: true });
  if (input.needs) {
    const have = await sizeOf();
    if ((input.freeBytes ?? measured)(input.partials) < input.needs - have) throw disk();
  }
  const attempts = input.attempts ?? ATTEMPTS;
  let fruitless = 0,
    wholeAgain = false;
  for (;;) {
    input.signal.throwIfAborted();
    const before = await sizeOf();
    let failure: unknown;
    if (before < input.bytes)
      try {
        await fetchPart(input, part, before);
      } catch (error) {
        failure = error;
      }
    input.signal.throwIfAborted();
    if (failure instanceof PackageProblem && failure.problem === "disk") throw failure;
    const after = await sizeOf();
    if (after === input.bytes) {
      if ((await hashOf(part)) === input.sha512) break;
      await rm(part, { force: true });
      if (wholeAgain)
        throw new PackageProblem(
          "verify",
          "App download did not match the signed release. Nothing was installed.",
        );
      wholeAgain = true;
      continue;
    }
    fruitless = after > before ? 0 : fruitless + 1;
    if (fruitless >= attempts)
      throw failure instanceof PackageProblem
        ? failure
        : new PackageProblem("network", "The download couldn't reach the server.");
    await new Promise((resolve) => setTimeout(resolve, input.waitMs ?? WAIT_MS));
  }
  // The data folder and the app's can be on different drives.
  await rename(part, input.to).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EXDEV") throw error;
    await copyFile(part, input.to);
    await rm(part, { force: true });
  });
  await chmod(input.to, 0o400);
}
