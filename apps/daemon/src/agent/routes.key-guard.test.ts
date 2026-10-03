import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../event-log.ts";
import { CatalogStore } from "./catalog-store.ts";
import { MemoryStore } from "./memory.ts";
import { agentRoutes } from "./routes.ts";
import { AgentSession } from "./session.ts";
import { SettingsStore } from "./settings.ts";
import { TranscriptStore } from "./transcript.ts";

const shapes = [
  `sk-ant-api03-${"a".repeat(95)}`,
  `sk-ant-admin01-${"b".repeat(95)}`,
  `sk-proj-${"c".repeat(156)}`,
  `sk-svcacct-${"d".repeat(156)}`,
  `sk-admin-${"e".repeat(156)}`,
  `AIza${"f".repeat(35)}`,
  `AQ.${"g".repeat(128)}`,
  `gsk_${"h".repeat(52)}`,
  `sk-or-v1-${"i".repeat(64)}`,
  `xai-${"j".repeat(64)}`,
  `pplx-${"k".repeat(48)}`,
  `sk-${"a".repeat(32)}`,
];
const owned: { home: string; log: EventLog; session: AgentSession }[] = [];
afterEach(() => {
  for (const fixture of owned.splice(0)) {
    fixture.session.stop();
    fixture.log.close();
    rmSync(fixture.home, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "localdot-key-ingress-"));
  const cell = ulid();
  const log = new EventLog(home);
  const id = log.createSession("synthetic key guard");
  const session = new AgentSession(id, cell, "safe initial task", log);
  session.beginBrain();
  session.status = "running";
  owned.push({ home, log, session });
  const transcript = new TranscriptStore(home);
  const start = vi.fn(async (_cell: string, _task: string) => session);
  const redact = vi.fn((text: string) => text);
  const catalog = new CatalogStore(home, {
    fetchImpl: async () => Response.json(MODELS_DEV_FIXTURE),
  });
  await catalog.refresh();
  const app = new Hono();
  agentRoutes(app, {
    runner: {
      start,
      get: (key) => (key === id ? session : undefined),
      raiseBudget: async () => {},
    },
    settings: new SettingsStore(home),
    catalog,
    memory: new MemoryStore(home),
    keyd: { secrets: async () => [] },
    skills: () => [],
    home,
    desktop: () => undefined,
    redactUserText: redact,
    appendTo: (_id, type, data) => session.append(type, data),
  });
  const endpoint = (name: string) => `/api/agent/sessions/${id}/${name}`;
  const send = (path: string, body: unknown) =>
    app.request(`http://fixture${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const persistInbox = async () => {
    const generation = session.generation;
    if (!generation) throw new Error("missing owned generation");
    const reply = await session.inbox(session.delivered, 0, undefined, generation);
    // Actual source-ID/content validation and fsynced production transcript commits.
    session.appendTranscript(transcript, generation, {
      messages: reply.items
        .filter((item) => item.kind !== "resume")
        .map((item) => ({
          role: "user" as const,
          content: item.text,
          sourceInbox: { seq: item.seq, messageId: item.messageId },
        })),
      inboxAfter: session.inboxSequence,
    });
    return reply.items;
  };
  const files = () =>
    ["events.jsonl", "transcript.jsonl"]
      .map((name) => {
        const path = join(home, "sessions", id, name);
        return existsSync(path) ? readFileSync(path, "utf8") : "";
      })
      .join("\n");
  return { cell, id, session, log, transcript, start, redact, endpoint, send, persistInbox, files };
}

describe("independent key safeguard at all four daemon text ingresses", () => {
  it.each(shapes.map((key, index) => ({ key, index })))(
    "refuses forged HTTP shape $index before event, inbox, transcript or model dispatch",
    async ({ key }) => {
      const f = await fixture();
      const output: unknown[] = [];
      for (const method of ["log", "warn", "error"] as const)
        vi.spyOn(console, method).mockImplementation((...args) => {
          output.push(args);
        });
      const rejected = async (path: string, body: unknown) => {
        const before = f.files(),
          calls = f.redact.mock.calls.length,
          inbox = f.session.inboxSequence;
        const response = await f.send(path, body);
        expect(response.status).toBe(400);
        const refusal = await response.text();
        expect(refusal).toContain("Recognised API keys belong in Keys");
        expect(refusal).not.toContain(key);
        expect(f.files()).toBe(before);
        expect(f.redact).toHaveBeenCalledTimes(calls);
        expect(f.session.inboxSequence).toBe(inbox);
      };
      await rejected(`/api/cells/${f.cell}/agent`, { task: `前面 ${key} 后面` });
      expect(f.start).not.toHaveBeenCalled();
      for (const kind of ["steer", "followup"])
        await rejected(f.endpoint("messages"), { kind, text: `前面\n${key}\n后面` });
      const asking = f.session.ask("Choose", [], true, 0);
      const askId = f.session.pendingAsk;
      await rejected(f.endpoint("answer"), { askId, text: key });
      expect(f.session.pendingAsk).toBe(askId);
      expect(
        (await f.send(f.endpoint("answer"), { askId, text: "安全回答, no credential" })).status,
      ).toBe(204);
      expect(await asking).toMatchObject({ by: "user", text: "安全回答, no credential" });
      const taking = f.session.takeover("login", "safe prompt");
      await Promise.resolve();
      await Promise.resolve();
      const requestId = f.session.pendingTakeover;
      await rejected(f.endpoint("takeover/done"), { requestId, note: key });
      expect(f.session.pendingTakeover).toBe(requestId);
      expect(f.session.controlHeld).toBe(true);
      expect(
        (await f.send(f.endpoint("takeover/done"), { requestId, note: "安全备注, done" })).status,
      ).toBe(204);
      expect(await taking).toMatchObject({ by: "user", note: "安全备注, done" });
      const items = await f.persistInbox();
      expect(items.map((item) => item.text)).toEqual(["安全备注, done"]);
      expect(f.files()).toContain("安全备注, done");
      expect(f.files()).not.toContain(key);
      expect(JSON.stringify(output)).not.toContain(key);
      expect(JSON.stringify(f.transcript.state(f.id))).not.toContain(key);
      expect(f.start).not.toHaveBeenCalled();
    },
  );
  it("positive controls deliver ordinary prose and identifiers through the actual inbox and transcript path", async () => {
    const f = await fixture();
    const task = `请整理 monthly report, sk-proj-EXAMPLE and ${"deadbeef".repeat(8)}`;
    expect((await f.send(`/api/cells/${f.cell}/agent`, { task })).status).toBe(202);
    expect(f.start.mock.calls[0]).toEqual([f.cell, task, expect.any(AbortSignal)]);
    for (const kind of ["steer", "followup"] as const)
      expect(
        (await f.send(f.endpoint("messages"), { kind, text: `${kind}: ${task}` })).status,
      ).toBe(202);
    const inbox = await f.persistInbox();
    expect(inbox.map((item) => item.text)).toEqual([`steer: ${task}`, `followup: ${task}`]);
    expect(f.transcript.state(f.id).inboxAfter).toBe(2);
    expect(f.files()).toContain("deadbeef");
  });
  it("retains strict body and text limits and independently refuses candidate overflow", async () => {
    const f = await fixture();
    for (const task of ["x".repeat(8001), Array(17).fill(shapes[5]).join(" ")])
      expect((await f.send(`/api/cells/${f.cell}/agent`, { task })).status).toBe(400);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.session.inboxSequence).toBe(0);
    expect(f.files().trim()).toBe("");
  });
});
