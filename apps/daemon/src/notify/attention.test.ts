import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AttentionItem, type EventDraft, ulid } from "@localdot/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../event-log.ts";
import { AttentionLedger, taskTitle } from "./attention.ts";

let home: string;
let log: EventLog;
let ledger: AttentionLedger;
let changes: AttentionItem[];
let now: number;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ld-attention-"));
  log = new EventLog(home);
  now = 1_000;
  ledger = new AttentionLedger(() => now);
  log.subscribe((id, event) => ledger.observe(id, event));
  changes = [];
  ledger.subscribe((item) => changes.push(item));
});
afterEach(() => {
  log.close();
  rmSync(home, { recursive: true, force: true });
});

const draft = (type: string, data: Record<string, unknown>) =>
  ({ type, agent: "main", data }) as unknown as EventDraft;
function session(title = "Pay the electricity bill"): string {
  const id = log.createSession(title);
  log.append(
    id,
    draft("session.start", { screen: { w: 1280, h: 800, scale: 1 }, os: "linux", title }),
  );
  log.append(id, draft("message.user", { messageId: ulid(), text: title, kind: "task" }));
  return id;
}
const approval = (approvalId: string, revision: number) =>
  draft("approval.request", {
    actionClass: "send",
    risk: "high",
    title: "Send the statement to accounts@example.test",
    kind: "send",
    preview: { fields: [] },
    approvalId,
    generation: 1,
    revision,
    expiresAt: 9_999_999_999,
  });
const resolve = (approvalId: string) =>
  draft("approval.resolve", { approvalId, decision: "approve", by: "user" });
const state = (value: string, reason?: string) =>
  draft("agent.state", { state: value, ...(reason ? { reason } : {}) });
const levels = () => changes.map((item) => `${item.reason}:${item.level}`);

describe("AttentionLedger", () => {
  it("raises one needs-you per approval revision and drops it when answered", () => {
    const id = session();
    const card = ulid();
    log.append(id, approval(card, 1));
    log.append(id, approval(card, 1));
    log.append(id, approval(card, 2));
    log.append(id, resolve(card));
    expect(levels()).toEqual(["approval:needs_you", "approval:needs_you", "working:working"]);
    expect(changes[0]?.key).toBe(`${id}:approval:${card}:1:1`);
    expect(changes[1]?.key).toBe(`${id}:approval:${card}:1:2`);
    expect(ledger.snapshot()).toEqual([]);
  });

  it("ignores an answer to a card that is no longer the one waiting", () => {
    const id = session();
    const first = ulid();
    const second = ulid();
    log.append(id, approval(first, 1));
    log.append(id, approval(second, 1));
    log.append(id, resolve(first));
    expect(ledger.current(id)?.level).toBe("needs_you");
    expect(ledger.current(id)?.key).toContain(second);
  });

  it("covers questions, take-overs, budget, done, giving up and errors", () => {
    const id = session();
    const askId = ulid();
    const requestId = ulid();
    log.append(
      id,
      draft("ask.request", { askId, question: "Which account?", options: [], allowText: true }),
    );
    log.append(id, draft("ask.answer", { askId, text: "Main", by: "user" }));
    log.append(id, draft("takeover.request", { requestId, reason: "login", note: "Sign in" }));
    log.append(id, draft("takeover.end", { requestId, by: "user" }));
    log.append(id, draft("budget.exceeded", { scope: "task", limitUSD: 2, spentUSD: 2 }));
    log.append(id, state("thinking"));
    log.append(id, state("done"));
    log.append(
      id,
      draft("message.user", { messageId: ulid(), text: "Also file it", kind: "followup" }),
    );
    log.append(id, state("idle", "gave up"));
    log.append(id, draft("session.end", { reason: "error" }));
    expect(levels()).toEqual([
      "ask:needs_you",
      "working:working",
      "takeover:needs_you",
      "working:working",
      "budget:blocked",
      "working:working",
      "done:done",
      "working:working",
      "gave_up:failed",
    ]);
  });

  it("asks nothing of a user who took the computer themselves", () => {
    const id = session();
    const requestId = ulid();
    log.append(id, draft("takeover.request", { requestId, reason: "other", note: "", by: "user" }));
    log.append(id, draft("takeover.end", { requestId, by: "user" }));
    expect(changes).toEqual([]);
    expect(ledger.current(id)).toBeUndefined();
  });

  it("orders open items by priority across sessions, then newest first", () => {
    const done = session("Tidy the downloads");
    log.append(done, state("done"));
    now = 2_000;
    const blocked = session("Book the train");
    log.append(blocked, draft("budget.exceeded", { scope: "task", limitUSD: 2, spentUSD: 2 }));
    now = 3_000;
    const asking = session("Pay the bill");
    log.append(asking, approval(ulid(), 1));
    now = 4_000;
    const failed = session("Renew the domain");
    log.append(failed, draft("session.end", { reason: "error" }));
    expect(ledger.snapshot().map((item) => [item.task, item.level])).toEqual([
      ["Pay the bill", "needs_you"],
      ["Renew the domain", "failed"],
      ["Book the train", "blocked"],
      ["Tidy the downloads", "done"],
    ]);
  });

  it("keeps Done and Failed until seen, and clears what a stopped task waited on", () => {
    const id = session();
    log.append(id, state("done"));
    log.append(id, draft("session.end", { reason: "done" }));
    expect(ledger.current(id)?.level).toBe("done");
    expect(ledger.seen(id)).toBe(true);
    expect(ledger.current(id)).toBeUndefined();
    const stopped = session();
    log.append(stopped, approval(ulid(), 1));
    log.append(stopped, draft("session.end", { reason: "stopped" }));
    expect(changes.at(-1)).toMatchObject({ sessionId: stopped, level: "none", reason: "cleared" });
    expect(ledger.seen(stopped)).toBe(false);
  });

  it("carries the task's own title, never one that looks like a key", () => {
    const id = session("Pay   the\nelectricity bill");
    log.append(id, state("done"));
    expect(changes.at(-1)?.task).toBe("Pay the electricity bill");
    expect(taskTitle(`Use sk-ant-api03-${"a".repeat(90)} to call it`)).toBeNull();
    expect(taskTitle("x".repeat(200))).toHaveLength(80);
  });

  it("knows when the waiting approval expires, and forgets it once answered", () => {
    const id = session();
    const card = ulid();
    log.append(id, approval(card, 1));
    expect(ledger.approvalExpiresAt(id)).toBe(9_999_999_999);
    log.append(id, resolve(card));
    expect(ledger.approvalExpiresAt(id)).toBeUndefined();
  });
});
