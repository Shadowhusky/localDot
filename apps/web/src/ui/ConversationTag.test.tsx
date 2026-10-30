// @vitest-environment jsdom
import type { ConversationTag } from "@localdot/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, expect, it } from "vitest";
import { TagMark, TagSwatches } from "./ConversationTag.tsx";
import { Menu, MenuItem, MenuSeparator } from "./Menu.tsx";

afterEach(cleanup);

function Harness() {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState<ConversationTag | null>("green");
  return (
    <>
      <button ref={trigger} type="button" onClick={() => setOpen(true)}>
        Actions
      </button>
      <p>Tag {tag ?? "none"}</p>
      <TagMark tag={tag ?? undefined} />
      <Menu open={open} onClose={() => setOpen(false)} anchor={trigger} label="Actions">
        <MenuItem onSelect={() => {}}>Rename</MenuItem>
        <MenuSeparator />
        <TagSwatches value={tag} onSelect={setTag} />
        <MenuSeparator />
        <MenuItem onSelect={() => {}}>Delete</MenuItem>
      </Menu>
    </>
  );
}

const name = () => document.activeElement?.getAttribute("data-label");
const key = (key: string) => fireEvent.keyDown(document.activeElement as Element, { key });

it("lists no tag and the six colours as one row, the chosen one checked", () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Actions" }));
  const row = screen.getByRole("group", { name: "Tag" });
  const swatches = [...row.querySelectorAll("[role=menuitemradio]")];
  expect(swatches.map((each) => each.getAttribute("aria-label"))).toEqual([
    "No tag",
    "Red",
    "Orange",
    "Yellow",
    "Green",
    "Blue",
    "Purple",
  ]);
  expect(screen.getByRole("menuitemradio", { name: "Green" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  expect(document.querySelector(".ui-tag-mark")?.getAttribute("data-tag")).toBe("green");
});

it("moves along the row with left and right, and leaves it with up and down", () => {
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "Actions" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
  fireEvent.click(trigger);
  // Opened from the keyboard it lands on the first action, not the chosen swatch.
  expect(name()).toBe("Rename");
  key("ArrowDown");
  expect(name()).toBe("No tag");
  key("ArrowRight");
  key("ArrowRight");
  expect(name()).toBe("Orange");
  key("ArrowLeft");
  expect(name()).toBe("Red");
  key("ArrowDown");
  expect(name()).toBe("Delete");
  // Up from below comes into the row at its end, as down from above comes in at its start.
  key("ArrowUp");
  expect(name()).toBe("Purple");
  key("ArrowUp");
  expect(name()).toBe("Rename");
  key("ArrowDown");
  key("ArrowLeft");
  expect(name()).toBe("Purple");
  fireEvent.click(document.activeElement as Element);
  expect(screen.getByText("Tag purple")).toBeTruthy();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("menuitemradio", { name: "No tag" }));
  expect(screen.getByText("Tag none")).toBeTruthy();
  expect(document.querySelector(".ui-tag-mark")).toBeNull();
});
