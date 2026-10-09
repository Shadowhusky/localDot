// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ApiClient, createApi } from "../lib/api.ts";
import { TopBar } from "../shell/TopBar.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { type KeyField, KeyForm, type KeyIntake } from "./KeyForm.tsx";
import { KeyList } from "./KeyList.tsx";
import { KeysPanel, type KeysPanelProps } from "./KeysPanel.tsx";
import type { KeyRecord } from "./keys-api.ts";
import * as keysApi from "./keys-api.ts";
import { type KeysController, keyStatus, useKeys } from "./useKeys.ts";

afterEach(cleanup);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const weather: KeyRecord = {
  id: "weather",
  kind: "http",
  hosts: ["api.weather.example"],
  header: "Authorization",
  format: "bearer",
  createdAt: "2026-10-03T09:00:00Z",
  updatedAt: "2026-10-03T09:00:00Z",
};
const anthropic: KeyRecord = {
  id: "anthropic",
  kind: "llm",
  provider: "anthropic",
  createdAt: "t",
  updatedAt: "t",
};
const HEALTHY = {
  online: true,
  bootId: "b",
  sealKey: "K",
  audit: { ok: true },
  hairpin: { state: "active" as const, source: "nat-pmp", addresses: 1 },
};
const PLAN_REFUSAL =
  "Claude Pro and Max plans can't be used here: Anthropic doesn't allow other apps to sign in with them. Add an Anthropic API key instead.";

function controller(over: Partial<KeysController> = {}): KeysController {
  return {
    health: HEALTHY,
    keys: [],
    loadError: null,
    busy: false,
    save: vi.fn(async () => ({ restart: false })),
    remove: vi.fn(async () => {}),
    ...over,
  };
}

type KeysSheetProps = Omit<KeysPanelProps, "active" | "onHolding"> & {
  open: boolean;
  onClose(): void;
};

// Keys as Settings holds it: on a sheet that asks before closing loses a typed key.
function KeysSheet({ open, onClose, ...panel }: KeysSheetProps) {
  const [holding, setHolding] = useState(false);
  return (
    <Sheet open={open} onClose={onClose} dirty={holding} title="Keys" closeLabel="Close keys">
      <KeysPanel {...panel} active={open} onHolding={setHolding} />
    </Sheet>
  );
}

// The real hook over a fake daemon, so the lock that orders key changes is the one the app uses.
const daemon: ApiClient = createApi("test", {
  origin: "http://127.0.0.1:4790",
  fetchImpl: async (url) =>
    new Response(
      JSON.stringify(new URL(String(url)).pathname === "/api/keyd" ? HEALTHY : { keys: [weather] }),
    ),
});
function Live(props: Omit<KeysSheetProps, "keys">) {
  const keys = useKeys(daemon, 60_000);
  return <KeysSheet {...props} keys={keys} />;
}

const LABEL = "Label (optional)";
const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const provider = () => screen.getByRole("combobox", { name: "Provider" });
const type = (name: string, value: string) => fireEvent.change(field(name), { target: { value } });
const saveButton = () => screen.getByRole("button", { name: "Save key" });
const openForm = () => fireEvent.click(screen.getByRole("button", { name: "Add key" }));
const unavailable = (button: HTMLElement) => button.getAttribute("aria-disabled") === "true";
const prompt = () => screen.getByText("Discard unsaved changes?").closest("fieldset");
function chooseProvider(text: string) {
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Provider" }), { key: "ArrowDown" });
  const search = screen.getByRole("combobox", { name: "Search: Provider" });
  fireEvent.change(search, { target: { value: text } });
  fireEvent.keyDown(search, { key: "Enter" });
}

describe("Keys", () => {
  it("does not clear a later preset or select its key from an older sealed save", async () => {
    const held = Promise.withResolvers<{ restart: boolean; key: KeyRecord }>();
    const save = vi.fn(() => held.promise),
      onSaved = vi.fn();
    const keys = controller({ save });
    const old = {
      requestId: 1,
      provider: "openai-compatible" as const,
      baseURL: "https://example.test/v1",
    };
    const next = { requestId: 2, provider: "openai" as const };
    const view = render(
      <KeysSheet open keys={keys} onClose={() => {}} preset={old} onSaved={onSaved} />,
    );
    expect(field("Base URL").value).toBe(old.baseURL);
    type(LABEL, "old-key");
    type("Key", "fixture-private-value");
    fireEvent.submit(screen.getByRole("form"));
    expect(field("Key").value).toBe("");
    view.rerender(
      <KeysSheet open={false} keys={keys} onClose={() => {}} preset={old} onSaved={onSaved} />,
    );
    view.rerender(
      <KeysSheet open keys={keys} onClose={() => {}} preset={next} onSaved={onSaved} />,
    );
    type(LABEL, "new-key");
    await act(async () => {
      held.resolve({
        restart: false,
        key: {
          id: "old-key",
          kind: "llm",
          provider: "openai-compatible",
          baseURL: old.baseURL,
          createdAt: "t",
          updatedAt: "t",
        },
      });
    });
    expect(field(LABEL).value).toBe("new-key");
    expect(provider().textContent).toBe("OpenAI");
    expect(field("Key").value).toBe("");
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
    expect(save).toHaveBeenCalledOnce();
  });

  it("refuses a closed form submit even when script refills the key field", async () => {
    const save = vi.fn(async () => ({ restart: false }));
    const { rerender } = render(<KeyForm active save={save} />);
    type(LABEL, "weather");
    type("Key", "fake-private-value");
    rerender(<KeyForm active={false} save={save} />);
    field("Key").value = "fake-private-value";
    fireEvent.submit(screen.getByRole("form"));
    expect(save).not.toHaveBeenCalled();
    await act(async () => {});
  });

  it("saves once when two submissions arrive before the controls lock", async () => {
    const pending = Promise.withResolvers<{ restart: boolean }>();
    const save = vi.fn(() => pending.promise);
    render(<KeyForm active save={save} />);
    type(LABEL, "weather");
    type("Key", "fake-private-value");
    const form = screen.getByRole("form");
    const input = field("Key");
    try {
      // Keep both events in the same React batch so locked controls cannot mask a duplicate.
      act(() => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        input.value = "fake-private-value";
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      expect(save).toHaveBeenCalledOnce();
    } finally {
      await act(async () => pending.resolve({ restart: false }));
    }
  });

  it("names a key after its provider or service when no label is typed, never reusing one", async () => {
    const save = vi.fn(async () => ({ restart: false }));
    const { rerender } = render(<KeyForm active save={save} taken={["anthropic"]} />);
    expect(field(LABEL).placeholder).toBe("anthropic-2");
    type("Key", "sk-ant-api03-fixture-value");
    await act(async () => {
      fireEvent.submit(screen.getByRole("form"));
    });
    expect(save).toHaveBeenLastCalledWith(
      { id: "anthropic-2", kind: "llm", provider: "anthropic" },
      "sk-ant-api03-fixture-value",
    );
    rerender(<KeyForm active save={save} taken={[]} />);
    fireEvent.click(screen.getByRole("radio", { name: "Web API" }));
    type("Hosts", "api.weather.example, weather.example");
    expect(field(LABEL).placeholder).toBe("weather");
    type(LABEL, "anthropic");
    rerender(<KeyForm active save={save} taken={["anthropic"]} />);
    expect(screen.getByText("Saving replaces the key with this label.")).toBeTruthy();
  });

  it("shows what to fix in the other fields as the key field takes focus", () => {
    render(<KeyForm active save={async () => ({ restart: false })} />);
    chooseProvider("openai-compatible");
    expect(screen.queryByText(/https:\/\/ address/)).toBeNull();
    fireEvent.focus(field("Key"));
    expect(screen.getByText(/https:\/\/ address/)).toBeTruthy();
    expect(field("Base URL").getAttribute("aria-invalid")).toBe("true");
  });

  it("pastes into the key field from the clipboard, and refuses a plan token", async () => {
    const readText = vi.fn(async () => "  sk-proj-fixture-value  ");
    vi.stubGlobal("navigator", { ...navigator, clipboard: { readText } });
    const onHolding = vi.fn();
    render(<KeyForm active save={async () => ({ restart: false })} onHolding={onHolding} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Paste key" }));
    });
    expect(field("Key").value).toBe("sk-proj-fixture-value");
    expect(document.activeElement).toBe(field("Key"));
    expect(onHolding).toHaveBeenLastCalledWith(true);
    readText.mockResolvedValue(`sk-ant-oat01-${"a".repeat(95)}`);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Paste key" }));
    });
    expect(field("Key").value).toBe("");
    expect(screen.getByRole("alert").textContent).toBe(PLAN_REFUSAL);
    expect(onHolding).toHaveBeenLastCalledWith(false);
  });

  it("requires fresh confirmation after expiry even if the timer has not run", async () => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const remove = vi.fn(async () => {});
    render(<KeyList active keys={[weather]} remove={remove} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove weather" }));
    // A suspended tab can resume with an expired deadline before its queued timeout executes.
    now = 5000;
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove weather" }));
    expect(remove).not.toHaveBeenCalled();
    await act(async () => {});
  });

  it("requires fresh confirmation when a key with the same name has been replaced", () => {
    const remove = vi.fn(async () => {});
    const { rerender } = render(<KeyList active keys={[weather]} remove={remove} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove weather" }));
    rerender(
      <KeyList
        active
        keys={[{ ...weather, hosts: ["new.weather.example"], updatedAt: "new" }]}
        remove={remove}
      />,
    );
    expect(screen.queryByRole("button", { name: "Confirm remove weather" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove weather" }));
    expect(remove).not.toHaveBeenCalled();
  });

  it("deletes once when confirmation presses arrive before the controls lock", async () => {
    const pending = Promise.withResolvers<void>();
    const remove = vi.fn(() => pending.promise);
    render(<KeyList active keys={[weather]} remove={remove} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove weather" }));
    const button = screen.getByRole("button", { name: "Confirm remove weather" });
    try {
      act(() => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      expect(remove).toHaveBeenCalledOnce();
    } finally {
      await act(async () => pending.resolve());
    }
  });

  it("folds a removed row away instead of dropping it", async () => {
    const remove = vi.fn(async () => {});
    const { container, rerender } = render(
      <KeyList active keys={[anthropic, weather]} remove={remove} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove weather" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm remove weather" }));
    });
    rerender(<KeyList active keys={[anthropic]} remove={remove} />);
    const leaving = container.querySelector('[data-id="weather"]');
    expect(leaving?.hasAttribute("data-leaving")).toBe(true);
    expect(leaving?.hasAttribute("inert")).toBe(true);
    await waitFor(() => expect(container.querySelector('[data-id="weather"]')).toBeNull());
    expect(container.querySelector('[data-id="anthropic"]')).not.toBeNull();
  });

  it("says when a key was added and how often this task used it, and lights a key just saved", () => {
    render(
      <KeyList
        active
        keys={[anthropic, weather]}
        uses={{ weather: 2 }}
        fresh={{ id: "weather", at: 1 }}
        remove={async () => {}}
      />,
    );
    const row = screen.getByText("weather").closest("li");
    expect(row?.querySelector(".ui-group-row-text")?.textContent).toMatch(
      /^weatherapi\.weather\.example, Authorization, Added .*3.*, Used 2× this task$/,
    );
    expect(row?.hasAttribute("data-fresh")).toBe(true);
    expect(screen.getByText("anthropic").closest("li")?.textContent).toContain("Anthropic");
  });

  it("clears unsaved text on close, pagehide and hidden visibility", () => {
    const keys = controller();
    const { rerender } = render(<KeysSheet open keys={keys} onClose={() => {}} />);
    type("Key", "fake-private-value");
    rerender(<KeysSheet open={false} keys={keys} onClose={() => {}} />);
    rerender(<KeysSheet open keys={keys} onClose={() => {}} />);
    expect(field("Key").value).toBe("");
    type("Key", "fake-private-value");
    fireEvent(window, new Event("pagehide"));
    expect(field("Key").value).toBe("");
    type("Key", "fake-private-value");
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    expect(field("Key").value).toBe("");
  });

  it("clears before a synchronous save failure and refuses synthetic offline submits", async () => {
    let valueAtSave: string | undefined;
    const save = vi.fn(() => {
      valueAtSave = field("Key").value;
      throw new Error("private-error");
    });
    const keys = controller({ save });
    const { rerender } = render(<KeysSheet open keys={keys} onClose={() => {}} />);
    type(LABEL, "provider");
    type("Key", "fake-private-value");
    fireEvent.submit(screen.getByRole("form"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(save).toHaveBeenCalledOnce();
    // Assert outside the callback: the form catches anything thrown by save.
    expect(valueAtSave).toBe("");
    expect(field("Key").value).toBe("");
    expect(document.body.textContent).not.toContain("private-error");
    rerender(<KeysSheet open keys={{ ...keys, health: { online: false } }} onClose={() => {}} />);
    type("Key", "fake-private-value");
    fireEvent.submit(screen.getByRole("form"));
    expect(save).toHaveBeenCalledOnce();
  });

  it("locks the form and removal while a save is pending, including across close and reopen", async () => {
    const sealing = Promise.withResolvers<{ key: KeyRecord; restart: boolean }>();
    const saved = vi.spyOn(keysApi, "saveKey").mockReturnValue(sealing.promise);
    const deleted = vi.spyOn(keysApi, "deleteKey").mockResolvedValue(undefined);
    const { rerender } = render(<Live open onClose={() => {}} />);
    await screen.findByText("weather");
    openForm();
    type(LABEL, "weather");
    type("Key", "fake-private-value");
    fireEvent.submit(screen.getByRole("form"));
    fireEvent.submit(screen.getByRole("form"));
    expect(saved).toHaveBeenCalledOnce();
    expect(field(LABEL).readOnly).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove weather" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove weather" }));
    expect(deleted).not.toHaveBeenCalled();
    rerender(<Live open={false} onClose={() => {}} />);
    rerender(<Live open onClose={() => {}} />);
    if (!screen.queryByRole("form")) openForm();
    expect(field(LABEL).readOnly).toBe(true);
    expect(unavailable(saveButton())).toBe(true);
    await act(async () => {
      sealing.resolve({ key: weather, restart: false });
    });
    expect(field(LABEL).readOnly).toBe(false);
    expect(unavailable(saveButton())).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
    expect(field("Key").value).toBe("");
  });

  it("allows only one pending deletion and blocks saves until it settles", async () => {
    const deleting = Promise.withResolvers<void>();
    const deleted = vi.spyOn(keysApi, "deleteKey").mockReturnValue(deleting.promise);
    const saved = vi.spyOn(keysApi, "saveKey");
    render(<Live open onClose={() => {}} />);
    await screen.findByText("weather");
    openForm();
    type(LABEL, "weather");
    type("Key", "fake-private-value");
    fireEvent.click(screen.getByRole("button", { name: "Remove weather" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove weather" }));
    fireEvent.click(screen.getByRole("button", { name: "Removing… weather" }));
    fireEvent.submit(screen.getByRole("form"));
    expect(deleted).toHaveBeenCalledOnce();
    expect(saved).not.toHaveBeenCalled();
    expect(unavailable(saveButton())).toBe(true);
    await act(async () => {
      deleting.resolve();
    });
    expect(unavailable(saveButton())).toBe(false);
  });

  it("keeps a typed key while another key is removed, read-only until the removal settles", async () => {
    const deleting = Promise.withResolvers<void>();
    vi.spyOn(keysApi, "deleteKey").mockReturnValue(deleting.promise);
    render(<Live open onClose={() => {}} />);
    await screen.findByText("weather");
    openForm();
    type(LABEL, "books");
    type("Key", "fake-private-value");
    fireEvent.click(screen.getByRole("button", { name: "Remove weather" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove weather" }));
    expect(field("Key").value).toBe("fake-private-value");
    expect(field("Key").readOnly).toBe(true);
    await act(async () => {
      deleting.resolve();
    });
    expect(field("Key").value).toBe("fake-private-value");
    expect(field("Key").readOnly).toBe(false);
  });

  it("expires deletion confirmation and clears it on close or offline transition", () => {
    vi.useFakeTimers();
    const remove = vi.fn(async () => {});
    const keys = controller({ remove, keys: [weather] });
    const { rerender } = render(<KeysSheet open keys={keys} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove weather" }));
    act(() => vi.advanceTimersByTime(4000));
    expect(screen.queryByRole("button", { name: "Confirm remove weather" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove weather" }));
    rerender(<KeysSheet open={false} keys={keys} onClose={() => {}} />);
    act(() => vi.advanceTimersByTime(1000));
    rerender(<KeysSheet open keys={keys} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Confirm remove weather" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove weather" }));
    rerender(<KeysSheet open keys={{ ...keys, health: { online: false } }} onClose={() => {}} />);
    rerender(<KeysSheet open keys={keys} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove weather" }));
    expect(remove).not.toHaveBeenCalled();
  });

  it("hands save the binding and the key, then clears the key field before the save settles", async () => {
    let settle: (v: { restart: boolean }) => void = () => {};
    const save = vi.fn(() => new Promise<{ restart: boolean }>((r) => (settle = r)));
    render(<KeysSheet open keys={controller({ save })} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: "Web API" }));
    type(LABEL, "weather");
    type("Hosts", "api.weather.example");
    type("Key", "  sk-weather-123456 ");
    fireEvent.click(saveButton());
    expect(save).toHaveBeenCalledWith(
      {
        id: "weather",
        kind: "http",
        hosts: ["api.weather.example"],
        header: "Authorization",
        format: "bearer",
      },
      "sk-weather-123456",
    );
    expect(field("Key").value).toBe("");
    // A text field drawn as dots: not a password field, which Chrome offers to save.
    expect(field("Key").type).toBe("text");
    expect(field("Key").closest(".keys-secret")).not.toBeNull();
    await act(async () => settle({ restart: true }));
    expect(screen.getByText("Saved weather. Restart your computer to use it there.")).toBeTruthy();
    expect(field(LABEL).value).toBe("");
  });

  it("names what to fix and saves nothing", () => {
    const save = vi.fn(async () => ({ restart: false }));
    render(<KeysSheet open keys={controller({ save })} onClose={() => {}} />);
    type(LABEL, "My Key");
    type("Key", "sk-ant-0123456");
    fireEvent.click(saveButton());
    expect(screen.getByText(/lower-case letters/)).toBeTruthy();
    expect(field(LABEL).getAttribute("aria-invalid")).toBe("true");
    type(LABEL, "anthropic");
    type("Key", "short");
    fireEvent.click(saveButton());
    expect(screen.getByText(/8 to 8,192 characters/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses a Claude plan token on paste and on save, clears it and saves nothing", () => {
    const token = `sk-ant-oat01-${"a".repeat(95)}`;
    const save = vi.fn(async () => ({ restart: false }));
    render(<KeysSheet open keys={controller({ save })} onClose={() => {}} />);
    const hint = screen.getByText("sk-ant-api").closest("p");
    expect(hint?.textContent).toBe("Starts with sk-ant-api");
    expect(field("Key").getAttribute("aria-describedby")).toBe(hint?.id);
    type("Key", token);
    expect(field("Key").value).toBe("");
    const error = screen.getByText(PLAN_REFUSAL);
    expect(field("Key").getAttribute("aria-invalid")).toBe("true");
    expect(field("Key").getAttribute("aria-describedby")?.split(" ")).toContain(
      error.closest("p")?.id,
    );
    expect(screen.getByRole("alert")).toBe(error);
    // A value set without an input event, before a label is given, is refused for itself first.
    type(LABEL, "x");
    type(LABEL, "");
    expect(screen.queryByText(PLAN_REFUSAL)).toBeNull();
    field("Key").value = token;
    fireEvent.click(saveButton());
    expect(field("Key").value).toBe("");
    expect(screen.getByText(PLAN_REFUSAL)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Web API" }));
    expect(screen.queryByText("sk-ant-api")).toBeNull();
    type(LABEL, "claude");
    type("Hosts", "api.anthropic.com");
    field("Key").value = token;
    fireEvent.click(saveButton());
    expect(screen.getByText(PLAN_REFUSAL)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the setup-token export line",
      `export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-${"a".repeat(95)}`,
    ],
    ["a quoted token", `"sk-ant-oat01-${"a".repeat(95)}"`],
    ["a Bearer token", `Bearer sk-ant-oat01-${"a".repeat(95)}`],
    ["a refresh token", `sk-ant-ort01-${"a".repeat(95)}`],
  ])("refuses %s on paste and on save, and saves nothing", (_, value) => {
    const save = vi.fn(async () => ({ restart: false }));
    render(<KeysSheet open keys={controller({ save })} onClose={() => {}} />);
    type(LABEL, "claudewrapped");
    type("Key", "short");
    fireEvent.click(saveButton());
    const tooShort = screen.getByText(/8 to 8,192 characters/);
    expect(screen.queryByRole("alert")).toBeNull();
    type("Key", value);
    expect(field("Key").value).toBe("");
    const refusal = screen.getByRole("alert");
    expect(refusal.textContent).toBe(PLAN_REFUSAL);
    expect(refusal).not.toBe(tooShort);
    type(LABEL, "claudewrapped2");
    expect(screen.queryByText(PLAN_REFUSAL)).toBeNull();
    field("Key").value = value;
    fireEvent.click(saveButton());
    expect(field("Key").value).toBe("");
    expect(screen.getByText(PLAN_REFUSAL)).toBeTruthy();
    expect(screen.queryByText(/^Saved/)).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("says when saving failed and asks for the key again", async () => {
    const save = vi.fn(async () => {
      throw new Error("boom");
    });
    render(<KeysSheet open keys={controller({ save })} onClose={() => {}} />);
    type(LABEL, "anthropic");
    type("Key", "sk-ant-0123456");
    fireEvent.click(saveButton());
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Something went wrong saving the key. Try again. Paste the key again to retry.",
    );
  });

  it("asks for a base URL only for providers without a fixed one", () => {
    render(<KeysSheet open keys={controller()} onClose={() => {}} />);
    expect(screen.queryByLabelText("Base URL")).toBeNull();
    chooseProvider("openai-compatible");
    expect(provider().textContent).toBe("OpenAI-compatible");
    expect(screen.getByLabelText("Base URL")).toBeTruthy();
  });

  it("says a custom endpoint's address must be https, and where local servers go", () => {
    render(<KeysSheet open keys={controller()} onClose={() => {}} />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Provider" }), { key: "ArrowDown" });
    const list = within(screen.getByRole("listbox", { name: "Provider" }));
    expect(list.getByRole("option", { name: /Anthropic-compatible/ })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search: Provider" }), {
      key: "Escape",
    });
    const hint = (text: string) => {
      const node = screen.getByText(text);
      expect(field("Base URL").getAttribute("aria-describedby")).toContain(node.id);
    };
    chooseProvider("openai-compatible");
    hint("Use https. Local servers go through LM Studio or Ollama.");
    chooseProvider("anthropic-compatible");
    expect(field("Base URL").placeholder).toBe("e.g. https://api.example.com/anthropic");
    hint(
      "Use https, ending in /v1 (added if missing). Local servers go through LM Studio or Ollama.",
    );
    chooseProvider("azure");
    expect(screen.queryByText(/Local servers go through/)).toBeNull();
  });

  it("says key isolation is off, shows no list in its place and will not save", () => {
    render(<KeysSheet open keys={controller({ health: { online: false } })} onClose={() => {}} />);
    const isolation = screen.getByText("Key isolation").closest("li");
    expect(isolation?.textContent).toContain("Off");
    expect(isolation?.textContent).toContain("Keys can't be saved or used until it's back on.");
    expect(isolation?.textContent).toContain("localdot doctor");
    expect(screen.getByText("Your keys show here once key protection is back on.")).toBeTruthy();
    expect(screen.queryByText("No keys yet")).toBeNull();
    expect(unavailable(saveButton())).toBe(true);
    expect(field("Key").readOnly).toBe(true);
    expect(document.body.textContent).not.toMatch(/\bkeyd\b|hairpin/i);
  });

  it("holds keys back while the audit log fails: the list steps back and nothing saves or goes", () => {
    const health = { ...HEALTHY, audit: { ok: false, error: "disk full" } };
    const remove = vi.fn(async () => {});
    render(
      <KeysSheet open keys={controller({ health, keys: [weather], remove })} onClose={() => {}} />,
    );
    const audit = screen.getByText("Audit log").closest("li") as HTMLElement;
    expect(audit.textContent).toContain("Paused — keys held");
    fireEvent.click(within(audit).getByRole("button", { name: /Details/ }));
    expect(within(audit).getByText("disk full")).toBeTruthy();
    expect(screen.getByText("Keys are held until the audit log works again.")).toBeTruthy();
    expect(document.querySelector(".keys-saved")?.hasAttribute("data-held")).toBe(true);
    const removeButton = screen.getByRole("button", { name: "Remove weather" });
    fireEvent.click(removeButton);
    fireEvent.click(removeButton);
    expect(remove).not.toHaveBeenCalled();
    expect(unavailable(screen.getByRole("button", { name: "Add key" }))).toBe(true);
    expect(document.body.textContent).not.toMatch(/\bkeyd\b|hairpin/i);
  });

  it("deletes a key on the second press only", async () => {
    const remove = vi.fn(async () => {});
    render(<KeysSheet open keys={controller({ keys: [weather], remove })} onClose={() => {}} />);
    expect(screen.getByText("api.weather.example")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove weather" }));
    expect(remove).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm remove weather" }));
    });
    expect(remove).toHaveBeenCalledWith("weather");
  });

  it("says whether network protection knows this network's public address", () => {
    const { rerender } = render(<KeysSheet open keys={controller()} onClose={() => {}} />);
    const row = () => screen.getByText("Network protection").closest("li");
    expect(row()?.textContent).toBe("Network protectionOn");
    rerender(
      <KeysSheet
        open
        keys={controller({ health: { ...HEALTHY, hairpin: { state: "unknown", addresses: 0 } } })}
        onClose={() => {}}
      />,
    );
    expect(row()?.textContent).toContain("Checking");
    expect(row()?.textContent).toContain("still finding this network's public address");
  });

  it("copies the fix to run in Terminal", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<KeysSheet open keys={controller({ health: { online: false } })} onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy the command localdot doctor" }));
    });
    expect(writeText).toHaveBeenCalledWith("localdot doctor");
    expect(screen.getByText("Copied")).toBeTruthy();
  });

  it("names network protection's state on the Keys button, where only the amber point shows it", () => {
    const health = {
      online: true,
      audit: { ok: true },
      hairpin: { state: "unknown" as const, addresses: 0 },
    };
    render(
      <TopBar
        title="t"
        mode="watch"
        replayEnabled={false}
        onMode={() => {}}
        keys={keyStatus(health)}
        keysOpen={false}
        onKeys={() => {}}
        settingsOpen={false}
        onSettings={() => {}}
      />,
    );
    const button = screen.getByRole("button", { name: "Keys, network protection checking" });
    expect(button.textContent).toBe("");
    expect(button.querySelector(".ui-icon-button-attention")).toBeTruthy();
  });

  it("keeps the sheet and the choice when Escape comes from the provider picker", () => {
    const onClose = vi.fn();
    render(<KeysSheet open keys={controller()} onClose={onClose} />);
    chooseProvider("openai");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Provider" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search: Provider" }), {
      key: "Escape",
    });
    expect(provider().getAttribute("aria-expanded")).toBe("false");
    expect(onClose).not.toHaveBeenCalled();
    expect(provider().textContent).toBe("OpenAI");
  });

  it("asks before closing discards a typed key", () => {
    const onClose = vi.fn();
    render(<KeysSheet open keys={controller()} onClose={onClose} />);
    type("Key", "fake-private-value");
    field("Key").focus();
    fireEvent.keyDown(field("Key"), { key: "Escape" });
    expect(prompt()?.hasAttribute("data-shown")).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep editing" }));
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(prompt()?.hasAttribute("data-shown")).toBe(false);
    expect(document.activeElement).toBe(field("Key"));
    expect(field("Key").value).toBe("fake-private-value");
    fireEvent.click(screen.getByRole("button", { name: "Close keys" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("asks before closing discards a key handed over from elsewhere", () => {
    const onClose = vi.fn();
    const intake = createRef<KeyIntake>();
    render(<KeysSheet open keys={controller()} onClose={onClose} intakeRef={intake} />);
    const source = document.createElement("input");
    source.value = "fake-private-value";
    act(() => {
      intake.current?.receive(source, "openai");
    });
    expect(provider().textContent).toBe("OpenAI");
    fireEvent.click(screen.getByRole("button", { name: "Close keys" }));
    expect(prompt()?.hasAttribute("data-shown")).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("opens the form on Add key, and Cancel clears it and folds it away", () => {
    render(<KeysSheet open keys={controller({ keys: [weather] })} onClose={() => {}} />);
    expect(screen.queryByRole("form")).toBeNull();
    openForm();
    type("Key", "fake-private-value");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form")).toBeNull();
    openForm();
    expect(field("Key").value).toBe("");
  });

  it("opens the form for a key handed over from elsewhere", () => {
    const intake = createRef<KeyIntake>();
    render(
      <KeysSheet
        open
        keys={controller({ keys: [weather] })}
        onClose={() => {}}
        intakeRef={intake}
      />,
    );
    const source = document.createElement("input");
    source.value = "fake-private-value";
    let taken = false;
    act(() => {
      taken = intake.current?.receive(source, "openai") ?? false;
    });
    expect(taken).toBe(true);
    expect(source.value).toBe("");
    expect(field("Key").value).toBe("fake-private-value");
    expect(provider().textContent).toBe("OpenAI");
  });

  it("reports whether its key field holds a key", () => {
    const fieldRef = createRef<KeyField>();
    const onHolding = vi.fn();
    render(
      <KeyForm
        active
        fieldRef={fieldRef}
        onHolding={onHolding}
        save={async () => ({ restart: false })}
      />,
    );
    expect(fieldRef.current?.holdsKey()).toBe(false);
    type("Key", "fake-private-value");
    expect(fieldRef.current?.holdsKey()).toBe(true);
    expect(onHolding).toHaveBeenLastCalledWith(true);
    fieldRef.current?.focus();
    expect(document.activeElement).toBe(field("Key"));
    fireEvent(window, new Event("pagehide"));
    expect(onHolding).toHaveBeenLastCalledWith(false);
  });

  it("keeps iOS from capitalising or correcting labels, addresses, headers and the key", () => {
    render(<KeysSheet open keys={controller()} onClose={() => {}} />);
    chooseProvider("openai-compatible");
    const plain = (name: string) => {
      expect(field(name).getAttribute("autocapitalize"), name).toBe("none");
      expect(field(name).getAttribute("autocorrect"), name).toBe("off");
      expect(field(name).getAttribute("spellcheck"), name).toBe("false");
    };
    plain(LABEL);
    plain("Base URL");
    plain("Key");
    expect(field("Base URL").getAttribute("inputmode")).toBe("url");
    fireEvent.click(screen.getByRole("radio", { name: "Web API" }));
    plain("Hosts");
    plain("Header");
  });

  it("names each remove button with its visible label", () => {
    render(<KeyList active keys={[weather]} remove={async () => {}} />);
    const remove = screen.getByRole("button", { name: "Remove weather" });
    expect(remove.textContent).toBe("Remove");
    fireEvent.click(remove);
    const confirm = screen.getByRole("button", { name: "Confirm remove weather" });
    expect(confirm.textContent).toBe("Confirm remove");
    expect(confirm.closest("li")?.hasAttribute("data-armed")).toBe(true);
  });
});
