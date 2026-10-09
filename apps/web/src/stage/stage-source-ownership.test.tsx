// @vitest-environment jsdom
import type { ManualStreamInput } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CellSummary } from "../cells/types.ts";
import { createApi } from "../lib/api.ts";
import { FakeWorker, fakeChromium, playInClient } from "../testing/fake-chromium.ts";
import { closeStreams } from "./live-stream.ts";
import { Stage } from "./Stage.tsx";

const A = "01JXYZ0000000000000000AAAA",
  B = "01JXYZ0000000000000000BBBB";
const path = (id: string) => `/cells/${id}/desktop/${"T".repeat(22)}/`;
const cell = (id: string): CellSummary => ({
  id,
  state: "ready",
  scale: 1,
  createdAt: "",
  stream: { connection: "live", viewers: 1, lastUpstreamAt: 1 },
});
afterEach(() => {
  cleanup();
  closeStreams();
  vi.restoreAllMocks();
});
const stats = (sourceId: unknown) => ({
  type: "stats",
  sourceId,
  stats: { presented: 1, fps: 30, lastFrameAt: 1, width: 1280, height: 800 },
});
it.each(["cell", "api"] as const)(
  "rejects old displayed frames and late pump stats through a %s transition, then accepts the new owned frame",
  async (kind) => {
    const restore = fakeChromium();
    const pending = Promise.withResolvers<Response>();
    let requests = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      ++requests === 1 ? Response.json({ path: path(A) }) : pending.promise,
    );
    const api = createApi("fixture", { fetchImpl });
    const input = vi.fn<(command: ManualStreamInput) => void>();
    const replacement = vi.fn<(command: ManualStreamInput) => void>();
    const manual = {
      enabled: true,
      screen: { w: 1280, h: 800 },
      pointer: "click" as const,
      send: input,
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 1280,
      height: 800,
      right: 1280,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const view = render(
      <Stage cell={cell(A)} api={api} reconnects={0} listed={[A, B]} manual={manual} />,
    );
    const surface = document.querySelector(".manual-surface") as HTMLElement;
    const keys = screen.getByLabelText<HTMLTextAreaElement>("Type on the computer");
    const live = () => surface.hasAttribute("data-live") && !keys.readOnly;
    // The newest client: the old owner's stays a minute, in case its stage comes back.
    const frames = () => [...document.querySelectorAll<HTMLIFrameElement>("iframe.desktop-frame")];
    const frame = () => frames().at(-1) ?? null;
    const click = () => {
      const at = { pointerId: 1, pointerType: "mouse", button: 0, clientX: 640, clientY: 400 };
      fireEvent.pointerDown(surface, at);
      fireEvent.pointerUp(surface, at);
    };
    try {
      await waitFor(() => expect(frame()).not.toBeNull());
      click();
      expect(input).not.toHaveBeenCalled(); // Ticket alone does not establish displayed-frame ownership.
      playInClient(frame() as HTMLIFrameElement, "track-a");
      await waitFor(() =>
        expect(FakeWorker.instances[0]?.sent.some((row) => row.message.type === "frames")).toBe(
          true,
        ),
      );
      const worker = FakeWorker.instances[0];
      const oldId = worker?.sent.findLast((row) => row.message.type === "frames")?.message.sourceId;
      act(() => worker?.onmessage?.({ data: stats(oldId) }));
      click();
      expect(input.mock.calls).toEqual([
        [{ kind: "down", at: { x: 640, y: 400 }, button: "left" }],
        [{ kind: "up", at: { x: 640, y: 400 }, button: "left" }],
      ]);
      input.mockClear();
      const nextCell = kind === "cell" ? B : A;
      const old = frame();
      view.rerender(
        <Stage
          cell={cell(nextCell)}
          api={kind === "api" ? createApi("replacement", { fetchImpl }) : api}
          reconnects={0}
          listed={[A, B]}
          manual={{ ...manual, send: replacement }}
        />,
      );
      expect(live()).toBe(false);
      expect(frames()).toHaveLength(1);
      expect(frame()).toBe(old);
      click();
      fireEvent.keyDown(keys, { key: "ArrowLeft" });
      act(() => worker?.onmessage?.({ data: stats(oldId) }));
      expect(live()).toBe(false);
      expect(
        [...input.mock.calls, ...replacement.mock.calls],
        "an old displayed computer must never receive a replacement takeover's command",
      ).toEqual([]);
      await act(async () => pending.resolve(Response.json({ path: path(nextCell) })));
      await waitFor(() => expect(frames()).toHaveLength(2));
      expect(live()).toBe(false);
      playInClient(frame() as HTMLIFrameElement, "track-b");
      await waitFor(() =>
        expect(worker?.sent.filter((row) => row.message.type === "frames")).toHaveLength(2),
      );
      const newId = worker?.sent.findLast((row) => row.message.type === "frames")?.message.sourceId;
      expect(newId).not.toBe(oldId);
      act(() => worker?.onmessage?.({ data: stats(oldId) }));
      click();
      expect(replacement).not.toHaveBeenCalled();
      act(() => worker?.onmessage?.({ data: stats(newId) }));
      expect(live()).toBe(true);
      click();
      expect(input).not.toHaveBeenCalled();
      expect(replacement.mock.calls).toEqual([
        [{ kind: "down", at: { x: 640, y: 400 }, button: "left" }],
        [{ kind: "up", at: { x: 640, y: 400 }, button: "left" }],
      ]);
      expect(FakeWorker.instances).toHaveLength(1);
    } finally {
      view.unmount();
      await act(async () => pending.resolve(Response.json({ path: path(A) })));
      restore();
    }
  },
);

it("keeps the shown computer under the user's hand through a status socket reconnect", async () => {
  const restore = fakeChromium();
  let requests = 0;
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    requests++;
    return Response.json({ path: path(A) });
  });
  const api = createApi("fixture", { fetchImpl });
  const input = vi.fn<(command: ManualStreamInput) => void>();
  const manual = {
    enabled: true,
    screen: { w: 1280, h: 800 },
    pointer: "click" as const,
    send: input,
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 1280,
    height: 800,
    right: 1280,
    bottom: 800,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  const view = render(
    <Stage cell={cell(A)} api={api} reconnects={0} listed={[A]} manual={manual} />,
  );
  const surface = document.querySelector(".manual-surface") as HTMLElement;
  const live = () => surface.hasAttribute("data-live");
  const frame = () => document.querySelector<HTMLIFrameElement>("iframe.desktop-frame");
  try {
    await waitFor(() => expect(frame()).not.toBeNull());
    const before = frame();
    playInClient(before as HTMLIFrameElement, "track-a");
    await waitFor(() =>
      expect(FakeWorker.instances[0]?.sent.some((row) => row.message.type === "frames")).toBe(true),
    );
    const worker = FakeWorker.instances[0];
    const id = worker?.sent.findLast((row) => row.message.type === "frames")?.message.sourceId;
    act(() => worker?.onmessage?.({ data: stats(id) }));
    expect(live()).toBe(true);
    view.rerender(<Stage cell={cell(A)} api={api} reconnects={1} listed={[A]} manual={manual} />);
    await waitFor(() => expect(requests).toBe(2));
    expect(live()).toBe(true);
    expect(frame()).toBe(before);
    const at = { pointerId: 1, pointerType: "mouse", button: 0, clientX: 640, clientY: 400 };
    fireEvent.pointerDown(surface, at);
    fireEvent.pointerUp(surface, at);
    expect(input).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
    restore();
  }
});
