// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopBar } from "../shell/TopBar.tsx";
import { type KeyField, KeyForm, type KeyIntake } from "./KeyForm.tsx";
import { KeyList } from "./KeyList.tsx";
import { KeysSheet } from "./KeysSheet.tsx";
import type { KeyRecord } from "./keys-api.ts";
import { type KeysController, keyStatus } from "./useKeys.ts";

afterEach(cleanup);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const weather: KeyRecord = {
  id: "weather",
  kind: "http",
  hosts: ["api.weather.example"],
  header: "Authorization",
  format: "bearer",
  createdAt: "t",
  updatedAt: "t",
};

function controller(over: Partial<KeysController> = {}): KeysController {
  return {
    health: {
      online: true,
      bootId: "b",
      sealKey: "K",
      audit: { ok: true },
      hairpin: { state: "active", source: "nat-pmp", addresses: 1 },
    },
    keys: [],
    loadError: null,
    save: vi.fn(async () => ({ restart: false })),
    remove: vi.fn(async () => {}),
    ...over,
  };
}

const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const type = (name: string, value: string) => fireEvent.change(field(name), { target: { value } });

describe("KeysSheet", () => {
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
    type("Name", "old-key");
    type("Key", "fixture-private-value");
    fireEvent.submit(screen.getByRole("form"));
    expect(field("Key").value).toBe("");
    view.rerender(
      <KeysSheet open={false} keys={keys} onClose={() => {}} preset={old} onSaved={onSaved} />,
    );
    view.rerender(
      <KeysSheet open keys={keys} onClose={() => {}} preset={next} onSaved={onSaved} />,
    );
    type("Name", "new-key");
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
    expect(field("Name").value).toBe("new-key");
    expect(field("Provider").value).toBe("openai");
    expect(field("Key").value).toBe("");
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
    expect(save).toHaveBeenCalledOnce();
  });
  it("refuses a closed form submit even when script refills the disabled key field", async () => {
    const save = vi.fn(async () => ({ restart: false }));
    const { rerender } = render(<KeyForm active disabled={false} save={save} />);
    type("Name", "weather");
    type("Key", "fake-private-value");
    rerender(<KeyForm active={false} disabled={false} save={save} />);
    field("Key").value = "fake-private-value";
    fireEvent.submit(screen.getByRole("form"));
    expect(save).not.toHaveBeenCalled();
    await act(async () => {});
  });

  it("saves once when two submissions arrive before the controls disable", async () => {
    const pending = Promise.withResolvers<{ restart: boolean }>();
    const save = vi.fn(() => pending.promise);
    render(<KeyForm active disabled={false} save={save} />);
    type("Name", "weather");
    type("Key", "fake-private-value");
    const form = screen.getByRole("form");
    const input = field("Key");
    try {
      // Keep both events in the same React batch so disabled controls cannot mask a duplicate.
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

  it("requires fresh confirmation after expiry even if the timer has not run", async () => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const remove = vi.fn(async () => {});
    render(<KeyList active disabled={false} keys={[weather]} remove={remove} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove weather" }));
    // A suspended tab can resume with an expired deadline before its queued timeout executes.
    now = 5000;
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove weather" }));
    expect(remove).not.toHaveBeenCalled();
    await act(async () => {});
  });

  it("requires fresh confirmation when a key with the same name has been replaced", () => {
    const remove = vi.fn(async () => {});
    const { rerender } = render(
      <KeyList active disabled={false} keys={[weather]} remove={remove} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove weather" }));
    rerender(
      <KeyList
        active
        disabled={false}
        keys={[{ ...weather, hosts: ["new.weather.example"], updatedAt: "new" }]}
        remove={remove}
      />,
    );
    expect(screen.queryByRole("button", { name: "Confirm remove weather" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove weather" }));
    expect(remove).not.toHaveBeenCalled();
  });

  it("deletes once when confirmation presses arrive before the controls disable", async () => {
    const pending = Promise.withResolvers<void>();
    const remove = vi.fn(() => pending.promise);
    render(<KeyList active disabled={false} keys={[weather]} remove={remove} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove weather" }));
    const button = screen.getByRole("button", {
      name: "Confirm remove weather",
    });
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

  it("honors the first mutation when save and delete arrive before the controls disable", async () => {
    for (const first of ["save", "delete"] as const) {
      const saving = Promise.withResolvers<{ restart: boolean }>();
      const deleting = Promise.withResolvers<void>();
      const save = vi.fn(() => saving.promise);
      const remove = vi.fn(() => deleting.promise);
      const view = render(
        <KeysSheet open keys={controller({ save, remove, keys: [weather] })} onClose={() => {}} />,
      );
      type("Name", "weather");
      type("Key", "fake-private-value");
      fireEvent.click(screen.getByRole("button", { name: "Remove weather" }));
      const button = screen.getByRole("button", {
        name: "Confirm remove weather",
      });
      const form = screen.getByRole("form");
      const submit = () =>
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      const confirm = () =>
        button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      try {
        act(() => {
          if (first === "save") {
            submit();
            confirm();
          } else {
            confirm();
            submit();
          }
        });
        expect(save, `save calls when ${first} arrived first`).toHaveBeenCalledTimes(
          first === "save" ? 1 : 0,
        );
        expect(remove, `delete calls when ${first} arrived first`).toHaveBeenCalledTimes(
          first === "delete" ? 1 : 0,
        );
      } finally {
        await act(async () => {
          saving.resolve({ restart: false });
          deleting.resolve();
        });
        view.unmount();
      }
    }
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
    type("Name", "provider");
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

  it("locks the whole form and deletion while save is pending, including across close/reopen", async () => {
    const saving = Promise.withResolvers<{ restart: boolean }>();
    const save = vi.fn(() => saving.promise);
    const remove = vi.fn(async () => {});
    const keys = controller({ save, remove, keys: [weather] });
    const { rerender } = render(<KeysSheet open keys={keys} onClose={() => {}} />);
    type("Name", "weather");
    type("Key", "fake-private-value");
    fireEvent.submit(screen.getByRole("form"));
    fireEvent.submit(screen.getByRole("form"));
    expect(save).toHaveBeenCalledOnce();
    expect(field("Name").matches(":disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove weather" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove weather" }));
    expect(remove).not.toHaveBeenCalled();
    const close = screen.getByRole("button", { name: "Close keys" });
    close.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);
    rerender(<KeysSheet open={false} keys={keys} onClose={() => {}} />);
    rerender(<KeysSheet open keys={keys} onClose={() => {}} />);
    expect(field("Name").matches(":disabled")).toBe(true);
    await act(async () => {
      saving.resolve({ restart: false });
    });
    expect(field("Name").matches(":disabled")).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
    expect(field("Name").value).toBe("weather");
    expect(field("Key").value).toBe("");
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
    rerender(<KeysSheet open keys={keys} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Confirm remove weather" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove weather" }));
    rerender(<KeysSheet open keys={{ ...keys, health: { online: false } }} onClose={() => {}} />);
    rerender(<KeysSheet open keys={keys} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove weather" }));
    expect(remove).not.toHaveBeenCalled();
  });

  it("allows only one pending deletion and blocks saves until it settles", async () => {
    const deleting = Promise.withResolvers<void>();
    const remove = vi.fn(() => deleting.promise);
    const save = vi.fn(async () => ({ restart: false }));
    render(
      <KeysSheet open keys={controller({ remove, save, keys: [weather] })} onClose={() => {}} />,
    );
    type("Name", "weather");
    type("Key", "fake-private-value");
    fireEvent.click(screen.getByRole("button", { name: "Remove weather" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove weather" }));
    fireEvent.click(screen.getByRole("button", { name: "Removing… weather" }));
    fireEvent.submit(screen.getByRole("form"));
    expect(remove).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
      deleting.resolve();
    });
    expect((screen.getByRole("button", { name: "Save key" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
  it("hands save the binding and the key, then clears the key field before the save settles", async () => {
    let settle: (v: { restart: boolean }) => void = () => {};
    const save = vi.fn(() => new Promise<{ restart: boolean }>((r) => (settle = r)));
    render(<KeysSheet open keys={controller({ save })} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Web API" }));
    type("Name", "weather");
    type("Hosts", "api.weather.example");
    type("Key", "  sk-weather-123456 ");
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
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
    expect(field("Key")).toMatchObject({ type: "text", className: "secret" });
    settle({ restart: true });
    expect(
      await screen.findByText("Saved weather. Restart your computer to use it there."),
    ).toBeTruthy();
    expect(field("Name").value).toBe("");
  });

  it("names what to fix and saves nothing", async () => {
    const save = vi.fn(async () => ({ restart: false }));
    render(<KeysSheet open keys={controller({ save })} onClose={() => {}} />);
    type("Name", "My Key");
    type("Key", "sk-ant-0123456");
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(screen.getByText(/lower-case letters/)).toBeTruthy();
    expect(field("Name").getAttribute("aria-invalid")).toBe("true");
    type("Name", "anthropic");
    type("Key", "short");
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(screen.getByText(/8 to 8,192 characters/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses a Claude plan token on paste and on save, clears it and saves nothing", () => {
    const SENTENCE =
      "Claude Pro and Max plans can't be used here: Anthropic doesn't allow other apps to sign in with them. Add an Anthropic API key instead.";
    const token = `sk-ant-oat01-${"a".repeat(95)}`;
    const save = vi.fn(async () => ({ restart: false }));
    render(<KeysSheet open keys={controller({ save })} onClose={() => {}} />);
    const hint = screen.getByText("sk-ant-api").closest("p");
    expect(hint?.textContent).toBe("Starts with sk-ant-api");
    expect(field("Key").getAttribute("aria-describedby")).toBe(hint?.id);
    type("Key", token);
    expect(field("Key").value).toBe("");
    const error = screen.getByText(SENTENCE);
    expect(field("Key").getAttribute("aria-invalid")).toBe("true");
    expect(field("Key").getAttribute("aria-describedby")?.split(" ")).toContain(error.id);
    // A value set without an input event, before a name is given, is refused for itself first.
    type("Name", "x");
    type("Name", "");
    expect(screen.queryByText(SENTENCE)).toBeNull();
    field("Key").value = token;
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(field("Key").value).toBe("");
    expect(screen.getByText(SENTENCE)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Web API" }));
    expect(screen.queryByText("sk-ant-api")).toBeNull();
    type("Name", "claude");
    type("Hosts", "api.anthropic.com");
    field("Key").value = token;
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(screen.getByText(SENTENCE)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it("says when saving failed and asks for the key again", async () => {
    const save = vi.fn(async () => {
      throw new Error("boom");
    });
    render(<KeysSheet open keys={controller({ save })} onClose={() => {}} />);
    type("Name", "anthropic");
    type("Key", "sk-ant-0123456");
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Something went wrong saving the key. Try again. Paste the key again to retry.",
    );
  });

  it("asks for a base URL only for providers without a fixed one", () => {
    render(<KeysSheet open keys={controller()} onClose={() => {}} />);
    expect(screen.queryByLabelText("Base URL")).toBeNull();
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "openai-compatible" },
    });
    expect(screen.getByLabelText("Base URL")).toBeTruthy();
  });

  it("says the key layer is offline and will not save", () => {
    render(<KeysSheet open keys={controller({ health: { online: false } })} onClose={() => {}} />);
    expect(screen.getByRole("alert").textContent).toContain("The key layer is offline");
    expect((screen.getByRole("button", { name: "Save key" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("says keyd is holding keys back while its audit log fails", () => {
    const health = {
      online: true,
      bootId: "b",
      sealKey: "K",
      audit: { ok: false, error: "disk full" },
    };
    render(<KeysSheet open keys={controller({ health })} onClose={() => {}} />);
    expect(screen.getByRole("alert").textContent).toBe(
      "keyd can't write its audit log, so it holds every key back until it can: disk full",
    );
  });

  it("deletes a key on the second press only", async () => {
    const remove = vi.fn(async () => {});
    render(<KeysSheet open keys={controller({ keys: [weather], remove })} onClose={() => {}} />);
    expect(screen.getByText("api.weather.example · Authorization")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove weather" }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove weather" }));
    expect(remove).toHaveBeenCalledWith("weather");
  });

  it("says whether the hairpin guard knows this network's public address", () => {
    const { rerender } = render(<KeysSheet open keys={controller()} onClose={() => {}} />);
    expect(screen.getByText(/^Hairpin guard: active/)).toBeTruthy();
    const unknown = controller({
      health: {
        online: true,
        bootId: "b",
        sealKey: "K",
        hairpin: { state: "unknown", addresses: 0 },
      },
    });
    rerender(<KeysSheet open keys={unknown} onClose={() => {}} />);
    expect(screen.getByText(/^Hairpin guard: unknown/).textContent).toContain("keeps asking");
  });

  it("names the hairpin guard's state on the Keys button, where only a hollow dot shows it", () => {
    const health = {
      online: true,
      audit: { ok: true },
      hairpin: { state: "unknown" as const, addresses: 0 },
    };
    render(
      <TopBar title="t" live={false} keys={keyStatus(health)} keysOpen={false} onKeys={() => {}} />,
    );
    const button = screen.getByRole("button", {
      name: "Keys, hairpin guard unknown",
    });
    expect(button.textContent).toBe("Keys");
  });

  it("keeps Tab inside the open sheet", () => {
    render(<KeysSheet open keys={controller()} onClose={() => {}} />);
    const close = screen.getByRole("button", { name: "Close keys" });
    const save = screen.getByRole("button", { name: "Save key" });
    save.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(save);
  });

  it("closes on Escape and on a full click on the scrim, and is inert while closed", () => {
    const onClose = vi.fn();
    const { container, rerender } = render(
      <KeysSheet open keys={controller()} onClose={onClose} />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    const scrim = container.querySelector(".scrim") as Element;
    fireEvent.pointerDown(scrim);
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(2);
    rerender(<KeysSheet open={false} keys={controller()} onClose={onClose} />);
    expect(container.querySelector(".sheet")?.hasAttribute("inert")).toBe(true);
  });

  it("keeps the sheet and the choice when Escape comes from the provider picker", () => {
    const onClose = vi.fn();
    render(<KeysSheet open keys={controller()} onClose={onClose} />);
    const provider = screen.getByRole("combobox", { name: "Provider" }) as HTMLSelectElement;
    provider.focus();
    fireEvent.change(provider, { target: { value: "openai" } });
    fireEvent.keyDown(provider, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(provider.value).toBe("openai");
  });

  it("asks before closing discards a typed key", () => {
    const onClose = vi.fn();
    render(<KeysSheet open keys={controller()} onClose={onClose} />);
    type("Key", "fake-private-value");
    fireEvent.click(screen.getByRole("button", { name: "Close keys" }));
    expect(screen.getByRole("alert").textContent).toBe("Discard the key you entered?");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep editing" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Discard the key you entered?")).toBeNull();
    expect(document.activeElement).toBe(field("Key"));
    expect(field("Key").value).toBe("fake-private-value");
    fireEvent.keyDown(window, { key: "Escape" });
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
    fireEvent.click(screen.getByRole("button", { name: "Close keys" }));
    expect(screen.getByRole("alert").textContent).toBe("Discard the key you entered?");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("reports whether its key field holds a key", () => {
    const fieldRef = createRef<KeyField>();
    render(
      <KeyForm
        active
        disabled={false}
        fieldRef={fieldRef}
        save={async () => ({ restart: false })}
      />,
    );
    expect(fieldRef.current?.holdsKey()).toBe(false);
    type("Key", "fake-private-value");
    expect(fieldRef.current?.holdsKey()).toBe(true);
    fieldRef.current?.focus();
    expect(document.activeElement).toBe(field("Key"));
  });

  it("keeps iOS from capitalising or correcting names, addresses and headers", () => {
    render(<KeysSheet open keys={controller()} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "openai-compatible" },
    });
    const plain = (name: string) => {
      expect(field(name).getAttribute("autocapitalize"), name).toBe("none");
      expect(field(name).getAttribute("autocorrect"), name).toBe("off");
    };
    plain("Name");
    plain("Base URL");
    fireEvent.click(screen.getByRole("button", { name: "Web API" }));
    plain("Hosts");
    plain("Header");
  });

  it("returns focus to its opener after a click outside", () => {
    const onClose = vi.fn();
    const sheet = (open: boolean) => (
      <>
        <button type="button">Open keys</button>
        <KeysSheet open={open} keys={controller()} onClose={onClose} />
      </>
    );
    const view = render(sheet(false));
    const opener = screen.getByRole("button", { name: "Open keys" });
    opener.focus();
    view.rerender(sheet(true));
    expect(document.activeElement).not.toBe(opener);
    const scrim = view.container.querySelector(".scrim") as HTMLElement;
    fireEvent.pointerDown(scrim);
    // A pointer-down outside any control moves focus to the page body first.
    (document.activeElement as HTMLElement).blur();
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledOnce();
    view.rerender(sheet(false));
    expect(document.activeElement).toBe(opener);
  });

  it("names each remove button with its visible label", () => {
    render(<KeyList active disabled={false} keys={[weather]} remove={async () => {}} />);
    const remove = screen.getByRole("button", { name: "Remove weather" });
    expect(remove.textContent).toBe("Remove");
    fireEvent.click(remove);
    const confirm = screen.getByRole("button", { name: "Confirm remove weather" });
    expect(confirm.textContent).toBe("Confirm remove");
  });
});
