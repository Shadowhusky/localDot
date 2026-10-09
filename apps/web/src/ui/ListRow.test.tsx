// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./Button.tsx";
import { FileRow } from "./Card.tsx";
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
});
