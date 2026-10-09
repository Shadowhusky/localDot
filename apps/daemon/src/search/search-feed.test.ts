import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../agent/memory.ts";
import { EventLog } from "../event-log.ts";
import { seedSession } from "../recorder/testing/seed-session.ts";
import { DatabaseSync } from "../sqlite.ts";
import { SearchFeed } from "./search-feed.ts";
import { SearchIndex } from "./search-index.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0).reverse())
    try {
      c();
    } catch {
      // already closed by the test
    }
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), "localdot-feed-"));
  const log = new EventLog(home);
  const index = new SearchIndex(home, { sessions: log });
  const memory = new MemoryStore(home);
  const feed = new SearchFeed({ index, eventLog: log, notes: memory });
  cleanup.push(
    () => rmSync(home, { recursive: true, force: true }),
    () => log.close(),
    () => index.close(),
  );
  return { home, log, index, memory, feed };
}
const user = (text: string) =>
  ({
    type: "message.user",
    agent: "main",
    data: { messageId: ulid(), kind: "task", text },
  }) as const;

describe("search feed", () => {
  it("ranks the insurance task first across three seeded tasks", async () => {
    const { home, index, feed } = setup();
    const seed = (title: string) =>
      seedSession({ home, minutes: 0.2, stepsPerMinute: 10, title, video: false });
    const car = (await seed("Renew the car insurance")).sessionId;
    const trip = (await seed("Plan the Lisbon trip")).sessionId;
    const tidy = (await seed("Tidy the downloads folder")).sessionId;
    const extra = new EventLog(home);
    cleanup.push(() => extra.close());
    extra.append(car, user("Renew my car insurance before it lapses"));
    extra.append(car, {
      type: "task.result",
      agent: "main",
      data: {
        summary: "Renewed the car insurance with the cheaper quote.",
        files: [{ name: "policy-2026.pdf", path: "x", bytes: 10 }],
      },
    });
    extra.append(trip, {
      type: "message.assistant",
      agent: "main",
      data: { messageId: ulid(), text: "Travel insurance was optional, so I skipped it." },
    });
    extra.append(tidy, user("Move the old installers to the bin"));
    await feed.backfill();
    expect(feed.complete).toBe(true);
    expect(index.search({ query: "insurance" }).map((r) => r.sessionId)).toEqual([car, trip]);
    expect(index.search({ query: "policy" }).map((r) => r.kind)).toEqual(["file"]);
  });

  it("keeps a planted key out of the index file", async () => {
    const { home, log, index, feed } = setup();
    const id = log.createSession("Keys");
    const planted = `sk-ant-api03-${"z".repeat(95)}`;
    log.append(id, user(`my key is ${planted}`));
    await feed.backfill();
    expect(index.search({ query: "key" })).toHaveLength(1);
    const raw = new DatabaseSync(join(home, "index.sqlite"));
    cleanup.push(() => raw.close());
    expect(raw.prepare("SELECT count(*) AS n FROM docs WHERE text LIKE '%sk-ant%'").get()).toEqual({
      n: 0,
    });
    for (const suffix of ["", "-wal", "-journal"]) {
      const file = join(home, `index.sqlite${suffix}`);
      if (existsSync(file)) expect(readFileSync(file).includes(Buffer.from(planted))).toBe(false);
    }
  });

  it("indexes live events as they are appended and catches up after a gap", () => {
    const { home, log, index, feed } = setup();
    cleanup.push(feed.start());
    // Events written by another EventLog never reach this feed's listener: a gap.
    const other = new EventLog(home);
    cleanup.push(() => other.close());
    const id = other.createSession("Live task");
    other.append(id, user("written elsewhere: quarterly invoices"));
    log.append(id, user("then: send the quarterly report"));
    expect(index.search({ query: "invoices" }).map((r) => r.sessionId)).toEqual([id]);
    expect(index.search({ query: "report" }).map((r) => r.sessionId)).toEqual([id]);
    log.append(id, user("and the quarterly forecast"));
    expect(index.search({ query: "forecast" }).map((r) => r.sessionId)).toEqual([id]);
  });

  it("never indexes tool output, thoughts, file patches, typed text or lookups", async () => {
    const { log, index, feed } = setup();
    const id = log.createSession("Quiet");
    const step = ulid();
    log.append(id, {
      type: "tool.output",
      agent: "main",
      step,
      data: { stream: "stdout", chunk: "zebraoutput" },
    });
    log.append(id, { type: "thought.delta", agent: "main", data: { text: "zebrathought" } });
    log.append(id, {
      type: "file.change",
      agent: "main",
      data: { path: "a.txt", op: "modify", patch: "+zebrapatch" },
    });
    log.append(id, {
      type: "action.intent",
      agent: "main",
      step,
      data: { verb: "type", label: "Type zebratyped", risk: "none" },
    });
    log.append(id, {
      type: "tool.start",
      agent: "main",
      step,
      data: { tool: "recall", title: "Search earlier tasks: zebrarecall" },
    });
    log.append(id, {
      type: "tool.start",
      agent: "main",
      step: ulid(),
      data: { tool: "people", title: "Look up zebrapeople" },
    });
    await feed.backfill();
    for (const word of [
      "zebraoutput",
      "zebrathought",
      "zebrapatch",
      "zebratyped",
      "zebrarecall",
      "zebrapeople",
    ])
      expect(index.search({ query: word })).toEqual([]);
  });

  it("drops a deleted task's text from the index file but keeps its daily notes", async () => {
    const { home, log, index, memory, feed } = setup();
    const id = log.createSession("Insurance call");
    log.append(id, user("call the insurer about the quokka"));
    log.append(id, {
      type: "task.result",
      agent: "main",
      data: {
        summary: "Called them.",
        files: [{ name: "wallaby-claim.pdf", path: "x", bytes: 10 }],
      },
    });
    memory.appendNote(id, "Insurer reference is WINDSCREEN-42");
    await feed.backfill();
    expect(index.search({ query: "quokka" })).toHaveLength(1);
    expect(index.search({ query: "wallaby" })).toHaveLength(1);
    log.forget(id);
    // The sentence, the FTS token and the row keys (which name result files) are gone at once,
    // with no restart or merge.
    const file = readFileSync(join(home, "index.sqlite"));
    expect(file.includes(Buffer.from("quokka"))).toBe(false);
    expect(file.includes(Buffer.from("wallaby"))).toBe(false);
    expect(index.search({ query: "quokka" })).toEqual([]);
    expect(index.search({ query: "windscreen" })).toEqual([
      expect.objectContaining({ kind: "note", sessionId: null, title: null }),
    ]);
  });

  it("reindexes a notes file when memory changes", () => {
    const { log, index, memory, feed } = setup();
    const id = log.createSession("Notes");
    cleanup.push(feed.start());
    const change = memory.appendNote(id, "Gate code is 4471");
    log.append(id, {
      type: "memory.change",
      agent: "main",
      data: { file: change.file, patch: change.patch, changeId: change.changeId },
    });
    expect(index.search({ query: "4471" })).toHaveLength(1);
    const undo = memory.undo(change.changeId);
    log.append(id, {
      type: "memory.change",
      agent: "main",
      data: {
        file: undo.file,
        patch: undo.patch,
        changeId: undo.changeId,
        undoes: change.changeId,
      },
    });
    expect(index.search({ query: "4471" })).toEqual([]);
  });
});
