import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventDraft, type LocalDotEvent, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Clock } from "./clock.ts";
import { EventLog, UnknownSessionError } from "./event-log.ts";
import { DatabaseSync } from "./sqlite.ts";

const fsHooks = vi.hoisted(() => ({ tearNextAppend: false }));

// Lets a test make the next append write part of its line and then fail, as ENOSPC does mid-write.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const appendFileSync: typeof fs.appendFileSync = (file, data, options) => {
    if (fsHooks.tearNextAppend) {
      fsHooks.tearNextAppend = false;
      fs.appendFileSync(file, String(data).slice(0, 20));
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    }
    fs.appendFileSync(file, data, options);
  };
  return { ...fs, appendFileSync };
});

afterEach(() => {
  fsHooks.tearNextAppend = false;
  vi.restoreAllMocks();
});

const home = () => mkdtempSync(join(tmpdir(), "local dot's log-"));
const sessionFile = (dir: string, id: string) => join(dir, "sessions", id, "events.jsonl");
const rowsOf = (events: LocalDotEvent[]) =>
  events.map((e) => ({ seq: e.seq, t: e.t, type: e.type, step: e.step ?? null, agent: e.agent }));
const indexRows = (dir: string, id: string) => {
  const db = new DatabaseSync(join(dir, "index.sqlite"));
  try {
    return db
      .prepare("SELECT seq, t, type, step, agent FROM events WHERE session_id = ? ORDER BY seq")
      .all(id);
  } finally {
    db.close();
  }
};
const fakeClock = (start = 0): Clock & { advance(us: number): void } => {
  let now = start;
  return {
    nowMicros: () => now,
    advance: (us) => {
      now += us;
    },
  };
};
const thinking: EventDraft = { type: "agent.state", agent: "main", data: { state: "thinking" } };
const idle: EventDraft = { type: "agent.state", agent: "main", data: { state: "idle" } };
const multibyte: EventDraft = {
  type: "agent.state",
  agent: "主エージェント",
  step: "ステップ一",
  data: { state: "acting" },
};

describe("EventLog", () => {
  it("looks up titles and start times, skipping unknown and deleted tasks", () => {
    const dir = home();
    const log = new EventLog(dir);
    try {
      const kept = log.createSession("Renew the car insurance");
      const gone = log.createSession("Plan the Lisbon trip");
      log.forget(gone);
      const info = log.sessionInfo([kept, gone, ulid(), "not-a-ulid"]);
      expect([...info.keys()]).toEqual([kept]);
      expect(info.get(kept)).toEqual({
        title: "Renew the car insurance",
        startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
    } finally {
      log.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps daemon microseconds onto a session's time base", () => {
    const clock = fakeClock(5_000_000);
    const log = new EventLog(home(), clock);
    const id = log.createSession("t");
    expect(log.originOf(id)).toBe(5_000_000);
    expect(log.toSessionT(id, 5_250_000)).toBe(250_000);
    expect(log.toSessionT(id, 4_000_000)).toBe(0);
    expect(() => log.toSessionT("01JXYZ0000000000000000ABCD", 1)).toThrow(UnknownSessionError);
  });

  it("appends events with increasing seq and non-decreasing t", () => {
    const clock = fakeClock();
    const log = new EventLog(home(), clock);
    const id = log.createSession("demo");
    log.append(id, thinking);
    clock.advance(1500);
    log.append(id, thinking);
    clock.advance(-5000);
    log.append(id, thinking);
    const events = log.read(id);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(events.map((e) => e.t)).toEqual([0, 1500, 1500]);
  });

  it("rejects an invalid event without writing it", () => {
    const log = new EventLog(home(), fakeClock());
    const id = log.createSession();
    const invalid = {
      type: "action.intent",
      agent: "main",
      data: { verb: "click", risk: "none" },
    } as unknown as EventDraft;
    expect(() => log.append(id, invalid)).toThrow();
    expect(log.read(id)).toEqual([]);
  });

  it("recovers after a crash mid-append: drops the partial line, continues seq and t", () => {
    const dir = home();
    const first = new EventLog(dir, fakeClock(0));
    const id = first.createSession();
    first.append(id, thinking);
    first.append(id, multibyte);
    const file = sessionFile(dir, id);
    const torn = Buffer.from('{"v":1,"id":"01J9ZQ3V8Y7X6W5T4S3R2Q1P0N","seq":2,"agent":"主エ');
    appendFileSync(file, torn.subarray(0, -1));
    first.close();

    const second = new EventLog(dir, fakeClock(0));
    expect(second.listSessions()[0]?.events).toBe(2);
    expect(indexRows(dir, id)).toEqual(rowsOf(second.read(id)));
    const next = second.append(id, thinking);
    expect(next.seq).toBe(2);
    const events = second.read(id);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(events[1]).toMatchObject({ agent: "主エージェント", step: "ステップ一" });
    expect(next.t).toBeGreaterThan(Math.max(...events.slice(0, -1).map((e) => e.t)));
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(second.listSessions()[0]?.events).toBe(3);
    expect(indexRows(dir, id)).toEqual(rowsOf(events));
  });

  it("reconciles an index that ran ahead of the file at startup", () => {
    const dir = home();
    const first = new EventLog(dir, fakeClock(0));
    const id = first.createSession();
    for (let i = 0; i < 3; i++) first.append(id, thinking);
    first.close();
    const file = sessionFile(dir, id);
    const [line0 = "", line1 = ""] = readFileSync(file, "utf8").split("\n");
    writeFileSync(file, `${line0}\n${line1.slice(0, 20)}`);

    const second = new EventLog(dir, fakeClock(0));
    expect(second.listSessions()[0]?.events).toBe(1);
    expect(indexRows(dir, id)).toEqual(rowsOf(second.read(id)));
    expect(second.append(id, idle).seq).toBe(1);
    expect(second.listSessions()[0]?.events).toBe(2);
    expect(indexRows(dir, id)).toEqual(rowsOf(second.read(id)));
  });

  it("rolls back a torn append so the file is unchanged and no seq is reused", () => {
    const dir = home();
    const log = new EventLog(dir, fakeClock());
    const id = log.createSession();
    const live: number[] = [];
    log.subscribe((_sid, e) => live.push(e.seq));
    log.append(id, thinking);
    log.append(id, thinking);
    const file = sessionFile(dir, id);
    const before = readFileSync(file);
    fsHooks.tearNextAppend = true;
    expect(() => log.append(id, idle)).toThrow("ENOSPC");
    expect(readFileSync(file)).toEqual(before);
    log.append(id, idle);
    log.append(id, idle);
    expect(live).toEqual([0, 1, 2, 3]);
    expect(log.read(id).map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    log.close();

    const again = new EventLog(dir, fakeClock());
    expect(again.read(id).map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(again.append(id, thinking).seq).toBe(4);
    expect(again.listSessions()[0]?.events).toBe(5);
  });

  it("cuts a stray fragment written behind the log's back before the next append", () => {
    const dir = home();
    const log = new EventLog(dir, fakeClock());
    const id = log.createSession();
    const live: number[] = [];
    log.subscribe((_sid, e) => live.push(e.seq));
    log.append(id, thinking);
    log.append(id, thinking);
    appendFileSync(sessionFile(dir, id), '{"v":1,"id":"01J9ZQ3V8Y7X6W5T4S3R2Q1P0N","seq":2,"t":');
    for (let i = 0; i < 3; i++) log.append(id, idle);
    expect(live).toEqual([0, 1, 2, 3, 4]);
    expect(log.read(id).map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(log.listSessions()[0]?.events).toBe(5);
  });

  it("skips a complete line that fails validation and keeps reading past it", () => {
    const dir = home();
    const first = new EventLog(dir, fakeClock());
    const id = first.createSession();
    first.append(id, thinking);
    const file = sessionFile(dir, id);
    appendFileSync(file, '{"v":1,"seq":1,"t":\n');
    first.append(id, thinking);
    first.append(id, thinking);
    expect(first.read(id).map((e) => e.seq)).toEqual([0, 1, 2]);
    first.close();

    const second = new EventLog(dir, fakeClock());
    expect(second.read(id).map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(second.append(id, thinking).seq).toBe(3);
    expect(readFileSync(file, "utf8")).toContain('{"v":1,"seq":1,"t":\n');
    expect(second.listSessions()[0]?.events).toBe(4);
  });

  it("keeps appending while the index is locked and repairs the index afterwards", {
    timeout: 10_000,
  }, () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = home();
    const log = new EventLog(dir, fakeClock());
    const id = log.createSession();
    log.append(id, thinking);
    const other = new DatabaseSync(join(dir, "index.sqlite"));
    other.exec("BEGIN IMMEDIATE");
    const started = performance.now();
    const locked = log.append(id, thinking);
    const waited = performance.now() - started;
    other.exec("ROLLBACK");
    other.close();
    expect(locked.seq).toBe(1);
    expect(waited).toBeGreaterThanOrEqual(1500);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(log.append(id, idle).seq).toBe(2);
    expect(log.read(id).map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(indexRows(dir, id)).toEqual(rowsOf(log.read(id)));
    expect(log.listSessions()[0]?.events).toBe(3);
  });

  it("keeps appending to a session recovered while the index is locked, and restores its row", {
    timeout: 10_000,
  }, () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = home();
    const first = new EventLog(dir, fakeClock());
    const id = first.createSession("locked");
    first.append(id, thinking);
    first.close();
    const other = new DatabaseSync(join(dir, "index.sqlite"));
    // The row goes too, as with a deleted index, so the repair has to put it back.
    other.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    other.exec("BEGIN IMMEDIATE");
    const second = new EventLog(dir, fakeClock());
    const locked = second.append(id, idle);
    other.exec("ROLLBACK");
    other.close();
    expect(locked.seq).toBe(1);
    expect(errors).toHaveBeenCalledTimes(2);
    expect(second.append(id, idle).seq).toBe(2);
    expect(second.read(id).map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(indexRows(dir, id)).toEqual(rowsOf(second.read(id)));
    expect(second.listSessions()).toEqual([
      expect.objectContaining({ id, title: "locked", events: 3 }),
    ]);
  });

  it("still appends and notifies other subscribers when one subscriber throws", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = new EventLog(home(), fakeClock());
    const id = log.createSession();
    const seen: number[] = [];
    log.subscribe(() => {
      throw new Error("subscriber failed");
    });
    log.subscribe((_sid, e) => seen.push(e.seq));
    expect(log.append(id, thinking).seq).toBe(0);
    expect(seen).toEqual([0]);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it("starts even when one session's log cannot be read", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = home();
    const first = new EventLog(dir, fakeClock());
    const broken = first.createSession();
    const healthy = first.createSession();
    first.append(healthy, thinking);
    first.close();
    mkdirSync(sessionFile(dir, broken));

    const second = new EventLog(dir, fakeClock());
    expect(errors).toHaveBeenCalledTimes(1);
    expect(second.read(healthy)).toHaveLength(1);
    expect(() => second.read(broken)).toThrow("EISDIR");
  });

  it("keeps the index and its journal files private", () => {
    const dir = home();
    const index = join(dir, "index.sqlite");
    new EventLog(dir, fakeClock()).close();
    expect(statSync(index).mode & 0o777).toBe(0o600);
    chmodSync(index, 0o644);
    writeFileSync(`${index}-wal`, "", { mode: 0o644 });
    const again = new EventLog(dir, fakeClock());
    expect(statSync(index).mode & 0o777).toBe(0o600);
    expect(statSync(`${index}-wal`).mode & 0o777).toBe(0o600);
    again.close();
  });

  it("lists sessions with event counts", () => {
    const log = new EventLog(home(), fakeClock());
    const id = log.createSession("counted");
    log.append(id, thinking);
    expect(log.listSessions()).toEqual([
      expect.objectContaining({ id, title: "counted", events: 1 }),
    ]);
  });

  it("notifies subscribers of each appended event", () => {
    const log = new EventLog(home(), fakeClock());
    const id = log.createSession();
    const seen: number[] = [];
    const stop = log.subscribe((sid, e) => {
      if (sid === id) seen.push(e.seq);
    });
    log.append(id, thinking);
    stop();
    log.append(id, thinking);
    expect(seen).toEqual([0]);
  });

  it("refuses session ids that are not ULIDs", () => {
    const log = new EventLog(home(), fakeClock());
    expect(() => log.read("../../etc")).toThrow("invalid session id");
    expect(() => log.append("01j9zq3v8y7x6w5t4s3r2q1p0n", thinking)).toThrow("invalid session id");
  });

  it("tells a session that does not exist apart from an empty one", () => {
    const log = new EventLog(home(), fakeClock());
    const empty = log.createSession();
    const unknown = ulid();
    expect(log.hasSession(empty)).toBe(true);
    expect(log.read(empty)).toEqual([]);
    expect(log.hasSession(unknown)).toBe(false);
    expect(log.hasSession("../../etc")).toBe(false);
    expect(() => log.read(unknown)).toThrow(UnknownSessionError);
    expect(() => log.append(unknown, thinking)).toThrow(UnknownSessionError);
  });

  it("creates each session's log private to the user", () => {
    const dir = home();
    const log = new EventLog(dir, fakeClock());
    const id = log.createSession();
    log.append(id, thinking);
    expect(statSync(sessionFile(dir, id)).mode & 0o777).toBe(0o600);
  });

  it("stores each session's title and start time in its folder", () => {
    const dir = home();
    const log = new EventLog(dir);
    const id = log.createSession("Compare flights");
    const file = join(dir, "sessions", id, "session.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const meta = JSON.parse(readFileSync(file, "utf8")) as {
      id: string;
      title: string | null;
      startedAt: string;
    };
    expect(meta.id).toBe(id);
    expect(meta.title).toBe("Compare flights");
    expect(Number.isNaN(Date.parse(meta.startedAt))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(dir, "sessions", log.createSession(), "session.json"), "utf8"))
        .title,
    ).toBeNull();
  });

  it("rebuilds the sessions index from the session folders", () => {
    const dir = home();
    const first = new EventLog(dir);
    const a = first.createSession("A");
    const b = first.createSession("B");
    first.append(a, thinking);
    first.append(a, idle);
    first.append(b, thinking);
    const before = first.listSessions();
    first.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"])
      rmSync(join(dir, `index.sqlite${suffix}`), { force: true });
    const second = new EventLog(dir);
    // A and B usually start in the same millisecond: listSessions breaks that tie by id, so the
    // order survives a rebuild, but B need not come before A.
    expect(second.listSessions()).toEqual(before);
    expect(new Map(second.listSessions().map((s) => [s.id, [s.title, s.events]]))).toEqual(
      new Map([
        [a, ["A", 2]],
        [b, ["B", 1]],
      ]),
    );
  });

  it("orders sessions that start in the same millisecond by id, highest first", () => {
    const dir = home();
    const low = ulid(1_759_312_800_000, (n) => new Uint8Array(n));
    const high = ulid(1_759_312_800_000, (n) => new Uint8Array(n).fill(7));
    for (const id of [low, high]) {
      mkdirSync(join(dir, "sessions", id), { recursive: true });
      writeFileSync(join(dir, "sessions", id, "events.jsonl"), "");
    }
    expect(new EventLog(dir).listSessions().map((s) => s.id)).toEqual([high, low]);
  });

  it("derives session.json from the ULID for a folder that lacks it", () => {
    const dir = home();
    const id = ulid(1_759_312_800_000);
    mkdirSync(join(dir, "sessions", id), { recursive: true });
    writeFileSync(join(dir, "sessions", id, "events.jsonl"), "");
    const log = new EventLog(dir);
    const meta = JSON.parse(readFileSync(join(dir, "sessions", id, "session.json"), "utf8")) as {
      title: string | null;
      startedAt: string;
    };
    expect(meta).toEqual({ id, title: null, startedAt: "2025-10-01T10:00:00.000Z" });
    expect(log.listSessions().map((s) => s.id)).toContain(id);
  });
});
