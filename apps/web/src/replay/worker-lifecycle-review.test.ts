import { buildPlaybackMap, emptyModel } from "@localdot/stage";
import { beforeEach, expect, it, vi } from "vitest";
import type { PixiPresenter } from "../stage/pixi-presenter.ts";
import type { ReplaySource, WorkerOut } from "../stage/worker-protocol.ts";
import { WorkerReplay } from "./worker-replay.ts";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  want: vi.fn(),
  videoClose: vi.fn(),
  backdrop: vi.fn(),
  backdropClose: vi.fn(),
}));
vi.mock("./replay-video.ts", () => ({ ReplayVideo: { open: mocks.open } }));
vi.mock("./backdrop.ts", () => ({
  ObserveBackdrop: class {
    frameAt = mocks.backdrop;
    close = mocks.backdropClose;
  },
}));
const source: ReplaySource = {
  sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  origin: "http://fixture.test",
  authorization: "Bearer fixture",
  video: { upto: null },
  gaps: [],
};
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const frame = (t: number) =>
  ({ timestamp: t * 1000, close: vi.fn(), clone: vi.fn() }) as unknown as VideoFrame & {
    close: ReturnType<typeof vi.fn>;
  };
function fixture(src = source) {
  const out: WorkerOut[] = [];
  const presented: number[] = [];
  const presenter = {
    clearVideo: vi.fn(),
    setScreen: vi.fn(),
    setCamera: vi.fn(),
    draw: vi.fn(),
    render: vi.fn(),
    present: vi.fn((f: VideoFrame) => {
      presented.push(f.timestamp);
      f.close();
    }),
  } as unknown as PixiPresenter;
  const model = emptyModel();
  model.screen = { w: 1280, h: 800, scale: 1 };
  const worker = new WorkerReplay(src, {
    presenter,
    model: () => model,
    view: () => ({ reducedMotion: true }),
    viewport: () => ({ w: 640, h: 400 }),
    post: (m) => out.push(m),
  });
  worker.transport({
    map: buildPlaybackMap(0, 10000, [], false),
    playing: false,
    speed: 1,
    atPlayMs: 0,
  });
  return { worker, out, presented, presenter };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.open.mockResolvedValue({
    firstMs: 0,
    lastMs: 10000,
    want: mocks.want,
    close: mocks.videoClose,
    stats: () => ({ openFrames: 0, decodeQueue: 0, seeks: 0, decoded: 0 }),
  });
});
it("disposes an obsolete decoded frame and publishes only the newest exact seek", async () => {
  const pending = Promise.withResolvers<VideoFrame>();
  const old = frame(1000),
    current = frame(7000);
  mocks.want.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(current);
  const f = fixture();
  await settle();
  f.worker.seek(1000, "exact");
  f.worker.tick();
  f.worker.seek(4000, "preview");
  f.worker.seek(7000, "exact");
  pending.resolve(old);
  await settle();
  expect(old.close).toHaveBeenCalledOnce();
  expect(f.presented).toEqual([]);
  f.worker.tick();
  await settle();
  expect(f.presented).toEqual([7000000]);
  expect(f.out.filter((m) => m.type === "replay-time")).toEqual([
    expect.objectContaining({ tMs: 7000, playing: false }),
  ]);
  expect(mocks.want.mock.calls).toEqual([
    [1000, "exact"],
    [7000, "exact"],
  ]);
  f.worker.close();
});
it("close fences a pending decoded frame without publishing replay time", async () => {
  const pending = Promise.withResolvers<VideoFrame>();
  const late = frame(4000);
  mocks.want.mockReturnValue(pending.promise);
  const f = fixture();
  await settle();
  f.worker.seek(4000, "exact");
  f.worker.tick();
  f.worker.close();
  pending.resolve(late);
  await settle();
  expect(late.close).toHaveBeenCalledOnce();
  expect(f.presented).toEqual([]);
  expect(f.out.some((m) => m.type === "replay-time")).toBe(false);
  expect(mocks.videoClose).toHaveBeenCalledOnce();
});
it("close disposes a late open and suppresses its ready publication", async () => {
  const opening = Promise.withResolvers<unknown>();
  mocks.open.mockReturnValue(opening.promise);
  const f = fixture();
  f.worker.close();
  opening.resolve({ firstMs: 0, lastMs: 10000, want: mocks.want, close: mocks.videoClose });
  await settle();
  expect(mocks.videoClose).toHaveBeenCalledOnce();
  expect(f.out.filter((m) => m.type === "replay-status")).toEqual([
    { type: "replay-status", status: { state: "loading" } },
  ]);
});
it("renderer failure closes caller-owned frame and falls back without leaking it", async () => {
  const owned = frame(1000);
  mocks.want.mockResolvedValue(owned);
  const f = fixture();
  vi.mocked(f.presenter.present).mockImplementation(() => {
    throw new Error("synthetic presenter failure");
  });
  await settle();
  f.worker.seek(1000, "exact");
  f.worker.tick();
  await settle();
  expect(owned.close).toHaveBeenCalledOnce();
  expect(mocks.videoClose).toHaveBeenCalledOnce();
  expect(f.out).toContainEqual({
    type: "replay-status",
    status: { state: "error", message: "Replay media is unavailable at this step." },
  });
  f.worker.close();
});
