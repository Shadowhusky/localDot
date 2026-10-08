import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { DatabaseSync } from "../sqlite.ts";

const homes: string[] = [];
const logs: EventLog[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const log of logs.splice(0)) log.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), "review-history-delete-"));
  homes.push(home);
  const log = new EventLog(home);
  logs.push(log);
  const id = log.createSession("private fixture title");
  log.append(id, { type: "agent.state", agent: "main", data: { state: "idle" } });
  const db = new DatabaseSync(join(home, "index.sqlite"));
  databases.push(db);
  return { home, log, id, db };
}
describe("review: durable session deletion", () => {
  it("a failed index transaction leaves deletion retryable rather than retaining unreachable private rows", () => {
    const { home, log, id, db } = setup();
    db.exec(
      "CREATE TRIGGER reject_fixture_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'owned fixture transaction failure'); END;",
    );
    expect(() => log.forget(id)).toThrow("owned fixture transaction failure");
    db.exec("DROP TRIGGER reject_fixture_delete");
    // After the transient database failure clears, the same explicit delete must finish.
    expect(
      () => log.forget(id),
      "retry can still remove all persistent session metadata",
    ).not.toThrow();
    expect(log.listSessions()).toEqual([]);
    expect(db.prepare("SELECT * FROM events WHERE session_id = ?").all(id)).toEqual([]);
    expect(existsSync(join(home, "sessions", id))).toBe(false);
  });
  it("a failed delete cannot leave the removed session visible through the API after daemon restart", async () => {
    const { home, log, id, db } = setup();
    db.exec(
      "CREATE TRIGGER reject_fixture_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'owned fixture transaction failure'); END;",
    );
    expect(() => log.forget(id)).toThrow("owned fixture transaction failure");
    db.exec("DROP TRIGGER reject_fixture_delete");
    log.close();
    logs.splice(logs.indexOf(log), 1);
    const restarted = new EventLog(home);
    logs.push(restarted);
    const token = "review-private-fixture-token";
    const app = createApp({ token, port: 4790, eventLog: restarted });
    const response = await app.request("http://127.0.0.1:4790/api/sessions", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const rows = (await response.json()) as { id: string }[];
    expect(
      rows.filter((row) => row.id === id && !restarted.hasSession(row.id)),
      "restart has no undeletable orphan history rows",
    ).toEqual([]);
  });
  it("successful deletion removes both private files and all indexed rows", () => {
    const { home, log, id, db } = setup();
    log.forget(id);
    expect(log.listSessions()).toEqual([]);
    expect(db.prepare("SELECT * FROM events WHERE session_id = ?").all(id)).toEqual([]);
    expect(existsSync(join(home, "sessions", id))).toBe(false);
  });
});
