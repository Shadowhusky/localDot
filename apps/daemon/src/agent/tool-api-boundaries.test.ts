import { mkdtempSync, rmSync } from "node:fs";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactor } from "./redact.ts";
import { AgentSession } from "./session.ts";
import { createToolApi, type ToolApiDeps } from "./tool-api.ts";
import { TranscriptStore } from "./transcript.ts";

const token = "t".repeat(43);
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture missing value");
  return value;
}
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function setup() {
  const home = mkdtempSync("/tmp/ld-tool-api-");
  homes.push(home);
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const session = new AgentSession(ulid(), ulid(), "task", {
    append: (_id, e) => {
      events.push(e);
      return e as never;
    },
  });
  const generation = session.beginBrain();
  session.toolToken = token;
  const transcripts = new TranscriptStore(home);
  const png = vi.fn(async (): Promise<Buffer> => Buffer.from("pixels"));
  const app = createToolApi({
    sessions: () => [session],
    transcripts,
    png: { png },
    redactorFor: () => redactor([token]),
    policy: { decide: async () => ({ kind: "act" }) },
    tools: {} as ToolApiDeps["tools"],
  });
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { session, generation, events, transcripts, png, app, request };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("authenticated generation boundary", () => {
  it("refuses Origin, malformed tokens and retired tokens", async () => {
    const h = setup();
    expect((await h.request("/v1/transcript", undefined, { origin: "" })).status).toBe(403);
    expect(
      (await h.request("/v1/transcript", undefined, { authorization: "Bearer short" })).status,
    ).toBe(401);
    h.session.retireBrain(h.generation);
    expect((await h.request("/v1/transcript")).status).toBe(401);
  });
  it("cancels a stale body read before transcript publication", async () => {
    const h = setup();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const request = new Request("http://tool/v1/transcript", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body,
      duplex: "half",
    } as RequestInit);
    const response = h.app.fetch(request);
    await flush();
    h.session.retireBrain(h.generation);
    expect((await response).status).toBe(409);
    expect(cancel).toHaveBeenCalled();
    expect(h.transcripts.read(h.session.id)).toEqual([]);
  });
  it("caps streamed bytes independently of content-length", async () => {
    const h = setup();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
        c.close();
      },
    });
    const response = await h.app.fetch(
      new Request("http://tool/v1/events", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-length": "1" },
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(413);
    expect(h.events).toEqual([]);
  });
  it("refuses invalid inbox queries instead of coercing them", async () => {
    const h = setup();
    for (const query of ["after=Infinity", "after=-1", "after=1.5", "waitMs=25001"])
      expect((await h.request(`/v1/inbox?${query}`)).status).toBe(400);
  });
  it("redacts nested transcript and brain event text", async () => {
    const h = setup();
    expect(
      (
        await h.request("/v1/transcript", {
          messages: [{ role: "assistant", content: [{ text: `token ${token}` }] }],
        })
      ).status,
    ).toBe(204);
    expect(JSON.stringify(h.transcripts.read(h.session.id))).not.toContain(token);
    expect(
      (
        await h.request("/v1/events", {
          events: [
            { type: "message.assistant", data: { messageId: ulid(), text: `token ${token}` } },
          ],
        })
      ).status,
    ).toBe(204);
    expect(JSON.stringify(h.events)).not.toContain(token);
  });
  it("does not allow model events to declare completion", async () => {
    const h = setup();
    expect(
      (
        await h.request("/v1/events", {
          events: [{ type: "agent.state", data: { state: "done" } }],
        })
      ).status,
    ).toBe(400);
    expect(h.events).toEqual([]);
  });
  it("counts multibyte transcript size in bytes", async () => {
    const h = setup();
    expect(
      (
        await h.request("/v1/transcript", {
          messages: [{ role: "assistant", content: "中".repeat(180000) }],
        })
      ).status,
    ).toBe(400);
    expect(h.transcripts.read(h.session.id)).toEqual([]);
  });
});

describe("frame retrieval and takeover", () => {
  it("taints full and cropped retrieval, rejects malformed regions", async () => {
    const h = setup();
    const frame = ulid();
    expect((await h.request(`/v1/frames/${frame}`)).status).toBe(200);
    expect(h.session.tainted).toBe(true);
    expect(h.session.lastFrameId).toBe(frame);
    h.session.tainted = false;
    expect((await h.request(`/v1/frames/${ulid()}?region=10,10,100,100`)).status).toBe(200);
    expect(h.session.tainted).toBe(true);
    expect(h.session.lastFrameId).toBe(frame);
    for (const region of ["bad", "0,0,-1,20", "1200,0,100,50", "0,0,4,4"])
      expect((await h.request(`/v1/frames/${frame}?region=${region}`)).status).toBe(400);
    expect(h.png).toHaveBeenCalledTimes(2);
  });
  it("refuses all frames and stale state changes during daemon-owned takeover", async () => {
    const h = setup();
    const lease = h.session.admit(h.generation);
    const control = h.session.takeover("login", "sign in", undefined, lease);
    const result = expect(control).rejects.toBeDefined();
    await flush();
    expect((await h.request(`/v1/frames/${ulid()}`)).status).toBe(409);
    expect(
      (
        await h.request("/v1/events", {
          events: [{ type: "agent.state", data: { state: "thinking" } }],
        })
      ).status,
    ).toBe(409);
    expect(h.png).not.toHaveBeenCalled();
    expect(h.session.status).toBe("waiting_user");
    h.session.retireBrain(h.generation);
    await result;
    lease.finish();
    expect((await h.request(`/v1/frames/${ulid()}`)).status).toBe(401);
    expect(h.session.pendingTakeover).toBeDefined();
    h.session.stop();
  });
  it("does not return an in-flight frame after the takeover fence", async () => {
    const h = setup();
    let release!: (b: Buffer) => void;
    h.png.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const frame = h.request(`/v1/frames/${ulid()}`);
    await flush();
    const lease = h.session.admit(h.generation);
    const takeover = h.session.takeover("login", "wait", undefined, lease);
    await flush();
    expect(h.events.some((e) => e.type === "takeover.request")).toBe(false);
    release(Buffer.from("private pixels"));
    const response = await frame;
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("pixels");
    await flush();
    expect(h.events.filter((e) => e.type === "takeover.request")).toHaveLength(1);
    h.session.endTakeover(required(h.session.pendingTakeover), undefined);
    await takeover;
    lease.finish();
  });
  it("never returns a late frame from a retired generation", async () => {
    const h = setup();
    let release!: (b: Buffer) => void;
    h.png.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const work = h.request(`/v1/frames/${ulid()}`);
    await flush();
    h.session.retireBrain(h.generation);
    h.session.beginBrain();
    h.session.toolToken = "n".repeat(43);
    release(Buffer.from("stale pixels"));
    const response = await work;
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("pixels");
  });
});
