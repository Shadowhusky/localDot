// @vitest-environment jsdom
import type { ManualInput } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CellSummary } from "../cells/types.ts";
import { createApi } from "../lib/api.ts";
import { FakeWorker, fakeChromium, playInClient } from "../testing/fake-chromium.ts";
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
  vi.restoreAllMocks();
});
const stats = (sourceId: unknown) => ({
  type: "stats",
  sourceId,
  stats: { presented: 1, fps: 30, lastFrameAt: 1, width: 1280, height: 800 },
});
it.each(["cell", "api", "reconnect"] as const)(
  "rejects old displayed frames and late pump stats through a %s transition, then accepts the new owned frame",
  async (kind) => {
    const restore = fakeChromium();
    const pending = Promise.withResolvers<Response>();
    let requests = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      ++requests === 1 ? Response.json({ path: path(A) }) : pending.promise,
    );
    const api = createApi("fixture", { fetchImpl });
    const input = vi.fn<(id: string, command: ManualInput) => Promise<boolean>>(async () => true);
    const manual = {
      requestId: "takeover-a",
      enabled: true,
      screen: { w: 1280, h: 800 },
      button: "left" as const,
      count: 1 as const,
      input,
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
    const surface = screen.getByRole<HTMLButtonElement>("button", {
      name: "Click on the computer",
    });
    const frame = () => document.querySelector<HTMLIFrameElement>("iframe.desktop-frame");
    const click = () => fireEvent.click(surface, { detail: 1, clientX: 640, clientY: 400 });
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
      expect(input).toHaveBeenCalledWith("takeover-a", {
        kind: "click",
        at: { x: 640, y: 400 },
        button: "left",
        count: 1,
      });
      input.mockClear();
      const nextCell = kind === "cell" ? B : A;
      view.rerender(
        <Stage
          cell={cell(nextCell)}
          api={kind === "api" ? createApi("replacement", { fetchImpl }) : api}
          reconnects={kind === "reconnect" ? 1 : 0}
          listed={[A, B]}
          manual={{ ...manual, requestId: "takeover-b" }}
        />,
      );
      expect(surface.disabled).toBe(true);
      expect(frame()).toBeNull();
      click();
      fireEvent.keyDown(surface, { key: "ArrowLeft" });
      act(() => worker?.onmessage?.({ data: stats(oldId) }));
      expect(surface.disabled).toBe(true);
      expect(
        input,
        "an old displayed computer must never receive a replacement takeover's command",
      ).not.toHaveBeenCalled();
      await act(async () => pending.resolve(Response.json({ path: path(nextCell) })));
      await waitFor(() => expect(frame()).not.toBeNull());
      expect(surface.disabled).toBe(true);
      playInClient(frame() as HTMLIFrameElement, "track-b");
      await waitFor(() =>
        expect(worker?.sent.filter((row) => row.message.type === "frames")).toHaveLength(2),
      );
      const newId = worker?.sent.findLast((row) => row.message.type === "frames")?.message.sourceId;
      expect(newId).not.toBe(oldId);
      act(() => worker?.onmessage?.({ data: stats(oldId) }));
      click();
      expect(input).not.toHaveBeenCalled();
      act(() => worker?.onmessage?.({ data: stats(newId) }));
      expect(surface.disabled).toBe(false);
      click();
      expect(input).toHaveBeenCalledWith("takeover-b", {
        kind: "click",
        at: { x: 640, y: 400 },
        button: "left",
        count: 1,
      });
      expect(FakeWorker.instances).toHaveLength(1);
    } finally {
      view.unmount();
      await act(async () => pending.resolve(Response.json({ path: path(A) })));
      restore();
    }
  },
);
