import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { FrameStore } from "../gateway/frames.ts";
import { DatabaseSync } from "../sqlite.ts";
import { SessionIndex } from "./index-store.ts";
import { Thumbnails } from "./thumbs.ts";

const faults = vi.hoisted(() => ({ removePath: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs")>();
  return {
    ...filesystem,
    rmSync: (path: Parameters<typeof rmSync>[0], options: Parameters<typeof rmSync>[1]) => {
      if (String(path) === faults.removePath) throw new Error("fixture cleanup unavailable");
      return filesystem.rmSync(path, options);
    },
  };
});

const homes: string[] = [];
const logs: EventLog[] = [];
const indexes: SessionIndex[] = [];
const databases: DatabaseSync[] = [];
const token = "deletion-coordination-test-token";

afterEach(() => {
  faults.removePath = "";
  vi.restoreAllMocks();
  for (const index of indexes.splice(0)) index.close();
  for (const database of databases.splice(0)) database.close();
  for (const log of logs.splice(0)) log.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function openApi(home: string, log: EventLog) {
  const index = new SessionIndex(home, { isLive: () => false });
  indexes.push(index);
  const app = createApp({
    token,
    port: 4790,
    eventLog: log,
    replay: {
      home,
      eventLog: log,
      recorder: { info: () => undefined, isLive: () => false },
      index,
      thumbs: new Thumbnails(home, new FrameStore(home)),
    },
  });
  return {
    index,
    request: (path: string, method = "GET") =>
      app.request(`http://127.0.0.1:4790${path}`, {
        method,
        headers: { authorization: `Bearer ${token}` },
      }),
  };
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), "localdot-delete-coordination-"));
  homes.push(home);
  const log = new EventLog(home);
  logs.push(log);
  const sessionId = log.createSession("private deletion fixture");
  log.append(sessionId, { type: "agent.state", agent: "main", data: { state: "idle" } });
  const database = new DatabaseSync(join(home, "index.sqlite"));
  databases.push(database);
  return { home, log, sessionId, database, ...openApi(home, log) };
}

function restart(home: string, previous: EventLog) {
  previous.close();
  logs.splice(logs.indexOf(previous), 1);
  const restarted = new EventLog(home);
  logs.push(restarted);
  return restarted;
}

describe("session deletion across database and filesystem failures", () => {
  it("retries the authenticated DELETE after metadata commits but file cleanup fails", async () => {
    const { home, log, sessionId, database, index, request } = setup();
    await index.card(sessionId);
    const stagedPath = join(home, "sessions", ".deleting", sessionId);
    faults.removePath = stagedPath;
    expect(() => log.forget(sessionId)).toThrow("fixture cleanup unavailable");
    expect(existsSync(stagedPath)).toBe(true);
    for (const table of ["sessions", "session_cards"])
      expect(database.prepare(`SELECT id FROM ${table} WHERE id = ?`).all(sessionId)).toEqual([]);
    expect(database.prepare("SELECT seq FROM events WHERE session_id = ?").all(sessionId)).toEqual(
      [],
    );
    expect((await request(`/api/sessions/${sessionId}/events`)).status).toBe(404);
    expect((await request(`/api/sessions/${sessionId}/card`)).status).toBe(404);
    faults.removePath = "";
    expect((await request(`/api/sessions/${sessionId}`, "DELETE")).status).toBe(204);
    expect(existsSync(stagedPath)).toBe(false);
    expect(existsSync(join(home, "sessions", ".deleting"))).toBe(false);
    expect(log.hasPendingDeletion(sessionId)).toBe(false);
  });

  it("finishes committed deletion cleanup on startup without resurrecting its files or title", () => {
    const { home, log, sessionId } = setup();
    const stagedPath = join(home, "sessions", ".deleting", sessionId);
    faults.removePath = stagedPath;
    expect(() => log.forget(sessionId)).toThrow("fixture cleanup unavailable");
    faults.removePath = "";
    const restarted = restart(home, log);
    expect(restarted.listSessions()).toEqual([]);
    expect(restarted.hasSession(sessionId)).toBe(false);
    expect(existsSync(stagedPath)).toBe(false);
    expect(existsSync(join(home, "sessions", sessionId))).toBe(false);
    expect(existsSync(join(home, "sessions", ".deleting"))).toBe(false);
  });

  it("hides pending deletions across a persistent database failure and still accepts their retry", async () => {
    const { home, log, sessionId, database, index } = setup();
    await index.card(sessionId);
    database.exec(
      "CREATE TRIGGER reject_fixture_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'fixture database unavailable'); END;",
    );
    expect(() => log.forget(sessionId)).toThrow("fixture database unavailable");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const restarted = restart(home, log);
    const { request } = openApi(home, restarted);
    expect(restarted.hasPendingDeletion(sessionId)).toBe(true);
    expect(await (await request("/api/sessions")).json()).toEqual([]);
    const history = await request("/api/session-index");
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ sessions: [] });
    for (const suffix of ["events", "card", "recording", "recording/video.mp4"])
      expect((await request(`/api/sessions/${sessionId}/${suffix}`)).status).toBe(404);
    database.exec("DROP TRIGGER reject_fixture_delete");
    expect((await request(`/api/sessions/${sessionId}`, "DELETE")).status).toBe(204);
    expect(restarted.hasPendingDeletion(sessionId)).toBe(false);
    expect(database.prepare("SELECT id FROM sessions WHERE id = ?").all(sessionId)).toEqual([]);
  });
});
