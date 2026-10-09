import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../event-log.ts";
import { RecentActivity } from "./recent-activity.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c();
});
function setup(live = new Set<string>()) {
  const home = mkdtempSync(join(tmpdir(), "localdot-recent-"));
  const log = new EventLog(home);
  cleanup.push(
    () => rmSync(home, { recursive: true, force: true }),
    () => log.close(),
  );
  const task = (title: string, end?: "done" | "stopped" | "error") => {
    const id = log.createSession(title);
    log.append(id, {
      type: "message.user",
      agent: "main",
      data: { messageId: ulid(), kind: "task", text: title },
    });
    log.append(id, {
      type: "message.assistant",
      agent: "main",
      data: { messageId: ulid(), text: "Private page text dot read" },
    });
    if (end) log.append(id, { type: "session.end", agent: "main", data: { reason: end } });
    return id;
  };
  return { log, task, recent: new RecentActivity({ log, isLive: (id) => live.has(id) }) };
}

describe("recent activity", () => {
  it("lists the user's last tasks newest first with how they ended, and nothing dot read", () => {
    const live = new Set<string>();
    const { log, task, recent } = setup(live);
    task("Renew the car insurance", "done");
    task("Book a table", "stopped");
    log.createSession("You used the computer");
    const running = task("Send Henry the report");
    live.add(running);
    const list = recent.list();
    expect(list.map((t) => [t.title, t.outcome])).toEqual([
      ["Send Henry the report", "running"],
      ["Book a table", "stopped"],
      ["Renew the car insurance", "done"],
    ]);
    expect(list[0]?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(JSON.stringify(list)).not.toContain("Private page text");
  });
  it("leaves out the asking task and deleted tasks, and stops at the limit", () => {
    const { log, task, recent } = setup();
    const ids = ["One", "Two", "Three", "Four", "Five", "Six"].map((t) => task(t, "done"));
    expect(recent.list().map((t) => t.title)).toEqual(["Six", "Five", "Four", "Three", "Two"]);
    log.forget(ids[5] as string);
    expect(recent.list(ids[4]).map((t) => t.title)).toEqual(["Four", "Three", "Two", "One"]);
    const interrupted = task("Left hanging");
    expect(recent.list().find((t) => t.sessionId === interrupted)?.outcome).toBe("interrupted");
  });
});
