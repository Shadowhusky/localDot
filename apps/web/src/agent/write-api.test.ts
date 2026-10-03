import { describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { DeliveryFailure, deliverText } from "./write-api.ts";

const cellId = "01JXYZ0000000000000000CE11";
const sessionId = "01JXYZ0000000000000000SESS";
const request = { cellId, sessionId, mode: "steer" as const, text: "请继续 monthly report" };
function setup(response: () => Response | Promise<Response>) {
  const fetchImpl = vi.fn(async () => response());
  const api = createApi("owned-token", { origin: "http://127.0.0.1:4790", fetchImpl });
  return { api, fetchImpl };
}
describe("task text delivery response boundary", () => {
  it("uses the captured session/mode and accepts only the real 202 wire response", async () => {
    const f = setup(() => new Response(null, { status: 202 }));
    expect(await deliverText(f.api, request)).toBe(sessionId);
    expect(f.fetchImpl).toHaveBeenCalledWith(
      `http://127.0.0.1:4790/api/agent/sessions/${sessionId}/messages`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ kind: "steer", text: request.text }),
        headers: { authorization: "Bearer owned-token", "content-type": "application/json" },
        signal: expect.any(AbortSignal),
      }),
    );
    const next = setup(() => Response.json({ sessionId }, { status: 202 }));
    expect(await deliverText(next.api, { ...request, sessionId: null, mode: "new" })).toBe(
      sessionId,
    );
  });
  it.each([400, 401, 403, 404, 409, 413, 422, 200, 408, 500, 502, 503])(
    "classifies status %i without echoing its body or retrying",
    async (status) => {
      const f = setup(() => new Response("untrusted private server error", { status }));
      const error = await deliverText(f.api, request).catch((e) => e);
      expect(error).toBeInstanceOf(DeliveryFailure);
      expect(error.uncertain).toBe(![400, 401, 403, 404, 409, 413, 422].includes(status));
      expect(error.message).not.toContain("private");
      expect(f.fetchImpl).toHaveBeenCalledOnce();
    },
  );
  it("treats lost or malformed accepted replies as uncertain", async () => {
    for (const response of [
      () => {
        throw new Error("wire lost");
      },
      () => Response.json({ sessionId, extra: true }, { status: 202 }),
      () => Response.json({ sessionId: "bad" }, { status: 202 }),
      () => new Response("<html>", { status: 202 }),
      () => new Response("x".repeat(4097), { status: 202 }),
    ]) {
      const f = setup(response);
      await expect(deliverText(f.api, { ...request, mode: "new" })).rejects.toMatchObject({
        uncertain: true,
      });
      expect(f.fetchImpl).toHaveBeenCalledOnce();
    }
  });
  it("validates boundaries before dispatch, preserving the exact 8000-character positive", async () => {
    const f = setup(() => new Response(null, { status: 202 }));
    for (const text of [
      "",
      "   ",
      "x".repeat(8001),
      "bad\0text",
      "bad\ud800text",
      `sk-proj-${"a".repeat(156)}`,
    ])
      await expect(deliverText(f.api, { ...request, text })).rejects.toMatchObject({
        uncertain: false,
      });
    expect(f.fetchImpl).not.toHaveBeenCalled();
    await expect(deliverText(f.api, { ...request, text: "x".repeat(8000) })).resolves.toBe(
      sessionId,
    );
  });
});
