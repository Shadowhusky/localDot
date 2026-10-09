// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { showToast } from "../../ui/Toast.tsx";
import { knownFixture } from "../testing.ts";
import { factOrder, failure, MemoryEditor, undoFailure } from "./MemoryEditor.tsx";
import { MemoryRequestError } from "./memory-api.ts";
import { PeopleList, personProblem } from "./PeopleList.tsx";

vi.mock("../../ui/Toast.tsx", async (actual) => ({
  ...(await actual<typeof import("../../ui/Toast.tsx")>()),
  showToast: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.mocked(showToast).mockClear();
});
const TASK = "01JXYZ0000000000000000TASK";
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
    const link = screen.getByRole("button", { name: /From Book flights/ });
    expect(link.classList).toContain("ui-button");
    await act(async () => link.click());
    expect(onOpenTask).toHaveBeenCalledWith("01JXYZ0000000000000000TASK");
  });
  it("puts pinned facts under Always remembered", () => {
    render(
      <MemoryEditor
        known={knownFixture({
          files: {
            "USER.md": [
              fact("01JXYZ0000000000000000AAAA", "Lives in Lisbon"),
              fact("01JXYZ0000000000000000BBBB", "Allergic to penicillin", { pinned: true }),
            ],
            "MEMORY.md": [],
          },
        })}
      />,
    );
    const pinned = screen.getByRole("list", { name: "Always remembered" });
    expect(pinned.textContent).toContain("Allergic to penicillin");
    expect(pinned.textContent).not.toContain("Lisbon");
    expect(screen.getByRole("list", { name: "About you" }).textContent).toContain("Lisbon");
  });
  it("shows daily notes newest first, with Edit and Delete but no pin or add", async () => {
    const deleteFact = vi.fn(async () => "01JXYZ0000000000000000CHNG");
    const note = (id: string, text: string) =>
      fact(id, text, {
        file: "notes/2026-10-08.md",
        source: { kind: "task", sessionId: TASK, title: "Call the insurer" },
      });
    render(
      <MemoryEditor
        known={knownFixture({
          notes: [
            note("01JXYZ0000000000000000BBBB", "Quote is 412 a year"),
            note("01JXYZ0000000000000000AAAA", "Insurer reference is W-42"),
          ],
          deleteFact,
        })}
      />,
    );
    await act(async () => screen.getByRole("radio", { name: "Daily notes" }).click());
    const list = screen.getByRole("list", { name: "Daily notes" });
    expect([...list.querySelectorAll(".memory-fact")].map((n) => n.textContent)).toEqual([
      "Quote is 412 a year",
      "Insurer reference is W-42",
    ]);
    expect(screen.queryByRole("textbox", { name: "New fact" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Always remember" })).toBeNull();
    expect(screen.queryByText("Show the file")).toBeNull();
    await act(async () =>
      screen.getAllByRole("button", { name: "More for this note" })[0]?.click(),
    );
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeTruthy();
    await act(async () => screen.getByRole("menuitem", { name: "Delete" }).click());
    expect(deleteFact).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Quote is 412 a year" }),
    );
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Note deleted" }),
    );
  });
  it("says what went wrong in words that fit it", () => {
    expect(failure(new MemoryRequestError("stale"))).toMatch(/changed meanwhile/);
    expect(failure(new MemoryRequestError("busy"))).toMatch(/control of the computer/);
    expect(failure(new MemoryRequestError("full"))).toMatch(/Remove something first/);
    expect(failure(new MemoryRequestError("unreadable"))).toMatch(/couldn't read/);
    expect(undoFailure(new MemoryRequestError("busy"))).toMatch(/control of the computer/);
    expect(undoFailure(new MemoryRequestError("stale"))).toMatch(/changed since/);
    expect(undoFailure(new MemoryRequestError("missing"))).toMatch(/can't be undone any more/);
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
  it("Undo after removing someone dot learned puts back its task and day", async () => {
    const addPerson = vi.fn(async () => undefined);
    const deletePerson = vi.fn(async () => undefined);
    render(
      <PeopleList
        onOpenTask={() => {}}
        known={knownFixture({
          addPerson,
          deletePerson,
          people: [
            {
              id: "01JXYZ0000000000000000PPPP",
              name: "Henry Liu",
              app: "WeChat",
              handle: "henry_l",
              note: null,
              lastAt: "2026-10-08",
              source: { kind: "task", sessionId: TASK, title: "Send the report" },
              revision: "0123456789abcdef",
            },
          ],
        })}
      />,
    );
    expect(screen.getByRole("button", { name: /From Send the report/ }).classList).toContain(
      "ui-button",
    );
    await act(async () => screen.getByRole("button", { name: "More for Henry Liu" }).click());
    await act(async () => screen.getByRole("menuitem", { name: "Delete" }).click());
    const toast = vi.mocked(showToast).mock.calls[0]?.[0];
    expect(toast?.title).toBe("Removed Henry Liu");
    await act(async () => toast?.action?.onAction());
    expect(addPerson).toHaveBeenCalledWith({
      name: "Henry Liu",
      app: "WeChat",
      handle: "henry_l",
      lastAt: "2026-10-08",
      sessionId: TASK,
    });
  });
});
