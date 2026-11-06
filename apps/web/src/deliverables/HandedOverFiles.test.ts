import { describe, expect, it } from "vitest";
import { latestFiles } from "./HandedOverFiles.tsx";
import { conversationResults } from "./useConversationFiles.ts";

const file = (name: string, version: number) => ({ name, path: name, bytes: 1, version });
describe("files a task handed over", () => {
  it("lists each name once, from the latest result that handed it over", () => {
    const results = [
      { id: "a", summary: "", files: [file("totals.csv", 1), file("chart.png", 1)] },
      { id: "b", summary: "", files: [file("totals.csv", 2)] },
    ];
    expect(latestFiles(results).map((h) => [h.result.id, h.file.name, h.file.version])).toEqual([
      ["a", "chart.png", 1],
      ["b", "totals.csv", 2],
    ]);
  });

  it("keeps two tasks' files of one name apart", () => {
    const results = [
      { id: "a", sessionId: "one", summary: "", files: [file("report.pdf", 1)] },
      { id: "b", sessionId: "two", summary: "", files: [file("report.pdf", 1)] },
    ];
    expect(latestFiles(results).map((h) => h.result.id)).toEqual(["a", "b"]);
  });
});

describe("a conversation's files as results", () => {
  const row = (name: string, sessionId: string, resultId: string, available = true) => ({
    sessionId,
    resultId,
    name,
    path: name,
    bytes: 3,
    version: 1,
    tMs: 2000,
    available,
  });
  const TASK = "01JXYZ00000000000000000002";

  it("makes them results of their own tasks, oldest first, and marks what is gone", () => {
    const results = conversationResults(
      [row("new.txt", TASK, "r2"), row("old.txt", "01JXYZ00000000000000000001", "r1", false)],
      [],
      TASK,
    );
    expect(results.map((result) => [result.id, result.sessionId, result.at])).toEqual([
      ["r1", "01JXYZ00000000000000000001", 2_000_000],
      ["r2", TASK, 2_000_000],
    ]);
    expect(results[0]?.files[0]?.gone).toBe(true);
    expect(results[1]?.files[0]?.gone).toBeUndefined();
  });

  it("adds what the task handed over since they were read, under its own task", () => {
    const own = { id: "r3", summary: "", files: [file("just-now.txt", 1)] };
    const results = conversationResults([row("new.txt", TASK, "r2")], [own], TASK);
    expect(results.map((result) => [result.id, result.sessionId])).toEqual([
      ["r2", TASK],
      ["r3", TASK],
    ]);
  });
});
