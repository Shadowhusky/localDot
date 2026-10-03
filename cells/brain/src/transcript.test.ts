import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptMessage } from "@localdot/protocol";
import { expect, it } from "vitest";
import { TranscriptStore } from "../../../apps/daemon/src/agent/transcript.ts";
import { compactionEntry, fromTranscript } from "./context.ts";
import { PROXY_TOKEN } from "./testing/scripted.ts";
import { MAX_REPLY_BYTES, MAX_TRANSCRIPT_REPLY_BYTES, ToolClient } from "./tool-client.ts";

it("restores a daemon-accepted compacted transcript after 257 ordinary 64 KiB file results", async () => {
  const home = mkdtempSync(join(tmpdir(), "localdot-t10-review-history-"));
  const id = "01JXYZ0000000000000000AAAA";
  const store = new TranscriptStore(home);
  let client: ToolClient | undefined;
  try {
    const messages: TranscriptMessage[] = [
      { role: "user", content: "task", sourceInbox: { seq: 1, messageId: id } },
    ];
    for (let i = 0; i < 257; i++)
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: `read-${i}`,
            toolName: "files",
            output: { type: "text", value: "a".repeat(64 * 1024) },
          },
        ],
      });
    for (let offset = 0; offset < messages.length; offset += 64)
      store.append(id, messages.slice(offset, offset + 64));
    store.append(id, [compactionEntry(messages.length, "compact summary")]);
    const durable = store.read(id);
    expect(durable).toHaveLength(259);
    expect(await fromTranscript(durable, async () => undefined)).toHaveLength(1);
    const body = JSON.stringify({ messages: durable });
    expect(Buffer.byteLength(body)).toBeGreaterThan(MAX_REPLY_BYTES);
    expect(Buffer.byteLength(body)).toBeLessThan(128 * 1024 * 1024);
    client = new ToolClient("http://127.0.0.1:1", PROXY_TOKEN, async () => new Response(body));
    await expect(client.transcript()).resolves.toHaveLength(259);
  } finally {
    await client?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it.each([undefined, "1"])(
  "bounds actual transcript bytes with declared length %s and cancels overflow",
  async (declared) => {
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    let produced = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = new ToolClient(
      "http://127.0.0.1:1",
      PROXY_TOKEN,
      async () =>
        new Response(source, {
          headers: declared === undefined ? {} : { "content-length": declared },
        }),
    );
    try {
      await expect(client.transcript()).rejects.toThrow("size limit");
      expect(produced).toBeGreaterThan(MAX_TRANSCRIPT_REPLY_BYTES);
      expect(produced).toBeLessThanOrEqual(MAX_TRANSCRIPT_REPLY_BYTES + chunk.byteLength * 2);
      expect(cancelled).toBe(true);
    } finally {
      await client.close();
    }
  },
);

it("cancels a pending transcript body on generation loss without returning partial metadata", async () => {
  const stop = new AbortController();
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"messages":['));
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = new ToolClient(
    "http://127.0.0.1:1",
    PROXY_TOKEN,
    async () => new Response(source),
  );
  try {
    const response = client.transcript(stop.signal);
    const rejected = expect(response).rejects.toThrow("cancelled");
    await Promise.resolve();
    await Promise.resolve();
    stop.abort();
    await rejected;
    expect(cancelled).toBe(true);
  } finally {
    await client.close();
  }
});
