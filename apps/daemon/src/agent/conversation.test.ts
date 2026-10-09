import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConversationSnapshot,
  EARLIER_CHARS,
  EARLIER_LEFT_OUT,
  earlierRecord,
  ulid,
} from "@localdot/protocol";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../event-log.ts";
import { Conversations } from "./conversation.ts";
import { type AgentRoutesDeps, agentRoutes } from "./routes.ts";
import { AgentError } from "./runner.ts";

const owned: { home: string; log: EventLog }[] = [];
afterEach(() => {
  for (const item of owned.splice(0)) {
    item.log.close();
    rmSync(item.home, { recursive: true, force: true });
  }
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

function setup() {
  const home = mkdtempSync(join(tmpdir(), "localdot-conversation-"));
  const log = new EventLog(home);
  owned.push({ home, log });
  const start = (title: string, continues?: string) => {
    const id = log.createSession(title);
    log.append(id, {
      type: "session.start",
      agent: "main",
      data: {
        screen: { w: 1280, h: 800, scale: 1 },
        os: "linux",
        title,
        ...(continues ? { continues } : {}),
      },
    });
    return id;
  };
  const say = (id: string, text: string, kind: "task" | "followup" = "task") =>
    log.append(id, {
      type: "message.user",
      agent: "main",
      data: { messageId: ulid(), text, kind },
    });
  const reply = (id: string, text: string) =>
    log.append(id, { type: "message.assistant", agent: "main", data: { messageId: ulid(), text } });
  const end = (id: string, reason: "done" | "stopped" | "error") =>
    log.append(id, { type: "session.end", agent: "main", data: { reason } });
  const task = async (text: string, continues?: string) => {
    await tick();
    const id = start(text.slice(0, 200), continues);
    say(id, text);
    return id;
  };
  return { home, log, start, say, reply, end, task, open: () => new Conversations(home, log) };
}

describe("the current conversation", () => {
  it("reopens the latest task after a restart, passing over a scripted recording", async () => {
    const f = setup();
    expect(f.open().current()).toBeNull();
    const first = await f.task("Draw a dog");
    const latest = await f.task("Make it blue", first);
    await tick();
    f.start("Scripted demo");
    expect(f.open().current()).toBe(latest);
    expect(f.open().snapshot()).toEqual({ sessions: [first, latest], more: false });
  });

  it("keeps a new conversation, and an older one chosen to continue, across restarts", async () => {
    const f = setup();
    const older = await f.task("Plan the trip");
    const newer = await f.task("Book the hotel");
    f.open().begin();
    expect(f.open().current()).toBeNull();
    expect(f.open().snapshot()).toEqual({ sessions: [], more: false });
    expect(f.open().select(older)).toBe(true);
    expect(f.open().current()).toBe(older);
    f.open().adopt(newer);
    expect(f.open().current()).toBe(newer);
  });

  it("only continues a recording that exists", async () => {
    const f = setup();
    const conversations = f.open();
    expect(conversations.select(ulid())).toBe(false);
    expect(conversations.select("../escape")).toBe(false);
    expect(conversations.current()).toBeNull();
    const demo = f.start("Scripted demo");
    expect(conversations.select(demo)).toBe(true);
    expect(conversations.current()).toBe(demo);
  });

  it("starts anew once its latest task is deleted, and ends a chain at a deleted task", async () => {
    const f = setup();
    const first = await f.task("One");
    const second = await f.task("Two", first);
    const third = await f.task("Three", second);
    const conversations = f.open();
    conversations.adopt(third);
    expect(conversations.chain(third).sessions).toEqual([first, second, third]);
    f.log.forget(second);
    expect(conversations.chain(third).sessions).toEqual([third]);
    f.log.forget(third);
    expect(conversations.current()).toBeNull();
  });

  it("reads back a bounded number of tasks, newest kept", async () => {
    const f = setup();
    let previous: string | undefined;
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) {
      previous = await f.task(`Task ${n}`, previous);
      ids.push(previous);
    }
    expect(f.open().chain(ids[4] as string, 3)).toEqual({ sessions: ids.slice(2), more: true });
  });
});

describe("what was said earlier", () => {
  it("records the user's words, dot's replies, questions, results and how each task ended", async () => {
    const f = setup();
    const first = await f.task("Draw a dog");
    f.reply(first, "Which colour?");
    const askId = ulid();
    f.log.append(first, {
      type: "ask.request",
      agent: "main",
      data: {
        askId,
        question: "Which colour should the dog be?",
        options: [
          { key: "A", text: "Brown" },
          { key: "B", text: "Black" },
        ],
        allowText: true,
      },
    });
    f.log.append(first, {
      type: "ask.answer",
      agent: "main",
      data: { askId, option: "B", by: "user" },
    });
    f.log.append(first, {
      type: "task.result",
      agent: "main",
      data: {
        summary: "Drew a black dog.",
        files: [{ name: "dog.png", path: "dog.png", bytes: 3 }],
      },
    });
    f.end(first, "stopped");
    const second = await f.task("Make it bigger", first);
    f.say(second, "And add a hat", "followup");
    expect(f.open().earlier(second)).toEqual([
      "The user: Draw a dog",
      "dot: Which colour?",
      "dot asked: Which colour should the dog be?\nA: Brown\nB: Black",
      "The user answered: Black",
      "dot's result: Drew a black dog.\nFiles: dog.png",
      "(That task was stopped.)",
      "The user: Make it bigger",
      "The user: And add a hat",
      "(That task was interrupted.)",
    ]);
  });

  it("stops reading older tasks once the record is full", async () => {
    const f = setup();
    const old = await f.task("An old task");
    const long = await f.task("x".repeat(1900), old);
    let previous = long;
    for (let n = 0; n < 9; n++) {
      previous = await f.task(`Step ${n} ${"y".repeat(1900)}`, previous);
      f.end(previous, "done");
    }
    const turns = f.open().earlier(previous);
    expect(turns.some((turn) => turn.includes("An old task"))).toBe(false);
    expect(turns.at(-1)).toMatch(/^The user: Step 8 /);
  });

  it("hands over no more than the record can hold, and says when older turns are left out", async () => {
    const f = setup();
    const first = await f.task("The first task");
    let previous = first;
    for (let n = 0; n < 3; n++) {
      for (let r = 0; r < 120; r++) f.reply(previous, `Reply ${n}.${r} ${"z".repeat(150)}`);
      f.end(previous, "done");
      previous = await f.task(`Task ${n}`, previous);
    }
    f.end(previous, "done");
    const turns = f.open().earlier(previous);
    expect(turns.reduce((sum, turn) => sum + turn.length + 1, 0)).toBeLessThanOrEqual(
      EARLIER_CHARS,
    );
    expect(turns[0]).toBe(EARLIER_LEFT_OUT);
    expect(turns.at(-1)).toBe("The user: Task 2");
    expect(earlierRecord(turns)?.match(/left out/g)).toHaveLength(1);
  });
});

describe("conversation routes", () => {
  function routes(release: () => Promise<void> = async () => {}) {
    const f = setup();
    const conversations = f.open();
    const app = new Hono();
    const releases = vi.fn(release);
    agentRoutes(app, {
      runner: { start: vi.fn(), get: () => undefined, raiseBudget: vi.fn(), release: releases },
      conversations,
    } as unknown as AgentRoutesDeps);
    const send = (method: string, path: string, body?: unknown) =>
      app.request(`http://fixture${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    return { ...f, conversations, releases, send };
  }

  it("shows the current conversation, starts a new one and continues an older one", async () => {
    const f = routes();
    const older = await f.task("Plan the trip");
    const newer = await f.task("Book the hotel", older);
    const shown = await f.send("GET", "/api/conversation");
    expect(ConversationSnapshot.parse(await shown.json())).toEqual({
      sessions: [older, newer],
      more: false,
    });
    const fresh = await f.send("POST", "/api/conversation/new");
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toEqual({ sessions: [], more: false });
    expect(f.releases).toHaveBeenCalledTimes(1);
    expect(f.conversations.current()).toBeNull();
    const continued = await f.send("POST", "/api/conversation/continue", { sessionId: older });
    expect(continued.status).toBe(200);
    expect(await continued.json()).toEqual({ sessions: [older], more: false });
    expect(f.releases).toHaveBeenCalledTimes(2);
    expect(f.conversations.current()).toBe(older);
  });

  it("leaves a working task and the current conversation alone", async () => {
    const f = routes(async () => {
      throw new AgentError(409, "Finish or stop the current task first.");
    });
    const current = await f.task("Draw a dog");
    const other = await f.task("Something else");
    f.conversations.adopt(current);
    const fresh = await f.send("POST", "/api/conversation/new");
    expect(fresh.status).toBe(409);
    expect(await fresh.text()).toBe("Finish or stop the current task first.");
    const continued = await f.send("POST", "/api/conversation/continue", { sessionId: other });
    expect(continued.status).toBe(409);
    expect(f.conversations.current()).toBe(current);
    const same = await f.send("POST", "/api/conversation/continue", { sessionId: current });
    expect(same.status).toBe(200);
  });

  it("refuses to continue a recording that does not exist", async () => {
    const f = routes();
    const reply = await f.send("POST", "/api/conversation/continue", { sessionId: ulid() });
    expect(reply.status).toBe(404);
    const invalid = await f.send("POST", "/api/conversation/continue", { sessionId: "nope" });
    expect(invalid.status).toBe(400);
    expect(f.releases).not.toHaveBeenCalled();
  });
});
