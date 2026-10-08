// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Presence } from "./Presence.tsx";

afterEach(() => {
  cleanup();
  delete (Element.prototype as Partial<Element>).getAnimations;
});

function fading() {
  let finish = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const animation = {
    finished,
    effect: { getComputedTiming: () => ({ endTime: 180 }) },
  } as unknown as Animation;
  return { animation, finish };
}

it("holds what it shows, inert and leaving, until its exit has played, then unmounts it", async () => {
  const exit = fading();
  Element.prototype.getAnimations = vi.fn(() => [exit.animation]);
  const view = render(
    <Presence show>
      <button type="button">Turn on</button>
    </Presence>,
  );
  const root = screen.getByRole("button").parentElement as HTMLElement;
  expect(root.dataset.leaving).toBeUndefined();
  expect(root.hasAttribute("inert")).toBe(false);
  view.rerender(
    <Presence show={false}>
      <button type="button">Turn on</button>
    </Presence>,
  );
  expect(root.dataset.leaving).toBe("");
  expect(root.hasAttribute("inert")).toBe(true);
  expect(screen.queryByText("Turn on")).not.toBeNull();
  await act(async () => exit.finish());
  expect(screen.queryByText("Turn on")).toBeNull();
});

it("comes back at once when shown again while it leaves", () => {
  const exit = fading();
  Element.prototype.getAnimations = vi.fn(() => [exit.animation]);
  const view = render(<Presence show>dot</Presence>);
  view.rerender(<Presence show={false}>dot</Presence>);
  view.rerender(<Presence show>dot</Presence>);
  const root = screen.getByText("dot");
  expect(root.dataset.leaving).toBeUndefined();
  expect(root.hasAttribute("inert")).toBe(false);
});
