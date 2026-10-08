import { ulid } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { readReplayEvents } from "./useReplay.ts";

describe("replay history stream ownership", () => {
  it("folds UTF-8 split across chunks in batches of at most 1000 with header-only authentication", async () => {
    const events = Array.from({ length: 1003 }, (_, seq) => ({
      v: 1,
      id: ulid(),
      seq,
      t: seq * 1000,
      agent: "main",
      type: "text.progress",
      data: { count: seq, chunk: "中文 notes", masked: false },
    }));
    const bytes = new TextEncoder().encode(
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    const calls: { url: string; init?: RequestInit }[] = [];
    const api = createApi("owned-token", {
      origin: "http://127.0.0.1:4790",
      fetchImpl: (async (input, init) => {
        calls.push({ url: String(input), init });
        let position = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (position >= bytes.length) {
                controller.close();
                return;
              }
              controller.enqueue(bytes.slice(position, position + 113));
              position += 113;
            },
          }),
        );
      }) as typeof fetch,
    });
    const batches: number[][] = [];
    await readReplayEvents(api, ulid(), 0, new AbortController().signal, (batch) =>
      batches.push(batch.map((event) => event.seq)),
    );
    expect(batches.map((batch) => batch.length)).toEqual([1000, 3]);
    expect(batches.flat()).toEqual(events.map((event) => event.seq));
    expect(calls[0]?.url).not.toContain("owned-token");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer owned-token");
    expect(calls[0]?.init?.credentials).toBe("omit");
    expect(calls[0]?.init?.redirect).toBe("error");
  });
  it("cancels an idle history reader when its owner leaves", async () => {
    const cancellation = vi.fn();
    const controller = new AbortController();
    const api = createApi("fixture", {
      origin: "http://127.0.0.1:4790",
      fetchImpl: (async () =>
        new Response(new ReadableStream({ cancel: cancellation }))) as typeof fetch,
    });
    const reading = readReplayEvents(api, ulid(), 0, controller.signal, () => {});
    const rejected = expect(reading).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    controller.abort();
    await rejected;
    expect(cancellation).toHaveBeenCalledOnce();
  });
  it("invalidates authentication once on a rejected history request", async () => {
    const onUnauthorized = vi.fn();
    const api = createApi("fixture", {
      origin: "http://127.0.0.1:4790",
      onUnauthorized,
      fetchImpl: (async () => new Response(null, { status: 401 })) as typeof fetch,
    });
    await expect(
      readReplayEvents(api, ulid(), 0, new AbortController().signal, () => {}),
    ).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});
