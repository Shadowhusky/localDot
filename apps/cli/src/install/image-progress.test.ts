import { afterEach, expect, it, vi } from "vitest";
import { readImagePullProgress } from "./image-progress.ts";

const signal = () => new AbortController().signal;
async function* stream(chunks: Buffer[]) {
  yield* chunks;
}
afterEach(() => vi.useRealTimers());
it("parses split UTF-8/JSON records and forwards only bounded typed progress", async () => {
  const report = vi.fn();
  const bytes = Buffer.from(
    `${JSON.stringify({
      status: "Downloading",
      id: "abc123",
      progressDetail: { current: 5, total: 10 },
      secret: "never forward",
      note: "中文",
    })}\n`,
  );
  await readImagePullProgress(stream(Array.from(bytes, (b) => Buffer.from([b]))), signal(), report);
  expect(report.mock.calls).toEqual([
    [{ phase: "downloading", layer: "abc123", currentBytes: 5, totalBytes: 10 }],
  ]);
});
it.each([
  Buffer.from('{"error":"do not expose this body"}\n'),
  Buffer.from('{"errorDetail":{"message":"failure"}}\n'),
  Buffer.from("[]\n"),
  Buffer.from("null\n"),
  Buffer.from("{broken}\n"),
  Buffer.from([0xff, 10]),
  Buffer.alloc(65537, 32),
  Buffer.from("\n".repeat(32769)),
  Buffer.alloc(16 * 1024 * 1024 + 1),
  Buffer.alloc(0),
])("rejects error, malformed, truncated or excessive progress %#", async (body) => {
  await expect(readImagePullProgress(stream([body]), signal(), vi.fn())).rejects.toThrow();
});
it("accepts a final complete JSON line without newline but refuses a truncated record", async () => {
  await readImagePullProgress(stream([Buffer.from('{"status":"complete"}')]), signal(), vi.fn());
  await expect(
    readImagePullProgress(stream([Buffer.from('{"status":')]), signal(), vi.fn()),
  ).rejects.toThrow();
});
it("does not forward hostile status/layer strings or unsafe counters, and throttles callbacks", async () => {
  vi.useFakeTimers();
  const report = vi.fn(),
    body = Buffer.from(
      `${JSON.stringify({
        status: "\u001b[2Jsecret",
        id: "\nsecret",
        progressDetail: { current: -1, total: 1 },
      })}\n`,
    );
  await readImagePullProgress(stream([body, body, body]), signal(), report);
  expect(report.mock.calls).toEqual([[{ phase: "pulling" }]]);
});
it("drains the input iterator on cancellation", async () => {
  const controller = new AbortController(),
    reason = new Error("stop");
  let closed = false;
  async function* input() {
    try {
      yield Buffer.from('{"status":"Downloading"}\n');
      controller.abort(reason);
      yield Buffer.from("{}\n");
    } finally {
      closed = true;
    }
  }
  await expect(readImagePullProgress(input(), controller.signal, vi.fn())).rejects.toBe(reason);
  expect(closed).toBe(true);
});
