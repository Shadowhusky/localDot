// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary.tsx";

let broken = true;
function Part({ when = "render" }: { when?: "render" | "effect" }) {
  const [drawn] = useState(() => Date.now());
  if (when === "render" && broken) throw new Error("part failed");
  useEffect(() => {
    if (when === "effect" && broken) throw new Error("part failed later");
  }, [when]);
  return <p data-drawn={drawn}>The part</p>;
}

beforeEach(() => {
  broken = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("shows a calm card in place of a part that fails, and leaves the rest of the page alone", () => {
  render(
    <main>
      <ErrorBoundary>
        <Part />
      </ErrorBoundary>
      <button type="button">Elsewhere</button>
    </main>,
  );
  expect(screen.getByRole("status").textContent).toBe("Something went wrong hereReload this part");
  expect(screen.getByRole("button", { name: "Elsewhere" })).toBeTruthy();
  expect(console.error).toHaveBeenCalled();
});

it("catches a part failing after it is drawn", () => {
  render(
    <ErrorBoundary>
      <Part when="effect" />
    </ErrorBoundary>,
  );
  expect(screen.getByText("Something went wrong here")).toBeTruthy();
  expect(screen.queryByText("The part")).toBeNull();
});

it("draws the part afresh when asked to reload it", () => {
  render(
    <ErrorBoundary>
      <Part />
    </ErrorBoundary>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Reload this part" }));
  expect(screen.getByText("Something went wrong here")).toBeTruthy();
  broken = false;
  fireEvent.click(screen.getByRole("button", { name: "Reload this part" }));
  expect(screen.getByText("The part")).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
});

it("floats over the page for a part that has no place of its own", () => {
  render(
    <ErrorBoundary floating>
      <Part />
    </ErrorBoundary>,
  );
  expect(document.querySelector(".ui-part-failed")?.hasAttribute("data-floating")).toBe(true);
});
