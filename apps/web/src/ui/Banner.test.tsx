// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Kit = typeof import("./Banner.tsx") & typeof import("./Announcer.tsx");
let kit: Kit;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.resetModules();
  kit = { ...(await import("./Banner.tsx")), ...(await import("./Announcer.tsx")) };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Panel({ open, announce = false }: { open: boolean; announce?: boolean }) {
  return (
    <>
      <kit.Announcer />
      <kit.Banner
        open={open}
        announce={announce}
        tone="danger"
        title="Couldn't save your settings"
        actions={<button type="button">Try again</button>}
      >
        Your changes are kept.
      </kit.Banner>
    </>
  );
}

describe("Banner", () => {
  it("shows a title, the detail and its actions, with an icon for a failure", () => {
    render(<Panel open />);
    expect(screen.getByText("Couldn't save your settings")).toBeTruthy();
    expect(screen.getByText("Your changes are kept.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(document.querySelector(".ui-banner .ui-icon")).not.toBeNull();
  });

  it("stays mounted while closed, out of reach, and opens as the same element", () => {
    const { rerender } = render(<Panel open />);
    const reveal = document.querySelector(".ui-banner-reveal") as HTMLElement;
    rerender(<Panel open={false} />);
    expect(document.querySelector(".ui-banner-reveal")).toBe(reveal);
    expect(reveal.hasAttribute("inert")).toBe(true);
    expect(reveal.hasAttribute("data-open")).toBe(false);
    rerender(<Panel open />);
    expect(document.querySelector(".ui-banner-reveal")).toBe(reveal);
    expect(reveal.hasAttribute("inert")).toBe(false);
  });

  it("reads itself out each time it opens, when asked to", () => {
    const { rerender } = render(<Panel open={false} announce />);
    expect(screen.getByRole("status").textContent).toBe("");
    rerender(<Panel open announce />);
    expect(screen.getByRole("status").textContent).toBe(
      "Couldn't save your settings. Your changes are kept.",
    );
  });

  it("stays quiet when it is part of the page from the start", () => {
    render(<Panel open />);
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("offers a dismiss button only when it can be dismissed", () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<kit.Banner title="Downloads couldn't be refreshed" />);
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    rerender(<kit.Banner title="Downloads couldn't be refreshed" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    act(() => {});
  });
});
