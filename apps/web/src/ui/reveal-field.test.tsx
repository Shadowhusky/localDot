// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Field } from "./Field.tsx";
import { revealInvalid, useRevealInvalid } from "./reveal-field.ts";
import { TextField } from "./TextField.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

// A scrolling box 100 tall whose content is 1000 tall, with a field whose top is `top` down it.
function scrolling(top: number, height = 40, padding = { top: 0, bottom: 0 }) {
  const box = document.createElement("div");
  box.style.overflowY = "auto";
  box.style.scrollPaddingTop = `${padding.top}px`;
  box.style.scrollPaddingBottom = `${padding.bottom}px`;
  Object.defineProperties(box, {
    scrollHeight: { value: 1000 },
    clientHeight: { value: 100 },
  });
  box.getBoundingClientRect = () => ({ top: 0, bottom: 100 }) as DOMRect;
  const input = document.createElement("input");
  input.setAttribute("aria-invalid", "true");
  input.getBoundingClientRect = () => {
    const at = top - box.scrollTop;
    return { top: at, bottom: at + height, height } as DOMRect;
  };
  box.append(input);
  document.body.append(box);
  return { box, input };
}

describe("revealInvalid", () => {
  it("scrolls what holds the field just far enough, focuses it and lights it", () => {
    const { box, input } = scrolling(500);
    expect(revealInvalid(box)).toBe(input);
    expect(box.scrollTop).toBe(500 + 40 - (100 - 16));
    expect(document.activeElement).toBe(input);
    expect(input.hasAttribute("data-reveal")).toBe(true);
    input.dispatchEvent(new Event("animationend"));
    expect(input.hasAttribute("data-reveal")).toBe(false);
  });

  it("leaves the scroll alone for a field already in view", () => {
    const { box } = scrolling(30);
    revealInvalid(box);
    expect(box.scrollTop).toBe(0);
  });

  it("shows the top of a field too tall for the room", () => {
    const { box } = scrolling(500, 200);
    revealInvalid(box);
    expect(box.scrollTop).toBe(500 - 16);
  });

  it("keeps clear of what is stuck over the scroller's edges", () => {
    const above = scrolling(10, 40, { top: 40, bottom: 0 });
    above.box.scrollTop = 100;
    revealInvalid(above.box);
    expect(above.box.scrollTop).toBe(10 - (40 + 16));
    const below = scrolling(500, 20, { top: 0, bottom: 30 });
    revealInvalid(below.box);
    expect(below.box.scrollTop).toBe(500 + 20 - (100 - 30 - 16));
  });

  it("keeps clear of an on-screen keyboard, also one that comes after the focus", () => {
    const listeners: (() => void)[] = [];
    const viewport = {
      offsetTop: 0,
      height: 1000,
      addEventListener: (_: string, listener: () => void) => listeners.push(listener),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("visualViewport", viewport);
    const { box } = scrolling(30, 20);
    revealInvalid(box);
    expect(box.scrollTop).toBe(0);
    viewport.height = 60;
    for (const listener of listeners) listener();
    expect(box.scrollTop).toBe(30 + 20 - (60 - 16));
  });

  it("passes over hidden parts and falls back as asked, and needs a scope", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<div hidden><input aria-invalid="true"></div><button id="add">Add</button><input id="next">';
    document.body.append(root);
    expect(revealInvalid(root, "input:not([aria-invalid])")?.id).toBe("next");
    expect(revealInvalid(root, "button")?.id).toBe("add");
    expect(revealInvalid(root)).toBeNull();
    expect(revealInvalid(null)).toBeNull();
  });
});

function Form() {
  const { scope, reveal } = useRevealInvalid<HTMLFormElement>();
  const [tried, setTried] = useState(false);
  return (
    <form
      ref={scope}
      onSubmit={(event) => {
        event.preventDefault();
        setTried(true);
        reveal();
      }}
    >
      <Field label="First">
        <TextField />
      </Field>
      <Field label="Name" {...(tried ? { error: "Give it a name." } : {})}>
        <TextField />
      </Field>
      <button type="submit">Save</button>
    </form>
  );
}

describe("useRevealInvalid", () => {
  it("reveals the error the same attempt drew, with its message", () => {
    render(<Form />);
    act(() => screen.getByRole("button", { name: "Save" }).click());
    const name = screen.getByRole("textbox", { name: "Name" });
    expect(document.activeElement).toBe(name);
    expect(name.closest(".ui-field-box")?.hasAttribute("data-reveal")).toBe(true);
    expect(screen.getByText("Give it a name.")).toBeTruthy();
  });
});
