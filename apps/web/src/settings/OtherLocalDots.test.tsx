// @vitest-environment jsdom
import type { LocalDotLink } from "@localdot/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { OtherLocalDots } from "./OtherLocalDots.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const OFFICE = { name: "Office PC", url: "https://office.example.ts.net:4750" };
const LAPTOP = { name: "Laptop", url: "https://laptop.example.ts.net:4750" };
const RELAY = `https://${"a1".repeat(16)}--dot.localdot.dev`;
const PAIR = `${RELAY}/_remote/pair#remote=${"b".repeat(64)}&code=${"c".repeat(43)}`;

function fixture(initial: LocalDotLink[] = [OFFICE, LAPTOP]) {
  const changes: LocalDotLink[][] = [];
  function Harness() {
    const [links, setLinks] = useState(initial);
    return (
      <OtherLocalDots
        links={links}
        onChange={(next) => {
          changes.push(next);
          setLinks(next);
        }}
      />
    );
  }
  render(<Harness />);
  return changes;
}
const field = (name: "Name" | "Address") =>
  screen.getByRole("textbox", { name }) as HTMLInputElement;
const type = (name: "Name" | "Address", value: string) =>
  fireEvent.change(field(name), { target: { value } });

it("edits an entry in place, its name and address filled in, and keeps the list's order", () => {
  const changes = fixture();
  fireEvent.click(screen.getByRole("button", { name: "Edit Office PC" }));
  expect(field("Name").value).toBe("Office PC");
  expect(field("Address").value).toBe("https://office.example.ts.net:4750");
  expect(screen.getByText("Changing the address means signing in again there.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  type("Name", "Studio");
  type("Address", "studio.example.ts.net:4750");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(changes).toEqual([
    [{ name: "Studio", url: "https://studio.example.ts.net:4750" }, LAPTOP],
  ]);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit Studio" }));
  expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
});

it("leaves the edited entry out of its own duplicate check, but not the others", () => {
  const changes = fixture();
  fireEvent.click(screen.getByRole("button", { name: "Edit Office PC" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(changes).toEqual([[OFFICE, LAPTOP]]);
  fireEvent.click(screen.getByRole("button", { name: "Edit Office PC" }));
  type("Address", LAPTOP.url);
  fireEvent.keyDown(field("Address"), { key: "Enter" });
  expect(screen.getByText("That localDot is already in the list.")).toBeTruthy();
  expect(changes).toHaveLength(1);
});

it("cancels with Cancel or Escape, and Escape goes no further than the edit", () => {
  const changes = fixture();
  fireEvent.click(screen.getByRole("button", { name: "Edit Laptop" }));
  type("Name", "Something else");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByText("Laptop")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit Laptop" }));
  type("Name", "Something else");
  expect(fireEvent.keyDown(field("Name"), { key: "Escape" })).toBe(false);
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(changes).toEqual([]);
});

it("refuses a name the settings can't keep", () => {
  const changes = fixture();
  fireEvent.click(screen.getByRole("button", { name: "Edit Office PC" }));
  type("Name", "<Office>");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByText("Use up to 40 letters, numbers and punctuation.")).toBeTruthy();
  expect(changes).toEqual([]);
});

it("saves a pasted sign-in link's address only, and opens the link once to sign in there", () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const changes = fixture([OFFICE]);
  type("Address", PAIR);
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(changes).toEqual([[OFFICE, { name: "Remote localDot", url: RELAY }]]);
  expect(open).toHaveBeenCalledExactlyOnceWith(PAIR, "_blank", "noopener");
  expect(field("Address").value).toBe("");
});

it("only signs in again with a fresh link for a localDot already listed", () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const changes = fixture([{ name: "Home Mac", url: RELAY }]);
  type("Address", PAIR);
  fireEvent.keyDown(field("Address"), { key: "Enter" });
  expect(open).toHaveBeenCalledExactlyOnceWith(PAIR, "_blank", "noopener");
  expect(changes).toEqual([]);
  type("Address", "laptop.example.ts.net:4750");
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(open).toHaveBeenCalledOnce();
});

it("keeps or forgets a localDot only this browser has come from, and forgets what leaves the list", () => {
  const changes: LocalDotLink[][] = [];
  const forgotten: string[] = [];
  const STUDIO = "https://studio.example.ts.net:4744";
  function Harness() {
    const [links, setLinks] = useState<LocalDotLink[]>([OFFICE]);
    // Until the list here is saved, the one this browser has still has the studio.
    const known = [
      { ...OFFICE, persona: "coder" as const, browserOnly: false },
      { name: "Studio Mac", url: STUDIO, accessory: "cap" as const, browserOnly: true },
    ];
    return (
      <OtherLocalDots
        links={links}
        known={known}
        onChange={(next) => {
          changes.push(next);
          setLinks(next);
        }}
        onForget={(url) => forgotten.push(url)}
      />
    );
  }
  render(<Harness />);
  expect(screen.getByText("studio.example.ts.net:4744 · Only in this browser")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Forget Studio Mac" }));
  expect(forgotten).toEqual([STUDIO]);
  fireEvent.click(screen.getByRole("button", { name: "Keep Studio Mac in the list" }));
  expect(changes.at(-1)).toEqual([OFFICE, { name: "Studio Mac", url: STUDIO }]);
  expect(screen.queryByText(/Only in this browser/)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Edit Office PC" }));
  type("Address", "office2.example.ts.net:4750");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove Studio Mac" }));
  expect(forgotten).toEqual([STUDIO, OFFICE.url, STUDIO]);
});

it("keeps no more than the list can hold", () => {
  const full = Array.from({ length: 12 }, (_, i) => ({
    name: `Dot ${i}`,
    url: `https://dot${i}.example`,
  }));
  render(
    <OtherLocalDots
      links={full}
      known={[{ name: "Studio Mac", url: "https://studio.example", browserOnly: true }]}
      onChange={vi.fn()}
    />,
  );
  expect(
    screen
      .getByRole("button", { name: "Keep Studio Mac in the list" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
});

it("keeps a localDot reached at a loopback address only in this browser", () => {
  const onChange = vi.fn();
  render(
    <OtherLocalDots
      links={[OFFICE]}
      known={[
        { name: "Studio Mac", url: "http://127.0.0.1:4750", browserOnly: true },
        { name: "Laptop", url: "https://laptop.tail849a6b.ts.net", browserOnly: true },
      ]}
      onChange={onChange}
    />,
  );
  const studio = screen.getByRole("button", { name: "Keep Studio Mac in the list" });
  expect(studio.getAttribute("aria-disabled")).toBe("true");
  expect(document.body.textContent).toContain("Its address works only on this device");
  fireEvent.click(studio);
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep Laptop in the list" }));
  expect(onChange).toHaveBeenCalledWith([
    OFFICE,
    { name: "Laptop", url: "https://laptop.tail849a6b.ts.net" },
  ]);
});
