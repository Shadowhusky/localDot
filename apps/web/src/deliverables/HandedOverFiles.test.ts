import { describe, expect, it } from "vitest";
import { latestFiles } from "./HandedOverFiles.tsx";

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
});
