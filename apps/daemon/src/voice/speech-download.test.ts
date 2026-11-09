import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadVerified, partialPath, SpeechDownloadProblem } from "./speech-download.ts";

const BYTES = Buffer.from("the exact bytes the catalog names, repeated ".repeat(64));
const SHA256 = createHash("sha256").update(BYTES).digest("hex");
const URL = "https://example.test/model.bin";

type Answer = (range: number, signal: AbortSignal) => Response | Promise<Response>;

function served(body: Uint8Array, start = 0, status = start ? 206 : 200) {
  const response = new Response(Buffer.from(body), {
    status,
    headers: start ? { "content-range": `bytes ${start}-${body.length + start - 1}/*` } : {},
  });
  Object.defineProperty(response, "url", { value: URL });
  return response;
}

// Sends part of the file, then the connection drops.
function cutOff(body: Uint8Array, start = 0) {
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return controller.error(new Error("connection lost"));
      sent = true;
      controller.enqueue(body);
    },
  });
  const response = new Response(stream, {
    status: start ? 206 : 200,
    headers: start ? { "content-range": `bytes ${start}-${body.length + start - 1}/*` } : {},
  });
  Object.defineProperty(response, "url", { value: URL });
  return response;
}

describe("downloading a pinned file", () => {
  let dir: string;
  let to: string;
  let partials: string;
  let asked: number[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ld-speech-download-"));
    to = join(dir, "model.bin");
    partials = join(dir, "partial");
    asked = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const download = (answer: Answer, over: Partial<Parameters<typeof downloadVerified>[0]> = {}) =>
    downloadVerified({
      url: URL,
      bytes: BYTES.length,
      sha256: SHA256,
      to,
      partials,
      signal: new AbortController().signal,
      report: () => {},
      waitMs: 1,
      freeBytes: () => 10 * 1024 ** 3,
      fetch: async (_url, init) => {
        const range = Number(init.headers.range?.match(/bytes=(\d+)-/)?.[1] ?? 0);
        asked.push(range);
        return answer(range, init.signal);
      },
      ...over,
    });

  it("delivers only the exact bytes the catalog names, and leaves no partial behind", async () => {
    await download(() => served(BYTES));
    expect(readFileSync(to).equals(BYTES)).toBe(true);
    expect(readdirSync(partials)).toEqual([]);
  });

  it("refuses bytes that don't match, and keeps nothing of them", async () => {
    const other = Buffer.alloc(BYTES.length, 7);
    await expect(download(() => served(other))).rejects.toMatchObject({
      problem: "verify",
    });
    expect(existsSync(to)).toBe(false);
    expect(readdirSync(partials)).toEqual([]);
  });

  it("gives up on a fresh download that doesn't match at once, so the next source is tried", async () => {
    await expect(download(() => served(Buffer.alloc(BYTES.length, 7)))).rejects.toMatchObject({
      problem: "verify",
    });
    expect(asked).toEqual([0]);
  });

  it("starts once more from nothing when a mismatch may be a bad partial", async () => {
    mkdirSync(partials, { recursive: true });
    writeFileSync(partialPath(partials, SHA256), Buffer.alloc(BYTES.length, 1));
    await download(() => served(BYTES));
    expect(readFileSync(to).equals(BYTES)).toBe(true);
  });

  it("picks up from the bytes it has after a dropped connection", async () => {
    const half = 1024;
    await download(
      (range) =>
        range === 0 ? cutOff(BYTES.subarray(0, half)) : served(BYTES.subarray(range), range),
      { realProgress: 1 },
    );
    expect(asked).toEqual([0, half]);
    expect(readFileSync(to).equals(BYTES)).toBe(true);
  });

  it("resumes across runs from a partial file", async () => {
    await download(() => cutOff(BYTES.subarray(0, 2048)), { attempts: 1 }).catch(() => {});
    asked = [];
    await download((range) => served(BYTES.subarray(range), range));
    expect(asked).toEqual([2048]);
    expect(readFileSync(to).equals(BYTES)).toBe(true);
  });

  it("starts again when a server ignores the range, without appending", async () => {
    await download(() => cutOff(BYTES.subarray(0, 2048)), { attempts: 1 }).catch(() => {});
    await download(() => served(BYTES));
    expect(readFileSync(to).equals(BYTES)).toBe(true);
  });

  it("retries a server failure, then says so honestly", async () => {
    let tries = 0;
    await download(() => (++tries < 3 ? served(new Uint8Array(), 0, 503) : served(BYTES)));
    expect(tries).toBe(3);
    await expect(
      download(() => served(new Uint8Array(), 0, 503), {
        to: join(dir, "other"),
        sha256: "0".repeat(64),
        attempts: 2,
      }),
    ).rejects.toMatchObject({ problem: "network" });
  });

  it("gives up on a server that never moves", async () => {
    const stuck: Answer = (_range, signal) =>
      new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    await expect(download(stuck, { stallMs: 5, attempts: 2 })).rejects.toMatchObject({
      problem: "stalled",
    });
  });

  it("refuses an address that isn't https", async () => {
    const plain = new Response(BYTES);
    Object.defineProperty(plain, "url", { value: "http://example.test/model.bin" });
    await expect(download(() => plain, { attempts: 1 })).rejects.toBeInstanceOf(
      SpeechDownloadProblem,
    );
    expect(existsSync(to)).toBe(false);
  });

  it("stops at once when cancelled, and keeps the partial for a later try", async () => {
    const controller = new AbortController();
    const reading = download(
      (_range, signal) => {
        const stream = new ReadableStream<Uint8Array>({
          start(writer) {
            writer.enqueue(BYTES.subarray(0, 512));
            signal.addEventListener("abort", () => writer.error(signal.reason), { once: true });
          },
        });
        queueMicrotask(() => setTimeout(() => controller.abort(new Error("stopped")), 5));
        const response = new Response(stream);
        Object.defineProperty(response, "url", { value: URL });
        return response;
      },
      { signal: controller.signal },
    );
    await expect(reading).rejects.toThrow("stopped");
    expect(existsSync(to)).toBe(false);
    expect(readdirSync(partials).length).toBe(1);
  });

  it("refuses before fetching when the disk has no room", async () => {
    const answer = vi.fn(() => served(BYTES));
    await expect(download(answer, { freeBytes: () => 10 })).rejects.toMatchObject({
      problem: "disk",
    });
    expect(answer).not.toHaveBeenCalled();
  });

  it("counts a partial towards the room it needs", async () => {
    await download(() => cutOff(BYTES.subarray(0, 2048)), { attempts: 1 }).catch(() => {});
    await download((range) => served(BYTES.subarray(range), range), {
      freeBytes: () => BYTES.length - 2048,
    });
    expect(readFileSync(to).equals(BYTES)).toBe(true);
  });

  it("calls a full disk a full disk when it runs out part way", async () => {
    const full = async () => {
      const error = new Error("no space left") as NodeJS.ErrnoException;
      error.code = "ENOSPC";
      throw error;
    };
    await expect(download(() => served(BYTES), { open: full as never })).rejects.toMatchObject({
      problem: "disk",
    });
  });

  it("reports the bytes as they arrive", async () => {
    const seen: number[] = [];
    await download(() => served(BYTES), { report: (done) => seen.push(done) });
    expect(seen.at(-1)).toBe(BYTES.length);
  });
});
