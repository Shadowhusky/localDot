import { TOOL_REQUEST_HEADER, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { toolHarness as createHarness } from "./testing/harness.ts";

const harnesses: ReturnType<typeof createHarness>[] = [];
function toolHarness() {
  const h = createHarness();
  harnesses.push(h);
  return h;
}
afterEach(() => {
  for (const h of harnesses.splice(0)) h.close();
});
async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
function post(
  h: ReturnType<typeof toolHarness>,
  path: string,
  body: unknown,
  id: string,
  signal?: AbortSignal,
) {
  return h.app.request(path, {
    method: "POST",
    headers: { ...h.auth, [TOOL_REQUEST_HEADER]: id },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

describe("a brain's retried request", () => {
  it("joins the question already asked and gets its answer, so the user is asked once", async () => {
    const h = toolHarness();
    const id = ulid();
    const call = { callId: "ask-1", input: { question: "Which date?", options: ["Fri", "Sat"] } };
    const first = post(h, "/v1/tools/ask_user", call, id);
    await until(() => h.session.pendingAsk !== undefined);
    const ask = h.session.pendingAsk as string;
    const retried = post(h, "/v1/tools/ask_user", call, id);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.session.pendingAsk).toBe(ask);
    expect(h.session.answerFields(ask, { answer: "Sat" }, (text) => text)).toBe(true);
    const answers = await Promise.all([first, retried].map(async (r) => (await r).json()));
    expect(answers[1]).toEqual(answers[0]);
    expect(JSON.stringify(answers[0])).toContain("Sat");
    expect(h.events().filter((e) => e.type === "ask.request")).toHaveLength(1);
    // Once answered, a late copy gets the same answer without asking again.
    expect(await (await post(h, "/v1/tools/ask_user", call, id)).json()).toEqual(answers[0]);
    expect(h.events().filter((e) => e.type === "ask.request")).toHaveLength(1);
  });

  it("appends a transcript batch once however often it arrives", async () => {
    const h = toolHarness();
    const id = ulid();
    const batch = { messages: [{ role: "user", content: "noted" }] };
    for (let n = 0; n < 3; n++)
      expect((await post(h, "/v1/transcript", batch, id)).status).toBe(204);
    expect(h.transcripts.read(h.session.id)).toHaveLength(1);
    expect((await post(h, "/v1/transcript", batch, ulid())).status).toBe(204);
    expect(h.transcripts.read(h.session.id)).toHaveLength(2);
  });

  it("runs a copy whose first never got under way, and refuses a malformed id", async () => {
    const h = toolHarness();
    const id = ulid();
    const gone = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"messages":'));
      },
    });
    const first = h.app.fetch(
      new Request("http://tool/v1/transcript", {
        method: "POST",
        headers: { ...h.auth, [TOOL_REQUEST_HEADER]: id },
        body,
        duplex: "half",
        signal: gone.signal,
      } as RequestInit),
    );
    await new Promise((r) => setTimeout(r, 10));
    gone.abort();
    await first;
    const batch = { messages: [{ role: "user", content: "noted" }] };
    expect((await post(h, "/v1/transcript", batch, id)).status).toBe(204);
    expect(h.transcripts.read(h.session.id)).toHaveLength(1);
    expect((await post(h, "/v1/transcript", batch, "not-a-ulid")).status).toBe(400);
    expect(h.transcripts.read(h.session.id)).toHaveLength(1);
  });

  it("tells a copy of a call cut off part-way that it may have been done in part", async () => {
    const h = toolHarness();
    const id = ulid();
    const gone = new AbortController();
    const call = { callId: "ask-2", input: { question: "Which date?" } };
    const first = post(h, "/v1/tools/ask_user", call, id, gone.signal);
    await until(() => h.session.pendingAsk !== undefined);
    gone.abort();
    await Promise.resolve(first).catch(() => undefined);
    const retried = await (await post(h, "/v1/tools/ask_user", call, id)).json();
    expect(retried).toMatchObject({ ok: false });
    expect(JSON.stringify(retried)).toContain("may have been done in part");
    expect(h.events().filter((e) => e.type === "ask.request")).toHaveLength(1);
  });
});
