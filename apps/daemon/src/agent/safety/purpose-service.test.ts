import type { AgentSettingsDocument, KeydRecord } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { PurposeService } from "./purpose-service.ts";

const key: KeydRecord = {
  id: "jev",
  kind: "http",
  hosts: ["api.typesafe.ai"],
  header: "Authorization",
  format: "bearer",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};
const reply = {
  model: "jev-1.13.0",
  answers: { fits: { type: "choice", probabilities: { needed: 0.99, unrelated: 0.01 } } },
};
function fixture(settings: AgentSettingsDocument = {}) {
  const post = vi.fn(async () => reply as unknown);
  const keys = vi.fn(async () => [key]);
  return { post, keys, service: new PurposeService({ post, keys, settings: () => settings }) };
}
describe("Purpose Check diagnostics", () => {
  it("reports Full access bypass without making a provider call", async () => {
    const f = fixture({ permissionMode: "full" });
    expect(await f.service.status()).toMatchObject({ mode: "bypassed", keyId: "jev", calls: 0 });
    expect(f.post).not.toHaveBeenCalled();
  });
  it("tests the saved key using only a synthetic request even when bypassed", async () => {
    const f = fixture({ permissionMode: "full" });
    expect(await f.service.test()).toMatchObject({
      mode: "bypassed",
      calls: 1,
      succeeded: 1,
      failed: 0,
      last: { ok: true, kind: "test", model: "jev-1.13.0" },
    });
    expect(f.post).toHaveBeenCalledWith(
      "jev",
      expect.objectContaining({
        state: { user_request: ["Read the public TypeSafe API documentation."], plan: [] },
      }),
      expect.any(AbortSignal),
    );
  });
  it("shares concurrent tests rather than issuing duplicate paid calls", async () => {
    const f = fixture();
    await Promise.all([f.service.test(), f.service.test()]);
    expect(f.post).toHaveBeenCalledTimes(1);
  });
  it("records real task calls separately from tests and does not expose task data", async () => {
    const f = fixture();
    await f.service.post(
      "jev",
      { private: "synthetic private text" },
      new AbortController().signal,
    );
    const s = await f.service.status();
    expect(s.last?.kind).toBe("task");
    expect(JSON.stringify(s)).not.toContain("synthetic private text");
  });
  it.each([
    {},
    { answers: { fits: { type: "choice", probabilities: {} } } },
    { answers: { fits: { type: "choice", probabilities: { needed: 1, unrelated: 1 } } } },
    { answers: { fits: { type: "choice", probabilities: { needed: 2 } } } },
  ])("rejects malformed successful HTTP replies", async (bad) => {
    const f = fixture();
    f.post.mockResolvedValue(bad);
    expect(await f.service.test()).toMatchObject({
      calls: 1,
      succeeded: 0,
      failed: 1,
      last: { ok: false },
    });
  });
  it("shows safe failure information without copying upstream secrets", async () => {
    const f = fixture();
    f.post.mockRejectedValue(new Error("private-token not for display"));
    const s = await f.service.test();
    expect(s.last?.ok).toBe(false);
    expect(JSON.stringify(s)).not.toContain("private-token");
    f.post.mockRejectedValue(new Error("Jev answered 401"));
    expect((await f.service.test()).last?.problem).toContain("HTTP 401");
  });
  it("distinguishes disabled, missing key and key layer failure", async () => {
    const f = fixture({ purposeCheck: "off" });
    expect((await f.service.status()).mode).toBe("off");
    const g = fixture();
    g.keys.mockResolvedValue([]);
    expect((await g.service.test()).mode).toBe("unconfigured");
    expect(g.post).not.toHaveBeenCalled();
    g.keys.mockRejectedValue(new Error("offline"));
    expect((await g.service.status()).mode).toBe("unavailable");
  });
  it("does not claim a subscription's unused fast model is checking", async () => {
    const f = fixture({
      main: { provider: "chatgpt", model: "gpt-6-astra" },
      fast: { provider: "openai", model: "gpt-6-luna" },
    });
    f.keys.mockResolvedValue([]);
    expect((await f.service.status()).mode).toBe("unconfigured");
  });
});
