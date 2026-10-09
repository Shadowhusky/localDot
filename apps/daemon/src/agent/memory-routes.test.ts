import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryEntriesReply,
  MemoryEntryChangeReply,
  PeopleReply,
  PersonChangeReply,
  RecentActivityReply,
} from "@localdot/protocol";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "./memory.ts";
import { PeopleStore } from "./people.ts";
import { type AgentRoutesDeps, agentRoutes } from "./routes.ts";
import { SettingsStore } from "./settings.ts";

const TASK = "01JXYZ0000000000000000TASK";
const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function setup(options: { canChange?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "localdot-memory-routes-"));
  homes.push(home);
  const memory = new MemoryStore(home);
  const people = new PeopleStore(home);
  const settings = new SettingsStore(home);
  const appended: string[] = [];
  const deps = {
    home,
    runner: {
      start: async () => {
        throw new Error("unused");
      },
      get: () => undefined,
      raiseBudget: async () => {},
    },
    settings,
    catalog: {
      get: () => undefined,
      refresh: async () => {
        throw new Error("unused");
      },
    },
    keyd: { secrets: async () => [] },
    memory,
    people,
    recentActivity: () => [
      {
        sessionId: TASK,
        title: "Renew insurance",
        outcome: "done" as const,
        day: "2026-09-03",
      },
    ],
    skills: () => [],
    desktop: () => undefined,
    redactUserText: (t: string) => t,
    appendTo: (id: string) => {
      appended.push(id);
    },
    canChangeMemory: () => options.canChange ?? true,
    sessionInfo: (ids: readonly string[]) =>
      new Map(
        ids
          .filter((id) => id === TASK)
          .map((id) => [id, { title: "Renew insurance", startedAt: "2026-09-03T09:00:00.000Z" }]),
      ),
  } as unknown as AgentRoutesDeps;
  const app = new Hono();
  agentRoutes(app, deps);
  const send = (method: string, path: string, body?: unknown) =>
    app.request(`http://fixture${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  return { home, memory, people, settings, app, send, appended };
}

describe("memory entry routes", () => {
  it("lists entries for both files with task titles", async () => {
    const { memory, send } = setup();
    memory.apply(TASK, "MEMORY.md", "append", "- Car insurance renews in September");
    memory.addEntry("USER.md", "Prefers window seats");
    const reply = MemoryEntriesReply.parse(
      await (await send("GET", "/api/agent/memory/entries")).json(),
    );
    expect(reply.files.map((f) => f.file)).toEqual(["USER.md", "MEMORY.md"]);
    expect(reply.files[1]?.entries[0]?.source).toEqual({
      kind: "task",
      sessionId: TASK,
      title: "Renew insurance",
    });
    expect(reply.files[0]?.entries[0]?.source).toEqual({ kind: "user" });
    expect(reply.dir.endsWith("memory")).toBe(true);
  });
  it("adds an entry and refuses key-shaped text", async () => {
    const { send } = setup();
    const ok = await send("POST", "/api/agent/memory/entries", {
      file: "USER.md",
      text: "Lives in Lisbon",
    });
    expect(ok.status).toBe(201);
    expect(MemoryEntryChangeReply.parse(await ok.json()).entry?.text).toBe("Lives in Lisbon");
    const key = await send("POST", "/api/agent/memory/entries", {
      file: "USER.md",
      text: `sk-ant-api03-${"a".repeat(95)}`,
    });
    expect(key.status).toBe(400);
  });
  it("edits with the current revision and answers 409 for a stale one", async () => {
    const { memory, send } = setup();
    const { entry } = memory.addEntry("USER.md", "Lives in Lisbon");
    const ok = await send("PUT", `/api/agent/memory/entries/${entry.id}`, {
      file: "USER.md",
      revision: entry.revision,
      text: "Lives in Porto",
    });
    expect(ok.status).toBe(200);
    const stale = await send("PUT", `/api/agent/memory/entries/${entry.id}`, {
      file: "USER.md",
      revision: entry.revision,
      pinned: true,
    });
    expect(stale.status).toBe(409);
  });
  it("deletes a pinned entry from the file, and undo restores it", async () => {
    const { home, memory, send, appended } = setup();
    const { entry } = memory.addEntry("MEMORY.md", "Allergic to penicillin", true);
    const before = memory.read("MEMORY.md");
    const del = await send(
      "DELETE",
      `/api/agent/memory/entries/${entry.id}?file=MEMORY.md&revision=${entry.revision}`,
    );
    expect(del.status).toBe(200);
    expect(readFileSync(join(home, "memory", "MEMORY.md"), "utf8")).not.toContain("penicillin");
    expect(memory.bootMemory().memory).not.toContain("penicillin");
    const { changeId } = MemoryEntryChangeReply.parse(await del.json());
    expect(memory.entries("MEMORY.md")).toEqual([]);
    expect((await send("POST", `/api/agent/memory/${changeId}/undo`)).status).toBe(200);
    expect(memory.read("MEMORY.md")).toBe(before);
    expect(appended).toEqual([]);
  });
  it("answers 503 while memory can't change, 404 for an unknown entry and 400 for a bad id", async () => {
    const busy = setup({ canChange: false });
    expect(
      (await busy.send("POST", "/api/agent/memory/entries", { file: "USER.md", text: "x" })).status,
    ).toBe(503);
    const { send } = setup();
    expect(
      (
        await send(
          "DELETE",
          `/api/agent/memory/entries/01JXYZ0000000000000000ZZZZ?file=USER.md&revision=${"0".repeat(16)}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (await send("DELETE", "/api/agent/memory/entries/not-an-id?file=USER.md&revision=x")).status,
    ).toBe(400);
  });
});

describe("people routes", () => {
  it("round-trips a person dot learned: list with the task's title, edit, delete for good", async () => {
    const { home, people, send } = setup();
    people.record(TASK, { name: "Henry Liu", app: "WeChat", handle: "henry_l" });
    const listed = PeopleReply.parse(await (await send("GET", "/api/agent/people")).json());
    const henry = listed.people[0];
    expect(henry).toMatchObject({
      name: "Henry Liu",
      app: "WeChat",
      handle: "henry_l",
      source: { kind: "task", sessionId: TASK, title: "Renew insurance" },
    });
    const edit = await send("PUT", `/api/agent/people/${henry?.id}`, {
      revision: henry?.revision,
      handle: "henry_liu",
      note: "Colleague",
    });
    expect(edit.status).toBe(200);
    const edited = PersonChangeReply.parse(await edit.json()).person;
    expect(edited).toMatchObject({
      handle: "henry_liu",
      note: "Colleague",
      source: { kind: "user" },
    });
    const stale = await send(
      "DELETE",
      `/api/agent/people/${henry?.id}?revision=${henry?.revision}`,
    );
    expect(stale.status).toBe(409);
    const gone = await send(
      "DELETE",
      `/api/agent/people/${henry?.id}?revision=${edited?.revision}`,
    );
    expect(gone.status).toBe(200);
    expect(readFileSync(join(home, "memory", "people.json"), "utf8")).not.toContain("henry");
    expect(PeopleReply.parse(await (await send("GET", "/api/agent/people")).json()).people).toEqual(
      [],
    );
  });
  it("adds a person as the user and refuses bad input or a busy memory", async () => {
    const { send } = setup();
    const ok = await send("POST", "/api/agent/people", {
      name: "Ana Souza",
      app: "Email",
      handle: "ana@example.com",
    });
    expect(ok.status).toBe(201);
    expect(PersonChangeReply.parse(await ok.json()).person).toMatchObject({
      name: "Ana Souza",
      lastAt: null,
      source: { kind: "user" },
    });
    expect((await send("POST", "/api/agent/people", { name: "", app: "Email" })).status).toBe(400);
    expect(
      (await send("POST", "/api/agent/people", { name: "Ana", app: "Email", extra: 1 })).status,
    ).toBe(400);
    const busy = setup({ canChange: false });
    expect(
      (await busy.send("POST", "/api/agent/people", { name: "Ana", app: "Email" })).status,
    ).toBe(503);
  });
});

describe("recent activity route", () => {
  it("shows what the next task hears and whether it is switched on", async () => {
    const { settings, send } = setup();
    const on = RecentActivityReply.parse(
      await (await send("GET", "/api/agent/recent-activity")).json(),
    );
    expect(on).toEqual({
      enabled: true,
      tasks: [{ sessionId: TASK, title: "Renew insurance", outcome: "done", day: "2026-09-03" }],
    });
    settings.put({ ...settings.get(), recentActivity: "off" });
    const off = RecentActivityReply.parse(
      await (await send("GET", "/api/agent/recent-activity")).json(),
    );
    expect(off.enabled).toBe(false);
  });
});
