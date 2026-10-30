// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Action } from "./actions.ts";
import { CommandPalette, type PalettePage, usePaletteKeys } from "./CommandPalette.tsx";
import { paletteKey } from "./shortcuts.ts";

const toasts = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("../ui/Toast.tsx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/Toast.tsx")>()),
  showToast: toasts.showToast,
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
  toasts.showToast.mockClear();
});

const action = (over: Partial<Action> & Pick<Action, "id" | "title">): Action => ({
  description: `About ${over.title}`,
  group: "Go to",
  run: vi.fn(),
  ...over,
});

function Harness({ actions, suggested }: { actions: Action[]; suggested: string[] }) {
  const [page, setPage] = useState<PalettePage | null>(null);
  usePaletteKeys(
    (asked) => setPage((open) => (open === asked && asked === "actions" ? null : asked)),
    true,
  );
  return (
    <>
      <button type="button">Opener</button>
      <CommandPalette
        open={page !== null}
        page={page ?? "actions"}
        actions={actions}
        suggested={suggested}
        onClose={() => setPage(null)}
      />
    </>
  );
}

function setup(actions: Action[], suggested: string[] = []) {
  render(<Harness actions={actions} suggested={suggested} />);
  const opener = screen.getByRole("button", { name: "Opener" });
  opener.focus();
  const open = () => fireEvent.keyDown(opener, { key: "k", ctrlKey: true });
  const field = () => screen.getByRole("combobox");
  const type = (text: string) => fireEvent.change(field(), { target: { value: text } });
  const key = (name: string) => fireEvent.keyDown(field(), { key: name });
  const options = () => screen.queryAllByRole("option").map((row) => row.textContent);
  return { opener, open, field, type, key, options };
}

describe("the action palette", () => {
  it("opens on Mod+K over the page, offers recent and suggested actions, and runs one found by search", async () => {
    localStorage.setItem("localdot.recent-actions.v1", JSON.stringify(["settings", "gone"]));
    const settings = action({
      id: "settings",
      title: "Open Settings",
      group: "Settings",
      keys: ["Mod", ","],
    });
    const replay = action({
      id: "replay",
      title: "Open Replay",
      command: "replay",
      group: "Conversation",
    });
    const resume = action({
      id: "resume",
      title: "Switch conversation",
      command: "resume",
      group: "Conversation",
      searchable: true,
      choices: async () => [
        { value: "a", label: "Trip to Lisbon", detail: "Done · 2 h" },
        { value: "b", label: "Quarterly taxes" },
      ],
    });
    const f = setup([settings, replay, resume], ["replay", "settings"]);
    f.open();
    const dialog = await screen.findByRole("dialog", { name: "Search actions" });
    expect(document.activeElement).toBe(f.field());
    expect(f.field().getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
    expect(
      screen.getAllByRole("group").map((group) => group.getAttribute("aria-labelledby")),
    ).toHaveLength(2);
    expect(screen.getByRole("group", { name: "Recent" }).textContent).toContain("Open Settings");
    expect(screen.getByRole("group", { name: "Suggested" }).textContent).toContain("Open Replay");
    expect(dialog.querySelector(".ui-kbd")).toBeTruthy();
    f.type("lisbon");
    await waitFor(() =>
      expect(f.options()).toEqual(["Trip to LisbonSwitch conversation · Done · 2 h"]),
    );
    f.type("rep");
    expect(f.options()[0]).toBe("Open Replay/replayAbout Open Replay");
    f.key("Enter");
    expect(replay.run).toHaveBeenCalledWith({ text: "", trigger: f.opener });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(f.opener);
    expect(JSON.parse(localStorage.getItem("localdot.recent-actions.v1") ?? "[]")[0]).toBe(
      "replay",
    );
  });

  it("opens an action's own page for its choices or words, and goes back with Backspace or Escape", async () => {
    const dot = action({
      id: "dot",
      title: "Switch dot",
      choices: [
        { value: "coder", label: "Coder", detail: "Builds software" },
        { value: "everyday", label: "Everyday", current: true },
      ],
    });
    const btw = action({
      id: "btw",
      title: "Ask a side question",
      input: "required",
      placeholder: "Ask about this task…",
    });
    const f = setup([dot, btw]);
    f.open();
    f.type("switch dot");
    f.key("Enter");
    expect(screen.getByRole("dialog", { name: "Switch dot" })).toBeTruthy();
    expect(f.options()).toEqual(["CoderBuilds software", "Everyday"]);
    f.key("Backspace");
    expect(screen.getByRole("dialog", { name: "Search actions" })).toBeTruthy();
    f.type("side");
    f.key("Enter");
    expect(f.field().getAttribute("placeholder")).toBe("Ask about this task…");
    f.type("Is it done?");
    expect(f.options()).toEqual(["Ask a side question“Is it done?”"]);
    f.key("Enter");
    expect(btw.run).toHaveBeenCalledWith(expect.objectContaining({ text: "Is it done?" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    f.open();
    f.type("dot");
    f.key("Enter");
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Search actions" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says why an action can't run, and shows what a failed one said", async () => {
    const stop = action({ id: "stop", title: "Stop the task", unavailable: "Nothing is running" });
    const rename = action({
      id: "rename",
      title: "Rename this conversation",
      run: vi.fn(async () => "Couldn't rename the conversation. Try again."),
    });
    const f = setup([stop, rename]);
    f.open();
    f.type("stop");
    f.key("Enter");
    expect(screen.getByRole("alert").textContent).toBe("Nothing is running");
    expect(stop.run).not.toHaveBeenCalled();
    f.type("rename");
    f.key("Enter");
    await waitFor(() =>
      expect(toasts.showToast).toHaveBeenCalledWith({
        title: "Couldn't rename the conversation. Try again.",
        tone: "danger",
      }),
    );
  });

  it('lists the keyboard shortcuts on "?" outside a field, searchable', async () => {
    setup([]);
    act(() => {
      document.body.focus();
    });
    fireEvent.keyDown(document.body, { key: "?" });
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Replay" }).textContent).toContain("Play or pause");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "stop" } });
    expect(screen.getAllByRole("region").map((group) => group.getAttribute("aria-label"))).toEqual([
      "Anywhere",
    ]);
  });
});

describe("paletteKey", () => {
  const press = (over: Partial<KeyboardEvent> & { key: string }, target: Element = document.body) =>
    ({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      repeat: false,
      target,
      ...over,
    }) as KeyboardEvent;
  it("takes Command+K on a Mac and Control+K elsewhere, from any field but the computer's", () => {
    const field = document.createElement("textarea");
    expect(paletteKey(press({ key: "k", metaKey: true }, field), true)).toBe("open");
    expect(paletteKey(press({ key: "K", ctrlKey: true }), false)).toBe("open");
    expect(paletteKey(press({ key: "k", ctrlKey: true }), true)).toBeNull();
    expect(paletteKey(press({ key: "k", metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(paletteKey(press({ key: "k", metaKey: true, isComposing: true }), true)).toBeNull();
    const surface = document.createElement("div");
    surface.className = "manual-surface";
    const inside = surface.appendChild(document.createElement("textarea"));
    expect(paletteKey(press({ key: "k", metaKey: true }, inside), true)).toBeNull();
    expect(paletteKey(press({ key: "?", shiftKey: true }), true)).toBe("shortcuts");
    expect(paletteKey(press({ key: "?", shiftKey: true }, field), true)).toBeNull();
  });
});
