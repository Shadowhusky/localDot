// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { exportRequest, openReplay } from "./replay-link.ts";

const ID = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
describe("replay links", () => {
  it("puts the task, the moment and the export request in the address and tells the shell", () => {
    const heard = vi.fn();
    window.addEventListener("popstate", heard);
    openReplay(ID, { tMs: 61_234.6, exportRange: { fromMs: 1000, toMs: 61_234.6 } });
    const params = new URLSearchParams(window.location.search);
    expect([params.get("replay"), params.get("t"), params.get("export")]).toEqual([
      ID,
      "61235",
      "1000-61235",
    ]);
    expect(window.history.state).toEqual({ fromWatch: true });
    openReplay(ID);
    expect(new URLSearchParams(window.location.search).has("export")).toBe(false);
    expect(heard).toHaveBeenCalledTimes(2);
    window.removeEventListener("popstate", heard);
  });
  it("reads an export request only when it is a range", () => {
    expect(exportRequest("?export=1000-5000")).toEqual({ fromMs: 1000, toMs: 5000 });
    expect(exportRequest("?export=5000-1000")).toBeNull();
    expect(exportRequest("?export=1")).toBeNull();
    expect(exportRequest("")).toBeNull();
  });
});
