// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileButton } from "./FileButton.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("FileButton", () => {
  it("opens the system chooser from its button, never drawing the file input", () => {
    const onFiles = vi.fn();
    const view = render(
      <FileButton label="Attach files" icon="paperclip" multiple onFiles={onFiles} />,
    );
    const input = view.container.querySelector("input[type=file]") as HTMLInputElement;
    expect(input.hidden).toBe(true);
    expect(input.tabIndex).toBe(-1);
    expect(input.multiple).toBe(true);
    const opened = vi.spyOn(input, "click").mockImplementation(() => {});
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    expect(opened).toHaveBeenCalledOnce();
    const file = new File(["x"], "one.txt");
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFiles).toHaveBeenCalledOnce();
    expect([...(onFiles.mock.calls[0]?.[0] ?? [])]).toEqual([file]);
  });

  it("stays shut while unavailable and says why", () => {
    const view = render(
      <FileButton
        label="Attach files"
        icon="paperclip"
        onFiles={vi.fn()}
        disabledReason="Turn on your computer first."
      />,
    );
    const input = view.container.querySelector("input[type=file]") as HTMLInputElement;
    const opened = vi.spyOn(input, "click").mockImplementation(() => {});
    const button = screen.getByRole("button", { name: "Attach files" });
    fireEvent.click(button);
    expect(opened).not.toHaveBeenCalled();
    expect(button.getAttribute("aria-disabled")).toBe("true");
  });
});
