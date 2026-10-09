import { afterEach, expect, it, vi } from "vitest";
import type { FieldMark, WorkerIn } from "./worker-protocol.ts";

const setFields = vi.fn();
vi.mock("./pixi-presenter.ts", () => ({
  PixiPresenter: { create: async () => ({ overlays: { setFields }, setDim() {} }) },
}));

afterEach(() => vi.unstubAllGlobals());

it("rings the fields dot will fill on the screen shown, and none once the question closes", async () => {
  const scope: { onmessage: ((e: { data: WorkerIn }) => void) | null; postMessage(): void } = {
    onmessage: null,
    postMessage: () => {},
  };
  vi.stubGlobal("self", scope);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  await import("./render-worker.ts");
  const send = (data: WorkerIn) => scope.onmessage?.({ data });
  const desktop: FieldMark = { screen: "desktop", point: { x: 800, y: 600 } };
  const browser: FieldMark = {
    screen: "browser",
    point: { x: 400, y: 300 },
    bbox: { x: 320, y: 280, w: 160, h: 40 },
  };
  send({
    type: "init",
    canvas: {} as OffscreenCanvas,
    width: 1,
    height: 1,
    dpr: 1,
    theme: {} as never,
    reducedMotion: false,
  });
  send({ type: "view", view: { fields: [desktop, browser] } });
  await vi.waitFor(() => expect(setFields).toHaveBeenLastCalledWith([desktop], false));
  send({
    type: "view",
    view: {
      selection: {
        screen: "browser",
        cellId: "01JXYZ00000000000000000003",
        revision: 1,
        geometry: { w: 1280, h: 800, scale: 1 },
      } as never,
    },
  });
  await vi.waitFor(() => expect(setFields).toHaveBeenLastCalledWith([browser], false));
  send({ type: "view", view: { fields: [] } });
  await vi.waitFor(() => expect(setFields).toHaveBeenLastCalledWith([], false));
});
