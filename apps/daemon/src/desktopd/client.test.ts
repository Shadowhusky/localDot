import { describe, expect, it } from "vitest";
import { DesktopdClient, DesktopdError } from "./client.ts";
import { FakeDesktopd } from "./testing/fake-desktopd.ts";

const client = (fake: FakeDesktopd) =>
  new DesktopdClient({ baseUrl: "http://127.0.0.1:1", token: fake.token }, fake.fetchImpl);

describe("DesktopdClient", () => {
  it("cancels the typing response if a progress callback fails", async () => {
    let cancelled = false;
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                `${JSON.stringify({ count: 1, chunk: "a", pressMono: 10 })}\n`,
              ),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
      )) as typeof fetch;
    const c = new DesktopdClient({ baseUrl: "http://127.0.0.1:1", token: "fake" }, fetchImpl);
    await expect(
      c.type(
        {
          text: "ab",
          masked: false,
          pace: { firstMs: 0, firstCount: 60, restMs: 0 },
          injector: "xtest",
        },
        () => {
          throw new Error("stopped");
        },
      ),
    ).rejects.toThrow("stopped");
    expect(cancelled).toBe(true);
  });
  it("ends and cancels the stream after its final result instead of waiting forever for EOF", async () => {
    let cancelled = false;
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                `${JSON.stringify({ done: true, count: 1, firstPressMono: 10, injector: "xtest", armedMono: 5 })}\n`,
              ),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
      )) as typeof fetch;
    const c = new DesktopdClient({ baseUrl: "http://127.0.0.1:1", token: "fake" }, fetchImpl);
    const ac = new AbortController();
    const pending = c.type(
      {
        text: "a",
        masked: false,
        pace: { firstMs: 0, firstCount: 60, restMs: 0 },
        injector: "xtest",
      },
      () => {},
      ac.signal,
    );
    const result = await Promise.race([
      pending,
      new Promise<null>((r) => setTimeout(() => r(null), 100)),
    ]);
    ac.abort();
    expect(result).toMatchObject({ done: true, count: 1 });
    expect(cancelled).toBe(true);
  });
  it("reads the clock and injects input", async () => {
    const fake = new FakeDesktopd();
    const c = client(fake);
    expect((await c.clock()).mono).toBeGreaterThan(0);
    const res = await c.input({
      input: { kind: "click", button: "left", count: 1, at: { x: 1, y: 2 } },
      injector: "xtest",
      holdMs: 0,
    });
    expect(res.presses).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ path: "/input", body: { input: { kind: "click" } } });
  });

  it("streams the presses of a repeated key and returns the final result", async () => {
    const lines = (...ls: object[]) =>
      (async () =>
        new Response(ls.map((l) => `${JSON.stringify(l)}\n`).join(""), {
          headers: { "content-type": "application/x-ndjson" },
        })) as typeof fetch;
    const result = { pressMono: 10, presses: [10, 30], injector: "xtest", armedMono: 5 };
    const repeat = {
      input: { kind: "key" as const, combo: ["Delete"], repeat: 2 },
      injector: "xtest" as const,
      holdMs: 0,
    };
    const seen: number[] = [];
    const c = (fetchImpl: typeof fetch) =>
      new DesktopdClient({ baseUrl: "http://127.0.0.1:1", token: "fake" }, fetchImpl);
    const res = await c(
      lines(
        { presses: 1, pressMono: 10 },
        { presses: 2, pressMono: 30 },
        { ...result, done: true },
      ),
    ).input(repeat, undefined, (p) => {
      seen.push(p.presses);
    });
    expect(seen).toEqual([1, 2]);
    expect(res).toEqual(result);
    await expect(
      c(lines({ presses: 1, pressMono: 10 }, { error: "the helper went away", status: 500 })).input(
        repeat,
      ),
    ).rejects.toMatchObject({ status: 500, path: "/input" });
  });

  it("streams typing progress lines and returns the final result", async () => {
    const fake = new FakeDesktopd({
      type: () => ({
        progress: [
          { count: 1, chunk: "h", pressMono: 10 },
          { count: 2, chunk: "i", pressMono: 20 },
        ],
        result: { done: true, count: 2, firstPressMono: 10, injector: "xtest", armedMono: 5 },
      }),
    });
    const seen: number[] = [];
    const res = await client(fake).type(
      {
        text: "hi",
        masked: false,
        pace: { firstMs: 0, firstCount: 60, restMs: 0 },
        injector: "xtest",
      },
      (p) => {
        seen.push(p.count);
      },
    );
    expect(seen).toEqual([1, 2]);
    expect(res).toMatchObject({ done: true, count: 2, firstPressMono: 10 });
  });

  it("turns desktopd errors into DesktopdError with the status", async () => {
    const fake = new FakeDesktopd({
      input: () => ({ status: 504, body: "no raw press observed" }),
    });
    const err = await client(fake)
      .input({ input: { kind: "key", combo: ["a"] }, injector: "xtest", holdMs: 0 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(DesktopdError);
    expect(err).toMatchObject({ status: 504, path: "/input" });
    const bad = new DesktopdClient(
      { baseUrl: "http://127.0.0.1:1", token: "wrong" },
      fake.fetchImpl,
    );
    await expect(bad.clock()).rejects.toMatchObject({ status: 401 });
  });

  it("reads a zoom as PNG bytes, undefined once the frame is gone, and fails on an error", async () => {
    const fake = new FakeDesktopd({
      zoom: (body) =>
        (body as { frameId: string }).frameId === "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N"
          ? Buffer.from([0x89, 0x50, 0x4e, 0x47])
          : undefined,
    });
    const region = { x: 1, y: 2, w: 30, h: 40 };
    expect(await client(fake).zoom({ frameId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", region })).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    expect(
      await client(fake).zoom({ frameId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0P", region }),
    ).toBeUndefined();
    expect(fake.calls.map((c) => c.body)).toEqual([
      { frameId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", region },
      { frameId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0P", region },
    ]);
    const broken = new DesktopdClient(
      { baseUrl: "http://127.0.0.1:1", token: "t" },
      (async () => new Response("perception not available", { status: 503 })) as typeof fetch,
    );
    await expect(
      broken.zoom({ frameId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", region }),
    ).rejects.toBeInstanceOf(DesktopdError);
  });
});
