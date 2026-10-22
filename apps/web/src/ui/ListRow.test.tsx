// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./Button.tsx";
import { FileRow, PlayRow } from "./Card.tsx";
import { ListRow } from "./ListRow.tsx";

afterEach(cleanup);

describe("ListRow", () => {
  it("chooses the row from its title and keeps the actions as buttons of their own", () => {
    const onSelect = vi.fn();
    const onContinue = vi.fn();
    render(
      <ListRow
        title="Check the monthly report"
        meta="Finished · 9 steps"
        trailing="1:42"
        selected
        onSelect={onSelect}
        actions={<Button onClick={onContinue}>Continue</Button>}
      />,
    );
    const select = screen.getByRole("button", { name: "Check the monthly report" });
    expect(select.getAttribute("aria-pressed")).toBe("true");
    const action = screen.getByRole("button", { name: "Continue" });
    expect(select.contains(action)).toBe(false);
    fireEvent.click(action);
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(select);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("keeps the actions cell in the grid when there are none to show", () => {
    const { container } = render(<ListRow title="Tidy my Downloads" />);
    const row = container.querySelector(".ui-list-row");
    expect(row?.hasAttribute("data-thumbnail")).toBe(false);
    expect(row?.querySelector(".ui-list-row-actions")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("FileRow", () => {
  it("names the file's type on its tile", () => {
    const { container, rerender } = render(<FileRow name="monthly-report.ods" meta="2 KB" />);
    expect(container.querySelector(".ui-file-tile")?.textContent).toBe("ODS");
    rerender(<FileRow name="README" />);
    expect(container.querySelector(".ui-file-tile")?.textContent).toBe("");
  });

  it("lays the file's own picture over its tile, and marks a compact row", () => {
    const { container } = render(
      <FileRow name="chart.png" meta="2 KB" compact thumbnail={<img src="blob:chart" alt="" />} />,
    );
    const tile = container.querySelector(".ui-file-tile");
    expect(tile?.textContent).toBe("PNG");
    expect(tile?.querySelector("img")?.getAttribute("src")).toBe("blob:chart");
    expect(tile?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".ui-file-row")?.hasAttribute("data-compact")).toBe(true);
  });
});

describe("PlayRow", () => {
  it("plays from one press, described by its line, with its actions apart", () => {
    const onPlay = vi.fn();
    const onMore = vi.fn();
    render(
      <PlayRow
        label="Watch replay (1:42)"
        title="Replay · 1:42"
        detail="Checked: opens, 4 sheets"
        onPlay={onPlay}
        actions={<Button onClick={onMore}>More</Button>}
      />,
    );
    const play = screen.getByRole("button", { name: "Watch replay (1:42)" });
    expect(play.textContent).toContain("Replay · 1:42");
    expect(document.getElementById(play.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Checked: opens, 4 sheets",
    );
    const more = screen.getByRole("button", { name: "More" });
    expect(play.contains(more)).toBe(false);
    fireEvent.click(more);
    expect(onPlay).not.toHaveBeenCalled();
    fireEvent.click(play);
    expect(onPlay).toHaveBeenCalledOnce();
  });
});
