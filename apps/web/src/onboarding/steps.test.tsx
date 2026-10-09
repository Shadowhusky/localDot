// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { KeyStep } from "./steps.tsx";

afterEach(cleanup);

const step = (unavailable?: string) => (
  <KeyStep
    kind="api"
    provider="anthropic"
    onProvider={vi.fn()}
    models={[]}
    secret={createRef<HTMLInputElement>()}
    saved={null}
    unavailable={unavailable}
    onTyped={vi.fn()}
  />
);

it("shows the command that turns key protection back on while it is off", () => {
  const view = render(step("Key protection is off. To turn it back on, run this in Terminal:"));
  expect(screen.getByText(/To turn it back on, run this in Terminal/)).toBeTruthy();
  expect(screen.getByText("localdot doctor")).toBeTruthy();
  view.rerender(step());
  expect(screen.queryByText("localdot doctor")).toBeNull();
});
