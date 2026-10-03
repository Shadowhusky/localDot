import type { TranscriptAppend } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brainFlow, LLM_SURROGATE } from "./testing/brain-flow.ts";
import { PROXY_TOKEN, TOOL_TOKEN } from "./testing/harness.ts";

const fixtures: Awaited<ReturnType<typeof brainFlow>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function fixture(script: Parameters<typeof brainFlow>[0]) {
  const f = await brainFlow(script);
  fixtures.push(f);
  return f;
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture missing value");
  return value;
}
const click = (x: number) => ({
  name: "computer",
  input: { action: "left_click", coordinate: [x, 400] },
});
const done = { name: "done", input: { summary: "Finished through the real tool API." } };

describe("host brain through the real daemon tool API and model proxy", () => {
  it("uses official provider wire, immutable batch frames and durable inbox delivery, without body secrets", async () => {
    const f = await fixture([
      [click(640), click(641), { name: "shell", input: { command: "env" } }],
      [click(642)],
      [done],
    ]);
    f.h.desktop.shellOutput = [
      { stream: "stdout", chunk: `${LLM_SURROGATE}\n${PROXY_TOKEN}\n${TOOL_TOKEN}\n` },
    ];
    const one = f.h.session.post("followup", "Use Celsius before finishing");
    const two = f.h.session.post("steer", "Then check Paris");
    const observed: { delivered: number; sources: string[] }[] = [];
    f.controls.beforeModel = () => {
      observed.push({
        delivered: f.h.session.delivered,
        sources: f.h.transcripts
          .read(f.h.session.id)
          .flatMap((m) => (m.sourceInbox ? [m.sourceInbox.messageId] : [])),
      });
    };
    expect(await f.run()).toBe("done");
    expect(f.wire.map((r) => r.line)).toEqual(
      Array(3).fill("POST http://llm.ldot/anthropic/messages"),
    );
    for (const request of f.wire) {
      expect(request.headers["x-api-key"]).toBe(LLM_SURROGATE);
      expect(request.headers["proxy-authorization"]).toBe(
        `Basic ${Buffer.from(`brain:${PROXY_TOKEN}`).toString("base64")}`,
      );
      for (const secret of [LLM_SURROGATE, PROXY_TOKEN, TOOL_TOKEN])
        expect(request.body).not.toContain(secret);
      expect(request.body).not.toContain("sourceInbox");
      expect(request.body).not.toContain(one.messageId);
      expect(request.body).not.toContain(two.messageId);
    }
    expect(f.wire[0]?.body).toContain(one.text);
    expect(f.wire[0]?.body).toContain(two.text);
    expect(f.wire[1]?.body).toContain("[redacted]");
    expect(observed).toEqual(
      Array.from({ length: 3 }, () => ({ delivered: 2, sources: [one.messageId, two.messageId] })),
    );
    const appends = f.apiRequests
      .filter((r) => r.path === "/v1/transcript" && r.body)
      .map((r) => JSON.parse(r.body) as TranscriptAppend);
    const sourcePositions = [one, two].map((item) =>
      appends.findIndex((r) => r.messages.some((m) => m.sourceInbox?.messageId === item.messageId)),
    );
    const ackPosition = appends.findIndex((r) => r.inboxAfter === 2);
    expect(sourcePositions[0]).toBeGreaterThanOrEqual(0);
    expect(sourcePositions[1]).toBeGreaterThan(required(sourcePositions[0]));
    expect(ackPosition).toBeGreaterThan(required(sourcePositions[1]));

    const first = required(f.frames[0]);
    const secondBatchBasis = required(f.frames[2]);
    expect(f.h.actions.map((a) => a.action)).toEqual([
      expect.objectContaining({ verb: "click", point: { x: 640, y: 400 }, basedOn: first.frameId }),
      expect.objectContaining({ verb: "click", point: { x: 641, y: 400 }, basedOn: first.frameId }),
      expect.objectContaining({
        verb: "click",
        point: { x: 642, y: 400 },
        basedOn: secondBatchBasis.frameId,
      }),
    ]);
    const events = f.h.events();
    expect(events.filter((e) => e.type === "task.result")).toHaveLength(1);
    expect(events.filter((e) => e.type === "model.usage")).toHaveLength(3);
    expect(events.some((e) => e.type === "heartbeat")).toBe(true);
    const stored = JSON.stringify(f.h.transcripts.read(f.h.session.id));
    expect(stored).toContain(`[[localdot:frame ${first.frameId}]]`);
    for (const frame of f.frames) expect(stored).not.toContain(frame.data);
    for (const secret of [LLM_SURROGATE, PROXY_TOKEN, TOOL_TOKEN]) {
      expect(stored).not.toContain(secret);
      expect(JSON.stringify(events)).not.toContain(secret);
      for (const request of f.apiRequests) expect(request.body).not.toContain(secret);
    }
  });

  it.each(["before-ack", "after-ack"] as const)(
    "replays exact durable input once after a %s transport failure and brain replacement",
    async (point) => {
      const f = await fixture([[done]]);
      const item = f.h.session.post("followup", "Keep this exact request after replacement");
      let injected = false;
      // The request reaches the real append/ack owner. For before-ack we fail its storage call;
      // for after-ack only the HTTP reply is replaced, retaining the committed durable cursor.
      const acknowledge = f.h.transcripts.acknowledge.bind(f.h.transcripts);
      const ack = vi.spyOn(f.h.transcripts, "acknowledge").mockImplementation((id, through) => {
        if (point === "before-ack" && !injected) {
          injected = true;
          throw new Error("fixture acknowledgement failure");
        }
        acknowledge(id, through);
      });
      f.controls.afterApi = (request, response) => {
        if (point !== "after-ack" || injected || request.path !== "/v1/transcript" || !request.body)
          return response;
        const body = JSON.parse(request.body) as TranscriptAppend;
        if (body.inboxAfter !== undefined) {
          injected = true;
          return new Response("fixture reply lost", { status: 503 });
        }
        return response;
      };
      await expect(f.run()).rejects.toThrow(/tool API/);
      expect(injected).toBe(true);
      expect(f.wire).toHaveLength(0);
      const before = f.h.transcripts.state(f.h.session.id);
      expect(
        before.messages.filter((m) => m.sourceInbox?.messageId === item.messageId),
      ).toHaveLength(1);
      expect(before.inboxAfter).toBe(point === "before-ack" ? 0 : 1);
      ack.mockRestore();
      f.controls.afterApi = undefined;
      const oldClient = f.client();
      f.h.session.retireBrain(required(f.h.session.generation));
      f.publish({ token: "n".repeat(43), resume: true });
      await expect(oldClient.boot()).rejects.toThrow(/401/);
      expect(await f.run()).toBe("done");
      expect(f.wire).toHaveLength(1);
      expect(required(f.wire[0]).body.split(item.text)).toHaveLength(2);
      expect(required(f.wire[0]).body).not.toContain(item.messageId);
      expect(f.h.session.delivered).toBe(1);
      expect(
        f.h.transcripts
          .read(f.h.session.id)
          .filter((m) => m.sourceInbox?.messageId === item.messageId),
      ).toHaveLength(1);
    },
  );

  it("holds takeover across caller retirement and permits a fresh generation only after hand-back", async () => {
    const f = await fixture([]);
    const api = f.client();
    const pending = api.tool("request_takeover", "handoff", { reason: "login", note: "Sign in" });
    void pending.catch(() => {}); // Teardown also owns the wait if an earlier assertion fails.
    await vi.waitUntil(() => f.h.events().some((e) => e.type === "takeover.request"));
    const id = required(f.h.session.pendingTakeover);
    const observe = vi.spyOn(f.h.tools.gateway, "observe");
    const png = vi.spyOn(f.h.tools.png, "png");
    await expect(api.tool("computer", "blocked", { action: "screenshot" })).rejects.toThrow(/409/);
    await expect(api.frame(f.h.session.id)).rejects.toThrow(/409/);
    expect(observe).not.toHaveBeenCalled();
    expect(png).not.toHaveBeenCalled();
    f.h.session.retireBrain(required(f.h.session.generation));
    expect((await pending).ok).toBe(false);
    expect(f.h.session.controlHeld).toBe(true);
    expect(() => f.h.session.beginBrain()).toThrow(/control/);
    expect(f.h.events().filter((e) => e.type === "takeover.end")).toHaveLength(0);
    expect(f.h.session.endTakeover(id, "Ready to continue")).toBe(true);
    expect(f.h.session.endTakeover(id, "Duplicate")).toBe(false);
    f.publish({ token: "r".repeat(43), resume: true });
    await expect(api.boot()).rejects.toThrow(/401/);
    const result = await f.client().tool("computer", "fresh", { action: "screenshot" });
    expect(result.ok).toBe(true);
    expect(result.content.some((c) => c.type === "image")).toBe(true);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(f.h.events().filter((e) => e.type === "takeover.end")).toHaveLength(1);
  });
});
