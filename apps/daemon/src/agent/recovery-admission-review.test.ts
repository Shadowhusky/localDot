import { mkdtempSync, rmSync } from "node:fs";
import { ulid } from "@localdot/protocol";
import { Hono } from "hono";
import { afterEach, expect, it } from "vitest";
import { MemoryStore } from "./memory.ts";
import { agentRoutes } from "./routes.ts";
import { AgentSession } from "./session.ts";
import { SettingsStore } from "./settings.ts";

const owned: { home: string; session: AgentSession }[] = [];
afterEach(() => {
  for (const f of owned.splice(0)) {
    f.session.stop();
    rmSync(f.home, { recursive: true, force: true });
  }
});
function fixture() {
  const home = mkdtempSync("/tmp/localdot-task11-review-admission-");
  const events: { type: string; data: unknown }[] = [];
  const session = new AgentSession(ulid(), ulid(), "inert recovery", {
    append: (_id, event) => {
      events.push(event);
      return undefined as never;
    },
  });
  session.beginBrain();
  session.status = "paused";
  const memory = new MemoryStore(home);
  const change = memory.apply(session.id, "MEMORY.md", "append", "Durable fixture fact");
  let memoryAllowed = true;
  const app = new Hono();
  agentRoutes(app, {
    home,
    memory,
    settings: new SettingsStore(home),
    runner: {
      get: (id) => (id === session.id ? session : undefined),
      start: async () => {
        throw new Error("unexpected start");
      },
      raiseBudget: async () => {
        throw new Error("unexpected raise");
      },
    },
    catalog: {
      get: () => undefined,
      refresh: async () => {
        throw new Error("unexpected refresh");
      },
    },
    keyd: { secrets: async () => [] },
    skills: () => [],
    desktop: () => {
      throw new Error("unexpected desktop");
    },
    redactUserText: (text) => text,
    appendTo: (_id, type, data) => {
      events.push({ type, data });
    },
    canChangeMemory: () => memoryAllowed,
    taskMutationReady: () => true,
  });
  const result = {
    home,
    session,
    memory,
    change,
    events,
    app,
    setMemoryAllowed(value: boolean) {
      memoryAllowed = value;
    },
  };
  owned.push(result);
  return result;
}
it.each(["resume", "undo"] as const)(
  "does not dispatch bodyless %s after request cancellation at the body-admission await",
  async (kind) => {
    const f = fixture();
    const path =
      kind === "resume"
        ? `/api/agent/sessions/${f.session.id}/resume`
        : `/api/agent/memory/${f.change.changeId}/undo`;
    const controller = new AbortController();
    const response = f.app.request(path, { method: "POST", signal: controller.signal });
    controller.abort();
    const res = await response;
    expect.soft(res.status, "cancelled admission must not acknowledge a mutation").toBe(499);
    if (kind === "resume")
      expect(f.session.inboxSequence, "no cancelled Resume in durable inbox").toBe(0);
    else {
      expect(f.memory.readBoth().memory, "no cancelled memory mutation").toContain(
        "Durable fixture fact",
      );
      expect(f.events.filter((row) => row.type === "memory.change")).toHaveLength(0);
    }
  },
);
it("positive control keeps explicit, uncancelled bodyless Resume and Undo available", async () => {
  const f = fixture();
  expect(
    (await f.app.request(`/api/agent/sessions/${f.session.id}/resume`, { method: "POST" })).status,
  ).toBe(204);
  expect(f.session.inboxSequence).toBe(1);
  expect(
    (await f.app.request(`/api/agent/memory/${f.change.changeId}/undo`, { method: "POST" })).status,
  ).toBe(200);
  expect(f.memory.readBoth().memory).not.toContain("Durable fixture fact");
  expect(f.events.filter((row) => row.type === "memory.change")).toHaveLength(1);
});

it("refuses held-memory mutation before any durable file or journal change", async () => {
  const f = fixture();
  f.setMemoryAllowed(false);
  const response = await f.app.request(`/api/agent/memory/${f.change.changeId}/undo`, {
    method: "POST",
  });
  expect.soft(response.status, "held owner must refuse the exact Undo").toBe(409);
  expect
    .soft(f.memory.readBoth().memory, "held owner must preserve actual memory bytes")
    .toContain("Durable fixture fact");
  expect(
    f.events.filter((row) => row.type === "memory.change"),
    "no false success journal",
  ).toHaveLength(0);
});
