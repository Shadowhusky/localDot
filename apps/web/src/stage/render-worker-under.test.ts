import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkerIn, WorkerOut } from "./worker-protocol.ts";

const state = vi.hoisted(() => ({
  main: [] as unknown[],
  under: [] as unknown[],
  cameras: [] as unknown[],
  desktopCameras: [] as unknown[],
  scenes: [] as unknown[],
  composites: [] as unknown[],
}));
vi.mock("./pixi-presenter.ts", () => ({
  PixiPresenter: {
    create: async () => ({
      presented: 7,
      fps: 30,
      frameSize: { w: 2560, h: 1600 },
      hasFrame: true,
      under: {
        presented: 3,
        fps: 2,
        present(frame: unknown) {
          state.under.push(frame);
        },
      },
      fades: () => [255],
      present(frame: unknown) {
        state.main.push(frame);
      },
      setComposite(composite: unknown) {
        state.composites.push(composite);
      },
      overlays: { setFields() {} },
      setScreen() {},
      setCamera(cam: unknown) {
        state.cameras.push(cam);
      },
      setDesktopCamera(cam: unknown) {
        state.desktopCameras.push(cam);
      },
      setDim() {},
      draw(scene: unknown) {
        state.scenes.push(scene);
      },
      render() {},
    }),
  },
}));

beforeEach(() => {
  for (const list of Object.values(state)) list.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function worker() {
  const posted: WorkerOut[] = [];
  const scope: {
    onmessage: ((e: { data: WorkerIn }) => void) | null;
    postMessage(m: WorkerOut): void;
  } = { onmessage: null, postMessage: (message) => posted.push(message) };
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("self", scope);
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => frames.push(fn));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  await import("./render-worker.ts");
  const send = (data: WorkerIn) => {
    scope.onmessage?.({ data });
    return new Promise((done) => setImmediate(done));
  };
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const tick = () => {
    now += 100;
    for (const fn of frames.splice(0)) fn(now);
  };
  await send({
    type: "init",
    canvas: {} as OffscreenCanvas,
    width: 1280,
    height: 800,
    dpr: 1,
    theme: {} as never,
    reducedMotion: false,
  });
  return { posted, send, tick };
}

function readable() {
  let feed: ReadableStreamDefaultController<unknown> | undefined;
  const stream = new ReadableStream<VideoFrame>({
    start(controller) {
      feed = controller as ReadableStreamDefaultController<unknown>;
    },
  });
  return { stream, enqueue: (frame: unknown) => feed?.enqueue(frame) };
}
const videoFrame = () => ({ displayWidth: 2560, displayHeight: 1600, close: () => {} });
const COMPOSITE = { front: "browser" as const, desktop: { w: 2560, h: 1600 } };

it("pumps each source to its own picture, and reports each by its own source", async () => {
  const { posted, send, tick } = await worker();
  await send({ type: "view", view: { composite: COMPOSITE } });
  expect(state.composites).toEqual([COMPOSITE]);
  const browser = readable();
  const desktop = readable();
  await send({ type: "frames", sourceId: 1, readable: browser.stream });
  await send({ type: "frames", sourceId: 1, readable: desktop.stream, under: true });
  const a = videoFrame();
  const b = videoFrame();
  browser.enqueue(a);
  desktop.enqueue(b);
  await vi.waitFor(() => expect(state.main).toEqual([a]));
  await vi.waitFor(() => expect(state.under).toEqual([b]));
  tick();
  tick();
  await vi.waitFor(() =>
    expect(posted.filter((m) => m.type === "stats")).toEqual([
      expect.objectContaining({ sourceId: 1, stats: expect.objectContaining({ presented: 7 }) }),
      expect.objectContaining({
        under: true,
        sourceId: 1,
        stats: expect.objectContaining({ presented: 3 }),
      }),
    ]),
  );
});

it("stops the source it is told to, leaving the other's frames coming", async () => {
  const { send } = await worker();
  const browser = readable();
  const desktop = readable();
  await send({ type: "frames", sourceId: 1, readable: browser.stream });
  await send({ type: "frames", sourceId: 2, readable: desktop.stream, under: true });
  await send({ type: "stop", under: true });
  const a = videoFrame();
  browser.enqueue(a);
  await vi.waitFor(() => expect(state.main).toEqual([a]));
  expect(state.under).toEqual([]);
});

it("draws the browser's marks through its window, and a covered screen's not at all", async () => {
  const { send, tick } = await worker();
  await send({ type: "view", view: { composite: COMPOSITE } });
  await send({ type: "clock", clock: { offsetMicros: 0, originMicros: 0 } });
  await send({
    type: "view",
    view: {
      selection: {
        screen: "browser",
        cellId: "01JXYZ0000000000000000BBBB",
        geometry: { w: 2560, h: 1600, scale: 2 },
        revision: 1,
      },
    },
  });
  tick();
  tick();
  const camera = state.cameras.at(-1) as { scale: number; ty: number };
  const desktop = state.desktopCameras.at(-1) as { scale: number; ty: number };
  expect(desktop.scale).toBeCloseTo(0.5);
  expect(camera.scale).toBeCloseTo(0.5 * (1552 / 1600));
  expect(camera.ty).toBeCloseTo(24);
  expect(state.scenes.at(-1)).not.toBeNull();
  await send({ type: "view", view: { composite: { ...COMPOSITE, front: "desktop" } } });
  tick();
  tick();
  // dot is on the browser and the user has the desktop in front.
  expect(state.scenes.at(-1)).toBeNull();
});
