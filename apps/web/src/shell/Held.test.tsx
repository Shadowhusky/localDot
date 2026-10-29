// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Held } from "./Held.tsx";

afterEach(cleanup);

let renders = 0;
function Panel({ label }: { label: string }) {
  renders++;
  return <p>{label}</p>;
}

it("skips the page's renders while hidden, after one that hides it, and catches up when shown", () => {
  renders = 0;
  const page = (label: string, hidden: boolean) => (
    <Held hidden={hidden}>
      <Panel label={label} />
    </Held>
  );
  const { rerender } = render(page("one", false));
  rerender(page("two", true));
  expect(screen.getByText("two")).toBeTruthy();
  rerender(page("three", true));
  rerender(page("four", true));
  expect(renders).toBe(2);
  expect(screen.getByText("two")).toBeTruthy();
  rerender(page("five", false));
  expect(renders).toBe(3);
  expect(screen.getByText("five")).toBeTruthy();
});
