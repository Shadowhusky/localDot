// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PlanStrip } from "./PlanStrip.tsx";

afterEach(cleanup);

const plan = [
  { id: "a", text: "Open the sheet", status: "done" },
  { id: "b", text: "Check the totals", status: "doing" },
  { id: "c", text: "Write the report", status: "todo" },
];

it("opens into the whole list on one card and closes on a press outside or Escape", () => {
  const { container } = render(
    <div>
      <PlanStrip plan={plan} />
      <p>Steps</p>
    </div>,
  );
  const strip = screen.getByRole("button", { name: /^Plan/ });
  fireEvent.click(strip);
  expect(strip.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelectorAll(".plan-strip-text")).toHaveLength(0);
  fireEvent.pointerDown(screen.getByText("Steps"));
  expect(strip.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(strip);
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(strip.getAttribute("aria-expanded")).toBe("false");
});
