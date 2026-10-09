import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../event-log.ts";
import { type SearchDoc, SearchIndex } from "./search-index.ts";

const opened: { log: EventLog; index: SearchIndex; home: string }[] = [];
afterEach(() => {
  for (const o of opened.splice(0)) {
    for (const close of [() => o.index.close(), () => o.log.close()])
      try {
        close();
      } catch {
        // already closed by the test
      }
    rmSync(o.home, { recursive: true, force: true });
  }
});
function setup(forceLike = false) {
  const home = mkdtempSync(join(tmpdir(), "localdot-search-"));
  const log = new EventLog(home);
  const index = new SearchIndex(home, { sessions: log, forceLike });
  opened.push({ log, index, home });
  return { home, log, index };
}
const doc = (sessionId: string, kind: SearchDoc["kind"], ref: string, text: string): SearchDoc => ({
  kind,
  sessionId,
  ref,
  text,
  at: "2026-09-03T09:00:00.000Z",
});
function threeTasks(log: EventLog, index: SearchIndex) {
  const car = log.createSession("Renew the car insurance");
  const trip = log.createSession("Plan the Lisbon trip");
  const tidy = log.createSession("Tidy the downloads folder");
  index.add([
    doc(car, "title", "title", "Renew the car insurance"),
    doc(car, "summary", "r", "Renewed the car insurance with the cheaper quote."),
    doc(trip, "title", "title", "Plan the Lisbon trip"),
    doc(trip, "step", "s", "Compare travel insurance add-ons"),
    doc(tidy, "title", "title", "Tidy the downloads folder"),
  ]);
  return { car, trip, tidy };
}

describe.each([false, true])("search index (forceLike=%s)", (forceLike) => {
  it("ranks title and summary matches above passing mentions and groups per task", () => {
    const { log, index } = setup(forceLike);
    const { car, trip } = threeTasks(log, index);
    const rows = index.search({ query: "insurance" });
    expect(rows.map((r) => r.sessionId)).toEqual(
      forceLike ? expect.arrayContaining([car, trip]) : [car, trip],
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.sessionId === car)).toMatchObject({
      title: "Renew the car insurance",
    });
    expect(rows[0]?.snippet).toMatch(/\uE000insurance\uE001/i);
  });
  it("excludes a task and filters by kind", () => {
    const { log, index } = setup(forceLike);
    const { car, trip } = threeTasks(log, index);
    expect(
      index.search({ query: "insurance", excludeSessionId: car }).map((r) => r.sessionId),
    ).toEqual([trip]);
    expect(index.search({ query: "insurance", kind: "step" }).map((r) => r.sessionId)).toEqual([
      trip,
    ]);
  });
  it("answers punctuation, operators, CJK and long queries without throwing", () => {
    const { log, index } = setup(forceLike);
    const id = log.createSession("续保汽车保险");
    index.add([doc(id, "title", "title", "续保汽车保险")]);
    for (const query of ['"', "*", "NEAR(", "- :", "🙂", "a".repeat(200), 'insurance" OR "x'])
      expect(() => index.search({ query })).not.toThrow();
    expect(index.search({ query: "保险" }).map((r) => r.sessionId)).toEqual([id]);
  });
  it("keeps key-shaped text out of the database file", () => {
    const { home, log, index } = setup(forceLike);
    const id = log.createSession("Keys");
    const planted = `sk-ant-api03-${"q".repeat(95)}`;
    index.add([doc(id, "user", "m", `here is ${planted} for later`)]);
    expect(JSON.stringify(index.search({ query: "later" }))).not.toContain(planted);
    for (const suffix of ["", "-wal", "-journal"]) {
      const file = join(home, `index.sqlite${suffix}`);
      if (existsSync(file)) expect(readFileSync(file).includes(Buffer.from(planted))).toBe(false);
    }
  });
  it("drops hits for deleted tasks but keeps their daily notes, and prunes orphans", () => {
    const { log, index } = setup(forceLike);
    const id = log.createSession("Gone");
    index.add([doc(id, "title", "title", "Gone insurance task")]);
    index.replaceNotes("notes/2026-09-03.md", [
      {
        kind: "note",
        sessionId: id,
        at: "2026-09-03",
        ref: "notes/2026-09-03.md#a",
        text: "insurance note",
      },
    ]);
    log.forget(id);
    const rows = index.search({ query: "insurance" });
    expect(rows).toEqual([expect.objectContaining({ kind: "note", sessionId: null, title: null })]);
    index.pruneOrphans();
    expect(index.progressOf(id)).toBe(0);
  });
  it("ignores duplicate rows and tracks progress", () => {
    const { log, index } = setup(forceLike);
    const id = log.createSession("Dup");
    expect(
      index.add(
        [doc(id, "step", "plan:a", "Book flights"), doc(id, "step", "plan:a", "Book flights")],
        { sessionId: id, seq: 7 },
      ),
    ).toBe(1);
    expect(index.progressOf(id)).toBe(7);
  });
});
