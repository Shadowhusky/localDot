// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createApi } from "../lib/api.ts";
import { timelineRows } from "../session/key-uses.ts";
import { ActivityRail } from "../shell/ActivityRail.tsx";

const api = createApi("inert-reading", {
  origin: "https://owned.invalid",
  fetchImpl: async () => {
    throw new Error("Unexpected network request");
  },
});
const rail = (count: number) => (
  <ActivityRail
    rows={timelineRows(
      Array.from({ length: count }, (_, n) => ({
        id: `reading-${n}`,
        startT: n,
        label: `Read row ${n}`,
        status: "ok" as const,
        durationMs: 10,
      })),
      [],
    )}
    sessionId="reading-owner"
    scale={1}
    api={api}
  />
);
afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});
for (const method of ["pointer", "selection"] as const)
  it(`keeps the selected row during ${method} reading while appending newer steps`, () => {
    const v = render(rail(180));
    const row = screen.getByText("Read row 80");
    const range = document.createRange();
    range.selectNodeContents(row);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    if (method === "pointer")
      fireEvent.pointerDown(screen.getByRole("region", { name: "Recorded steps" }));
    else fireEvent(document, new Event("selectionchange"));
    v.rerender(rail(181));
    expect(screen.getByText("Read row 80")).toBe(row);
    expect(window.getSelection()?.toString()).toBe("Read row 80");
    expect(screen.getAllByTestId("step-row")).toHaveLength(101);
    expect(screen.getByText("Read row 80")).toBeTruthy();
    expect(screen.getByText("Read row 180")).toBeTruthy();
    v.rerender(rail(182));
    expect(screen.getByText("Read row 181")).toBeTruthy();
  });
it("selection outside Activity leaves the live tail following", () => {
  const v = render(
    <>
      <p>Separate text</p>
      {rail(180)}
    </>,
  );
  const range = document.createRange();
  range.selectNodeContents(screen.getByText("Separate text"));
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  v.rerender(
    <>
      <p>Separate text</p>
      {rail(181)}
    </>,
  );
  expect(screen.queryByText("Read row 80")).toBeNull();
  expect(screen.getByText("Read row 180")).toBeTruthy();
});
