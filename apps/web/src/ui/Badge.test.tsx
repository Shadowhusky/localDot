// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Badge } from "./Badge.tsx";

afterEach(cleanup);

describe("Badge", () => {
  it("gives a dot a name, since a dot alone says nothing", () => {
    render(<Badge kind="dot" tone="attention" label="Needs you" />);
    const dot = screen.getByRole("img", { name: "Needs you" });
    expect([dot.dataset.kind, dot.dataset.tone]).toEqual(["dot", "attention"]);
    expect(dot.textContent).toBe("");
  });

  it("shows a count and can read it in words", () => {
    render(
      <>
        <Badge kind="count">{3}</Badge>
        <Badge kind="count" tone="danger" label="120 failed">
          {120}
        </Badge>
      </>,
    );
    const [plain, labelled] = document.querySelectorAll<HTMLElement>(".ui-badge");
    expect(plain?.textContent).toBe("3");
    expect(plain?.dataset.tone).toBe("neutral");
    expect(labelled?.querySelector("[aria-hidden='true']")?.textContent).toBe("99+");
    expect(labelled?.querySelector(".ui-visually-hidden")?.textContent).toBe("120 failed");
  });

  it("is a quiet text chip by default", () => {
    render(<Badge>Built-in</Badge>);
    const chip = screen.getByText("Built-in");
    expect([chip.dataset.kind, chip.dataset.tone]).toEqual(["label", "neutral"]);
  });
});
