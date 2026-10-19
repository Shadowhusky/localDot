import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import {
  disposition,
  downloadResult,
  FILE_LIMITS,
  FileTransferFailure,
  safeTransferName,
  uploadFile,
} from "./file-transfer.ts";

const CELL = "01JXYZ0000000000000000CE11",
  SESSION = "01JXYZ0000000000000000SESS";
const fixture = (fetchImpl: typeof fetch, onUnauthorized = vi.fn()) => ({
  api: createApi("file-fixture-token", {
    origin: "http://127.0.0.1:4747",
    fetchImpl,
    onUnauthorized,
  }),
  onUnauthorized,
});
const headers = (name = "report.txt") => ({
  "content-type": "application/octet-stream",
  "content-disposition": disposition(name),
  "x-content-type-options": "nosniff",
});
afterEach(() => vi.useRealTimers());
describe("bounded authenticated user file transfers", () => {
  it.each([
    "../secret",
    "a/b",
    "a\\b",
    ".hidden",
    "a%2fb",
    "line\nname",
    "nul\0name",
    "\ud800",
    "a".repeat(201),
    `sk-proj-${"z".repeat(80)}`,
  ])("refuses unsafe or recognized-key names without admitting a request", async (name) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { api } = fixture(fetchImpl);
    expect(safeTransferName(name)).toBe(false);
    const file = new File(["x"], "fixture.txt");
    Object.defineProperty(file, "name", { value: name });
    await expect(uploadFile(api, CELL, file, new AbortController().signal)).rejects.toBeInstanceOf(
      FileTransferFailure,
    );
    await expect(
      downloadResult(api, SESSION, name, new AbortController().signal),
    ).rejects.toBeInstanceOf(FileTransferFailure);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("preserves exact Unicode names and admits exactly one raw file with no task request", async () => {
    const name = "报告 (final).txt",
      file = new File(["example"], name);
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ path: `~/Downloads/${name}` }, { status: 201 }),
    );
    const { api } = fixture(fetchImpl);
    expect(await uploadFile(api, CELL, file, new AbortController().signal)).toBe(
      `~/Downloads/${name}`,
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(new URL(String(url)).searchParams.get("name")).toBe(name);
    expect(init?.body).toBe(file);
    expect(init?.headers).toEqual({
      authorization: "Bearer file-fixture-token",
      "content-type": "application/octet-stream",
    });
    expect(init?.redirect).toBe("error");
  });
  it("refuses one byte over the raw upload cap before any request", async () => {
    const file = new File([], "large.bin");
    Object.defineProperty(file, "size", { value: FILE_LIMITS.bytes + 1 });
    const fetchImpl = vi.fn<typeof fetch>();
    const { api } = fixture(fetchImpl);
    await expect(uploadFile(api, CELL, file, new AbortController().signal)).rejects.toMatchObject({
      uncertain: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([{ path: "/etc/passwd" }, { path: "~/Downloads/report.txt", extra: true }, {}])(
    "makes malformed upload success uncertain without exposing a forged path",
    async (body) => {
      const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(body, { status: 201 }));
      const { api } = fixture(fetchImpl);
      await expect(
        uploadFile(api, CELL, new File(["x"], "report.txt"), new AbortController().signal),
      ).rejects.toMatchObject({ uncertain: true });
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );
  it("requires upload body verification within its deadline and cancels the stalled reader", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"path":'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { api } = fixture(async () => new Response(body, { status: 201 }));
    const pending = uploadFile(
      api,
      CELL,
      new File(["x"], "report.txt"),
      new AbortController().signal,
    );
    const assertion = expect(pending).rejects.toMatchObject({ uncertain: true });
    await vi.advanceTimersByTimeAsync(FILE_LIMITS.deadlineMs);
    await assertion;
    expect(cancelled).toBe(true);
  });
  it.each([undefined, "1"])(
    "enforces cumulative download bytes even with declared length %s",
    async (length) => {
      let sent = 0,
        cancelled = false;
      const chunk = new Uint8Array(1024 * 1024);
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (sent < FILE_LIMITS.bytes) {
            sent += chunk.length;
            c.enqueue(chunk);
          } else {
            c.enqueue(new Uint8Array(1));
            c.close();
          }
        },
        cancel() {
          cancelled = true;
        },
      });
      const { api } = fixture(
        async () =>
          new Response(body, {
            headers: { ...headers(), ...(length ? { "content-length": length } : {}) },
          }),
      );
      await expect(
        downloadResult(api, SESSION, "report.txt", new AbortController().signal),
      ).rejects.toMatchObject({ uncertain: false });
      expect(sent).toBe(FILE_LIMITS.bytes);
      expect(cancelled || body.locked === false).toBe(true);
    },
  );
  it("accepts an exact 100 MiB download as an inert blob", async () => {
    let sent = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(65);
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent === FILE_LIMITS.bytes) c.close();
        else {
          sent += chunk.length;
          c.enqueue(chunk);
        }
      },
    });
    const { api } = fixture(async () => new Response(body, { headers: headers() }));
    const blob = await downloadResult(api, SESSION, "report.txt", new AbortController().signal);
    expect(blob.size).toBe(FILE_LIMITS.bytes);
    expect(blob.type).toBe("application/octet-stream");
  });
  it("keeps abort active after response headers and cancels a pending body", async () => {
    let cancelled = false;
    const owner = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    let signal: AbortSignal | null | undefined;
    const { api } = fixture(async (_url, init) => {
      signal = init?.signal;
      return new Response(body, { headers: headers() });
    });
    const pending = downloadResult(api, SESSION, "report.txt", owner.signal);
    const assertion = expect(pending).rejects.toBeInstanceOf(FileTransferFailure);
    await Promise.resolve();
    owner.abort();
    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });
  it("binds a post-header abort to the captured signal before a finite body completion", async () => {
    let output!: ReadableStreamDefaultController<Uint8Array>,
      cancelled = false;
    let signal: AbortSignal | null | undefined;
    const owner = new AbortController();
    const reading = Promise.withResolvers<void>();
    const body = new ReadableStream<Uint8Array>(
      {
        start(c) {
          output = c;
        },
        cancel() {
          cancelled = true;
        },
        pull() {
          reading.resolve();
        },
      },
      { highWaterMark: 0 },
    );
    const { api } = fixture(async (_url, init) => {
      signal = init?.signal;
      return new Response(body, { headers: headers() });
    });
    const result = downloadResult(api, SESSION, "report.txt", owner.signal).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
    await reading.promise;
    owner.abort();
    const abortedAtCancellation = signal?.aborted;
    if (!cancelled) output.close();
    expect((await result).ok).toBe(false);
    expect(abortedAtCancellation).toBe(true);
    expect(cancelled).toBe(true);
  });
  it.each([
    "inline",
    "attachment",
    "attachment; filename=../bad",
    "attachment; filename*=UTF-8''other.txt",
  ])("refuses malformed or changed disposition before collecting body: %s", async (value) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1]));
      },
      pull(c) {
        c.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const { api } = fixture(
      async () => new Response(body, { headers: { ...headers(), "content-disposition": value } }),
    );
    await expect(
      downloadResult(api, SESSION, "report.txt", new AbortController().signal),
    ).rejects.toBeInstanceOf(FileTransferFailure);
    expect(cancelled).toBe(true);
  });
  it("routes raw 401 to the captured token owner and never echoes refusal text", async () => {
    const { api, onUnauthorized } = fixture(
      async () => new Response("private-refusal-detail", { status: 401 }),
    );
    await expect(
      downloadResult(api, SESSION, "report.txt", new AbortController().signal),
    ).rejects.not.toThrow("private-refusal-detail");
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});

it("allows a smaller preview limit and stops a chunked response at that limit", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(32));
    },
    cancel() {
      cancelled = true;
    },
  });
  const { api } = fixture(async () => new Response(body, { headers: headers() }));
  await expect(
    downloadResult(api, SESSION, "report.txt", new AbortController().signal, 16),
  ).rejects.toBeInstanceOf(FileTransferFailure);
  expect(cancelled).toBe(true);
});
