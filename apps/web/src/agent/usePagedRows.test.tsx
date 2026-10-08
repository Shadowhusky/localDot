// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { HISTORY_PAGE_ROWS, usePagedRows } from "./usePagedRows.ts";

const key = (row: { id: string }) => row.id;
const rows = Array.from({ length: 10_000 }, (_, n) => ({ id: `row-${n}`, text: `Row ${n}` }));
afterEach(cleanup);
it("bounds a 10,000 row projection and lets a reader explicitly page into retained history", () => {
  const h = renderHook(() => usePagedRows(rows, key, "task-a"));
  expect(h.result.current.rows).toHaveLength(HISTORY_PAGE_ROWS);
  expect(h.result.current.rows[0]?.id).toBe("row-9900");
  act(() => h.result.current.older());
  expect(h.result.current.rows).toHaveLength(HISTORY_PAGE_ROWS);
  expect(h.result.current.rows[0]?.id).toBe("row-9800");
  expect(h.result.current.following).toBe(false);
  act(() => h.result.current.newer());
  expect(h.result.current.following).toBe(true);
  expect(h.result.current.rows[0]?.id).toBe("row-9900");
});
it("keeps a reader's page anchored through streaming additions and projection eviction", () => {
  const h = renderHook(({ data }) => usePagedRows(data, key, "task-a"), {
    initialProps: { data: rows },
  });
  act(() => h.result.current.freeze());
  const first = h.result.current.rows[0];
  h.rerender({ data: [...rows, { id: "new", text: "Streaming next message" }] });
  expect(h.result.current.rows[0]).toBe(first);
  expect(h.result.current.rows).toHaveLength(HISTORY_PAGE_ROWS);
  expect(h.result.current.hasNewer).toBe(true);
  h.rerender({ data: [{ id: "new", text: "Streaming next message" }] });
  expect(h.result.current.retained).toBe(true);
  expect(h.result.current.rows[0]).toBe(first);
  expect(h.result.current.rows).toHaveLength(HISTORY_PAGE_ROWS);
  act(() => h.result.current.latest());
  expect(h.result.current.rows.map(key)).toEqual(["new"]);
});
it("never exposes a retained page from a replaced task", () => {
  const h = renderHook(({ data, owner }) => usePagedRows(data, key, owner), {
    initialProps: { data: rows, owner: "task-a" },
  });
  act(() => h.result.current.older());
  h.rerender({ data: [{ id: "b", text: "New task" }], owner: "task-b" });
  expect(h.result.current.rows.map(key)).toEqual(["b"]);
  expect(h.result.current.retained).toBe(false);
  expect(h.result.current.following).toBe(true);
});
it("moves a larger window by half its size, so the rows in view stay mounted", () => {
  const h = renderHook(() => usePagedRows(rows, key, "task-a", { size: 200, step: 100 }));
  expect(h.result.current.rows.map(key).slice(0, 1)).toEqual(["row-9800"]);
  act(() => h.result.current.older());
  expect(h.result.current.rows[0]?.id).toBe("row-9700");
  expect(h.result.current.rows.at(-1)?.id).toBe("row-9899");
  act(() => h.result.current.newer());
  expect(h.result.current.following).toBe(true);
  expect(h.result.current.rows[0]?.id).toBe("row-9800");
});
