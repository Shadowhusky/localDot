// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopBar } from "../shell/TopBar.tsx";
import { KeyForm } from "./KeyForm.tsx";
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
    fireEvent.click(screen.getByRole("button", { name: "Delete weather" }));
    // A suspended tab can resume with an expired deadline before its queued timeout executes.
    now = 5000;
    fireEvent.click(screen.getByRole("button", { name: "Confirm deleting weather" }));
    expect(remove).not.toHaveBeenCalled();
    await act(async () => {});
  });

  it("requires fresh confirmation when a key with the same name has been replaced", () => {
    const remove = vi.fn(async () => {});
    const { rerender } = render(
      <KeyList active disabled={false} keys={[weather]} remove={remove} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete weather" }));
    rerender(
      <KeyList
        active
        disabled={false}
        keys={[{ ...weather, hosts: ["new.weather.example"], updatedAt: "new" }]}
        remove={remove}
      />,
    );
    expect(screen.queryByRole("button", { name: "Confirm deleting weather" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete weather" }));
    expect(remove).not.toHaveBeenCalled();
  });

  it("deletes once when confirmation presses arrive before the controls disable", async () => {
    const pending = Promise.withResolvers<void>();
    const remove = vi.fn(() => pending.promise);
    render(<KeyList active disabled={false} keys={[weather]} remove={remove} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete weather" }));
    const button = screen.getByRole("button", {
      name: "Confirm deleting weather",
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
      fireEvent.click(screen.getByRole("button", { name: "Delete weather" }));
      const button = screen.getByRole("button", {
        name: "Confirm deleting weather",
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
    fireEvent.click(screen.getByRole("button", { name: "Delete weather" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete weather" }));
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
    expect(screen.getByRole("status").textContent).toBe("Saved weather.");
  });

  it("expires deletion confirmation and clears it on close or offline transition", () => {
    vi.useFakeTimers();
    const remove = vi.fn(async () => {});
    const keys = controller({ remove, keys: [weather] });
    const { rerender } = render(<KeysSheet open keys={keys} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete weather" }));
    act(() => vi.advanceTimersByTime(4000));
    expect(screen.queryByRole("button", { name: "Confirm deleting weather" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete weather" }));
    rerender(<KeysSheet open={false} keys={keys} onClose={() => {}} />);
    rerender(<KeysSheet open keys={keys} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Confirm deleting weather" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete weather" }));
    rerender(<KeysSheet open keys={{ ...keys, health: { online: false } }} onClose={() => {}} />);
    rerender(<KeysSheet open keys={keys} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete weather" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Delete weather" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm deleting weather" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete weather" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Delete weather" }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm deleting weather" }));
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

  it("closes on Escape and on the scrim, and is inert while closed", () => {
    const onClose = vi.fn();
    const { container, rerender } = render(
      <KeysSheet open keys={controller()} onClose={onClose} />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerDown(container.querySelector(".scrim") as Element);
    expect(onClose).toHaveBeenCalledTimes(2);
    rerender(<KeysSheet open={false} keys={controller()} onClose={onClose} />);
    expect(container.querySelector(".sheet")?.hasAttribute("inert")).toBe(true);
  });
});
