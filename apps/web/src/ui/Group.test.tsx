// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupRow } from "./Group.tsx";

afterEach(cleanup);

describe("GroupRow", () => {
  it("opens what sits under it in place, saying so, or opens elsewhere with a chevron right", () => {
    const toggle = vi.fn();
    const { rerender } = render(
      <GroupRow
        label="Tools"
        trailing="6 of 7 on"
        expanded={false}
        controls="tools"
        onSelect={toggle}
      />,
    );
    const row = screen.getByRole("button", { name: /Tools/ });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.getAttribute("aria-controls")).toBe("tools");
    fireEvent.click(row);
    expect(toggle).toHaveBeenCalledOnce();
    rerender(
      <GroupRow label="Tools" trailing="6 of 7 on" expanded controls="tools" onSelect={toggle} />,
    );
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(row.hasAttribute("data-expanded")).toBe(true);
    rerender(<GroupRow label="Models" onSelect={toggle} />);
    expect(screen.getByRole("button", { name: /Models/ }).hasAttribute("aria-expanded")).toBe(
      false,
    );
  });
});
