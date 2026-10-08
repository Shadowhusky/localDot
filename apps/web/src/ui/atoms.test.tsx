// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Separator } from "./Separator.tsx";
import { Spinner } from "./Spinner.tsx";
import { VisuallyHidden } from "./VisuallyHidden.tsx";

afterEach(cleanup);

describe("Spinner", () => {
  it("is decoration inside a busy control and an image when it stands alone", () => {
    const { container } = render(
      <>
        <Spinner />
        <Spinner size={12} label="Loading recordings" />
      </>,
    );
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    const labelled = screen.getByRole("img", { name: "Loading recordings" });
    expect(labelled.getAttribute("width")).toBe("12");
  });
});

describe("Separator", () => {
  it("is a horizontal separator unless turned", () => {
    render(
      <>
        <Separator />
        <Separator orientation="vertical" />
      </>,
    );
    const [across, down] = screen.getAllByRole("separator");
    expect(across?.hasAttribute("aria-orientation")).toBe(false);
    expect(down?.getAttribute("aria-orientation")).toBe("vertical");
    expect(down?.dataset.orientation).toBe("vertical");
  });
});

describe("VisuallyHidden", () => {
  it("keeps its text for assistive technology", () => {
    render(
      <button type="button">
        <VisuallyHidden>Close settings</VisuallyHidden>
      </button>,
    );
    const text = screen.getByText("Close settings");
    expect(text.className).toBe("ui-visually-hidden");
    expect(screen.getByRole("button", { name: "Close settings" })).toBeTruthy();
  });
});
