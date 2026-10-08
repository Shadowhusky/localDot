// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "./Button.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { Skeleton } from "./Skeleton.tsx";

afterEach(cleanup);

function Row({ name }: { name?: string }) {
  return (
    <Skeleton loading={!name} width="18ch">
      <span>{name}</span>
    </Skeleton>
  );
}

describe("Skeleton", () => {
  it("holds hidden bones while loading and is marked busy", () => {
    const { container } = render(<Skeleton loading lines={3} />);
    const skeleton = container.querySelector(".ui-skeleton") as HTMLElement;
    expect(skeleton.getAttribute("aria-busy")).toBe("true");
    expect(skeleton.querySelectorAll(".ui-skeleton-bone")).toHaveLength(3);
    expect(skeleton.querySelector(".ui-skeleton-bones")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("puts the content in the same box when it arrives, and marks it as arrived", () => {
    const { container, rerender } = render(<Row />);
    const skeleton = container.querySelector(".ui-skeleton");
    rerender(<Row name="monthly-report.ods" />);
    expect(container.querySelector(".ui-skeleton")).toBe(skeleton);
    expect(skeleton?.hasAttribute("aria-busy")).toBe(false);
    expect(screen.getByText("monthly-report.ods").closest("[data-arrived]")).not.toBeNull();
    // Nothing moves in jsdom, so the bones are gone at once.
    expect(skeleton?.querySelector(".ui-skeleton-bones")).toBeNull();
  });

  it("shows content that was there from the start without fading it in", () => {
    render(<Row name="summary.txt" />);
    expect(screen.getByText("summary.txt").closest("[data-arrived]")).toBeNull();
    expect(document.querySelector(".ui-skeleton-bones")).toBeNull();
  });

  it("keeps showing the content it had while it loads again, marked busy, until new content comes", () => {
    const { container, rerender } = render(<Row name="summary.txt" />);
    const skeleton = container.querySelector(".ui-skeleton");
    // Loading again, the caller has nothing to show yet: the last content stays.
    rerender(<Row />);
    expect(skeleton?.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("summary.txt").closest("[data-stale]")).not.toBeNull();
    expect(skeleton?.querySelectorAll(".ui-skeleton-bone")).toHaveLength(1);
    rerender(<Row name="monthly-report.ods" />);
    expect(screen.queryByText("summary.txt")).toBeNull();
    expect(screen.getByText("monthly-report.ods").closest("[data-stale]")).toBeNull();
    expect(skeleton?.hasAttribute("aria-busy")).toBe(false);
  });

  it("sizes itself from its props", () => {
    const { container } = render(<Skeleton loading shape="block" width="32px" height="32px" />);
    const skeleton = container.querySelector(".ui-skeleton") as HTMLElement;
    expect(skeleton.dataset.shape).toBe("block");
    expect(skeleton.style.getPropertyValue("--_width")).toBe("32px");
    expect(skeleton.style.getPropertyValue("--_height")).toBe("32px");
  });
});

describe("EmptyState", () => {
  it("says what will appear and offers the way to make it appear", () => {
    render(
      <EmptyState
        icon="play"
        title="No recordings yet"
        actions={<Button size="sm">Start a task</Button>}
      >
        Each task you run is recorded here.
      </EmptyState>,
    );
    expect(screen.getByText("No recordings yet")).toBeTruthy();
    expect(screen.getByText("Each task you run is recorded here.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start a task" })).toBeTruthy();
    expect(document.querySelector(".ui-empty-art")?.getAttribute("aria-hidden")).toBe("true");
  });
});
