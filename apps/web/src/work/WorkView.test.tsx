// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { disposition } from "../agent/file-transfer.ts";
import { createApi } from "../lib/api.ts";
import { WorkView } from "./WorkView.tsx";
import type { WorkCard } from "./work-view.ts";

const card: WorkCard = {
  key: "one",
  kind: "Command",
  title: "Run tests",
  text: "First output",
  shortened: false,
  status: "Working",
};
const sessionId = "00000000000000000000000001";
const fetchImpl = vi.fn(async () => new Response("missing", { status: 404 }));
const api = createApi("test-token", { origin: "https://localdot.test", fetchImpl });
beforeEach(() => {
  vi.useFakeTimers();
  fetchImpl.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const tick = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const props = { api, sessionId, enabled: true };
it("waits for a settled task, stays bounded under continuous output, and adds no API requests", async () => {
  const view = render(<WorkView {...props} candidate={card} />);
  expect(screen.queryByText("First output")).toBeNull();
  await tick(700);
  expect(screen.getByText("First output")).toBeTruthy();
  for (let i = 1; i <= 20; i++) {
    view.rerender(<WorkView {...props} candidate={{ ...card, text: `Chunk ${i}` }} />);
    await tick(100);
  }
  expect(screen.getByLabelText("Work output").textContent).toMatch(/Chunk 1[789]|Chunk 20/);
  expect(fetchImpl).not.toHaveBeenCalled();
});
// jsdom lays nothing out: the output is given room to scroll.
function scrollable(output: HTMLElement) {
  Object.defineProperty(output, "scrollHeight", { configurable: true, value: 900 });
  Object.defineProperty(output, "clientHeight", { configurable: true, value: 300 });
  return output;
}
const next = { ...card, key: "two", text: "Next" };
const followed = () => screen.queryByRole("button", { name: "Follow work" }) === null;

it("pins on reading, can follow again, and yields immediately during handover", async () => {
  const view = render(<WorkView {...props} candidate={card} />);
  await tick(700);
  fireEvent.wheel(scrollable(screen.getByLabelText("Work output")), { deltaY: 120 });
  view.rerender(<WorkView {...props} candidate={next} />);
  await tick(1000);
  expect(screen.getByText("First output")).toBeTruthy();
  view.rerender(<WorkView {...props} candidate={card} enabled={false} />);
  expect(screen.queryByLabelText("Work display")).toBeNull();
  view.rerender(<WorkView {...props} candidate={card} />);
  fireEvent.click(screen.getByRole("button", { name: "Follow work" }));
  view.rerender(<WorkView {...props} candidate={null} />);
  expect(screen.queryByLabelText("Work output")).toBeNull();
});
it("keeps following through a click, a tap, focus moves and a wheel with nothing to scroll", async () => {
  const view = render(<WorkView {...props} candidate={card} />);
  await tick(700);
  const output = screen.getByLabelText("Work output");
  fireEvent.pointerDown(output, {
    pointerId: 1,
    isPrimary: true,
    buttons: 1,
    clientX: 50,
    clientY: 50,
  });
  fireEvent.pointerMove(output, {
    pointerId: 1,
    isPrimary: true,
    buttons: 1,
    clientX: 53,
    clientY: 54,
  });
  fireEvent.pointerUp(output, { pointerId: 1, isPrimary: true, clientX: 53, clientY: 54 });
  fireEvent.click(output);
  fireEvent.pointerDown(output, {
    pointerId: 7,
    isPrimary: true,
    pointerType: "touch",
    buttons: 1,
  });
  fireEvent.pointerUp(output, { pointerId: 7, isPrimary: true, pointerType: "touch" });
  fireEvent.keyDown(output, { key: "Tab" });
  fireEvent.wheel(output, { deltaY: 120 });
  // A mouse that went up outside does not turn later movement into a drag.
  fireEvent.pointerDown(output, {
    pointerId: 1,
    isPrimary: true,
    buttons: 1,
    clientX: 50,
    clientY: 50,
  });
  fireEvent.pointerMove(output, {
    pointerId: 1,
    isPrimary: true,
    buttons: 0,
    clientX: 200,
    clientY: 50,
  });
  fireEvent.pointerMove(output, {
    pointerId: 1,
    isPrimary: true,
    buttons: 1,
    clientX: 300,
    clientY: 50,
  });
  expect(followed()).toBe(true);
  view.rerender(<WorkView {...props} candidate={next} />);
  await tick(700);
  expect(screen.getByText("Next")).toBeTruthy();
});

for (const [name, read] of [
  [
    "a drag across the output",
    (output: HTMLElement) => {
      fireEvent.pointerDown(output, {
        pointerId: 1,
        isPrimary: true,
        buttons: 1,
        clientX: 50,
        clientY: 50,
      });
      fireEvent.pointerMove(output, {
        pointerId: 1,
        isPrimary: true,
        buttons: 1,
        clientX: 50,
        clientY: 90,
      });
    },
  ],
  [
    "a pan the browser takes over",
    (output: HTMLElement) => {
      fireEvent.pointerDown(output, {
        pointerId: 3,
        isPrimary: true,
        pointerType: "touch",
        buttons: 1,
      });
      fireEvent.pointerCancel(output, { pointerId: 3, isPrimary: true, pointerType: "touch" });
    },
  ],
  [
    "a pinch",
    (output: HTMLElement) => {
      fireEvent.pointerDown(output, {
        pointerId: 3,
        isPrimary: true,
        pointerType: "touch",
        buttons: 1,
      });
      fireEvent.pointerDown(output, {
        pointerId: 4,
        isPrimary: false,
        pointerType: "touch",
        buttons: 1,
      });
    },
  ],
  ["a key that scrolls", (output: HTMLElement) => fireEvent.keyDown(output, { key: "PageDown" })],
  [
    "a scrollbar dragged under a still press",
    (output: HTMLElement) => {
      fireEvent.pointerDown(output, {
        pointerId: 1,
        isPrimary: true,
        buttons: 1,
        clientX: 50,
        clientY: 50,
      });
      fireEvent.scroll(output);
    },
  ],
] as const)
  it(`stops following on ${name}, until Follow work`, async () => {
    const view = render(<WorkView {...props} candidate={card} />);
    await tick(700);
    read(screen.getByLabelText("Work output"));
    view.rerender(<WorkView {...props} candidate={next} />);
    await tick(1000);
    expect(screen.getByText("First output")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Follow work" }));
    await tick(700);
    expect(screen.getByText("Next")).toBeTruthy();
  });

it("follows replay immediately without future text surviving a backwards seek", () => {
  const view = render(<WorkView {...props} candidate={card} replay />);
  expect(screen.getByText("First output")).toBeTruthy();
  view.rerender(<WorkView {...props} candidate={{ ...card, text: "Earlier output" }} replay />);
  expect(screen.queryByText("First output")).toBeNull();
  expect(screen.getByText("Earlier output")).toBeTruthy();
});
it("does not fetch previews when hidden or handed over", async () => {
  render(
    <WorkView
      {...props}
      candidate={{
        ...card,
        image: { name: "step-image-00000000000000000000000002.jpg", alt: "Preview" },
      }}
      enabled={false}
    />,
  );
  await tick(1000);
  expect(fetchImpl).not.toHaveBeenCalled();
});
it("caps previews, caches failures, and never retries a rejected large download", async () => {
  const name = "step-image-00000000000000000000000002.jpg";
  fetchImpl.mockResolvedValue(
    new Response(null, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": disposition(name),
        "x-content-type-options": "nosniff",
        "content-length": "999999999",
      },
    }),
  );
  const candidate = { ...card, image: { name, alt: "Preview" } };
  const view = render(<WorkView {...props} candidate={candidate} replay />);
  await tick(20);
  expect(screen.getByText(/Preview unavailable/)).toBeTruthy();
  view.rerender(<WorkView {...props} candidate={candidate} replay enabled={false} />);
  view.rerender(<WorkView {...props} candidate={candidate} replay />);
  await tick(20);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("pauses painting while the document is hidden and catches up when visible", async () => {
  const view = render(<WorkView {...props} candidate={card} />);
  await tick(700);
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  fireEvent(document, new Event("visibilitychange"));
  view.rerender(<WorkView {...props} candidate={{ ...card, text: "While hidden" }} />);
  await tick(1000);
  expect(screen.getByLabelText("Work output").textContent).toContain("First output");
  expect(screen.queryByText("While hidden")).toBeNull();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  fireEvent(document, new Event("visibilitychange"));
  await tick(700);
  expect(screen.getByText("While hidden")).toBeTruthy();
});

it("keeps preview transfers out of arbitrary URLs or file paths", async () => {
  render(
    <WorkView
      {...props}
      candidate={{ ...card, image: { name: "https://example.com/track.svg", alt: "External" } }}
      replay
    />,
  );
  await tick(20);
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(screen.getByText(/Preview unavailable/)).toBeTruthy();
});

it("does not starve the work view when quick background steps keep replacing each other", async () => {
  const view = render(<WorkView {...props} candidate={card} />);
  for (let n = 0; n < 12; n++) {
    view.rerender(
      <WorkView {...props} candidate={{ ...card, key: `step-${n}`, text: `Output ${n}` }} />,
    );
    await tick(100);
  }
  expect(screen.getByLabelText("Work output").textContent).toContain("Output");
});

it("restores work before lifting the curtain without waiting for a live-step timer", async () => {
  const view = render(<WorkView {...props} candidate={null} enabled={false} restoring />);
  // The complete candidate and curtain release may arrive in one render.
  view.rerender(<WorkView {...props} candidate={card} restoring={false} />);
  expect(screen.getByText("First output")).toBeTruthy();
  // Subsequent live switches still settle, preserving the bounded paint rate.
  view.rerender(<WorkView {...props} candidate={{ ...card, key: "two", text: "Next" }} />);
  expect(screen.queryByText("Next")).toBeNull();
  await tick(700);
  expect(screen.getByText("Next")).toBeTruthy();
  expect(fetchImpl).not.toHaveBeenCalled();
});
