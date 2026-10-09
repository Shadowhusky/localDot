// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { knownFixture } from "../testing.ts";
import { factOrder, MemoryEditor } from "./MemoryEditor.tsx";
import { PeopleList, personProblem } from "./PeopleList.tsx";

afterEach(cleanup);
const fact = (id: string, text: string, over: object = {}) => ({
  id,
  file: "USER.md" as const,
  text,
  source: { kind: "user" as const },
  at: "2026-10-01",
  pinned: false,
  revision: "0123456789abcdef",
  ...over,
});

describe("memory editor", () => {
  it("lists pinned facts first, then the newest", () => {
    const list = factOrder([
      fact("01JXYZ0000000000000000AAAA", "old", { at: "2026-01-01" }),
      fact("01JXYZ0000000000000000BBBB", "pinned", { pinned: true, at: "2025-01-01" }),
      fact("01JXYZ0000000000000000CCCC", "undated", { at: null }),
      fact("01JXYZ0000000000000000DDDD", "new", { at: "2026-10-01" }),
    ]);
    expect(list.map((f) => f.text)).toEqual(["pinned", "new", "old", "undated"]);
  });
  it("refuses a key-shaped fact without sending it", async () => {
    const addFact = vi.fn();
    render(<MemoryEditor known={knownFixture({ addFact })} />);
    fireEvent.change(screen.getByRole("textbox", { name: "New fact" }), {
      target: { value: `my key sk-ant-api03-${"a".repeat(95)}` },
    });
    await act(async () => screen.getByRole("button", { name: "Add" }).click());
    expect(addFact).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(
      "That looks like a key. Add it in Keys instead.",
    );
  });
  it("edits in place, and Escape ends the edit without reaching the sheet", async () => {
    const editFact = vi.fn(async () => "01JXYZ0000000000000000CHNG");
    render(
      <MemoryEditor
        known={knownFixture({
          files: {
            "USER.md": [fact("01JXYZ0000000000000000AAAA", "Lives in Lisbon")],
            "MEMORY.md": [],
          },
          editFact,
        })}
      />,
    );
    await act(async () => screen.getByRole("button", { name: "More for this fact" }).click());
    await act(async () => screen.getByRole("menuitem", { name: "Edit" }).click());
    const field = screen.getByRole("textbox", { name: "Fact" });
    const press = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      field.dispatchEvent(press);
    });
    expect(press.defaultPrevented).toBe(true);
    expect(screen.queryByRole("textbox", { name: "Fact" })).toBeNull();
    expect(editFact).not.toHaveBeenCalled();
  });
  it("opens the task a fact came from", async () => {
    const onOpenTask = vi.fn();
    render(
      <MemoryEditor
        onOpenTask={onOpenTask}
        known={knownFixture({
          files: {
            "USER.md": [
              fact("01JXYZ0000000000000000AAAA", "Prefers window seats", {
                source: {
                  kind: "task",
                  sessionId: "01JXYZ0000000000000000TASK",
                  title: "Book flights",
                },
              }),
            ],
            "MEMORY.md": [],
          },
        })}
      />,
    );
    await act(async () => screen.getByRole("button", { name: /From Book flights/ }).click());
    expect(onOpenTask).toHaveBeenCalledWith("01JXYZ0000000000000000TASK");
  });
});

describe("people", () => {
  it("needs a name and an app, one line each, and never a key", () => {
    const ok = { name: "Henry", app: "WeChat", handle: "henry_l", note: "" };
    expect(personProblem(ok)).toBeUndefined();
    expect(personProblem({ ...ok, app: " " })).toMatch(/name and the app/);
    expect(personProblem({ ...ok, note: "a\nb" })).toMatch(/one line/);
    expect(personProblem({ ...ok, handle: `sk-ant-api03-${"a".repeat(95)}` })).toMatch(/Keys/);
  });
  it("adds someone through the form", async () => {
    const addPerson = vi.fn(async () => undefined);
    render(<PeopleList known={knownFixture({ addPerson })} />);
    await act(async () => screen.getByRole("button", { name: "Add someone" }).click());
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Ana" } });
    fireEvent.change(screen.getByRole("textbox", { name: "App" }), { target: { value: "Email" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Handle" }), {
      target: { value: " ana@example.com " },
    });
    await act(async () => screen.getByRole("button", { name: "Add" }).click());
    expect(addPerson).toHaveBeenCalledWith({
      name: "Ana",
      app: "Email",
      handle: "ana@example.com",
    });
  });
});
