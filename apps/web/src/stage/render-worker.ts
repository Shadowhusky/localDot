import "@localdot/protocol/csp";
import {
  type Camera,
  cameraFor,
  emptyModel,
  foldEvents,
  type Scene,
  type SessionModel,
  sceneAt,
  type View,
} from "@localdot/stage";
import { sessionMsAt } from "../session/clock-sync.ts";
import { OracleCapture } from "./oracle.ts";
import { PixiPresenter } from "./pixi-presenter.ts";
import { meanLuma, type ProbeRect, wallNow } from "./probe.ts";
import { type Presenter, type PumpStats, pumpFrames } from "./pump.ts";
import type { StageClock, WorkerIn, WorkerOut } from "./worker-protocol.ts";

const scope = self as unknown as {
  postMessage(message: WorkerOut, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
};

let presenter: PixiPresenter | undefined;
let pump: { stop(): Promise<void> } | undefined;
let sourceGeneration = 0;
let pendingStats: { generation: number; sourceId?: number; stats: PumpStats } | undefined;
let probe: { rect: ProbeRect; threshold: number; last: boolean | null } | null = null;
let model: SessionModel = emptyModel();
let view: View = { reducedMotion: false };
let zoom = 1;
let freeze = false;
let frozenT: number | null = null;
let clock: StageClock | null = null;
let viewport = { w: 1, h: 1 };
let lastScene: Scene | null = null;
const oracle = new OracleCapture();
let animationFrame: number | null = null;

function scheduleTick(): void {
  if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  animationFrame = requestAnimationFrame(tick);
}

function sessionNow(): number | null {
  if (!clock) return null;
  return sessionMsAt(wallNow(), clock);
}

function screenNow(): { w: number; h: number } {
  return model.screen ?? presenter?.frameSize ?? { w: 1280, h: 800 };
}

function probing(inner: Presenter): Presenter {
  return {
    present(frame) {
      const at = wallNow();
      const p = probe;
      const presented = (presenter?.presented ?? 0) + 1;
      if (p) {
        // copyTo is async and the presenter closes the frame, so the probe reads a clone.
        const copy = frame.clone();
        void meanLuma(copy, p.rect)
          .then((luma) => {
            if (probe !== p) return;
            const bright = luma > p.threshold;
            if (p.last !== null && bright !== p.last)
              scope.postMessage({ type: "flip", flip: { at, luma, bright, presented } });
            p.last = bright;
          })
          .catch(report)
          .finally(() => copy.close());
      }
      // Every frame: Task 16's oracle ignores it while off and, only while on, keeps a clone of
      // the newest one (P3-C12).
      oracle.onFrame(frame, at, presented);
      inner.present(frame);
    },
  };
}

function tick(): void {
  animationFrame = null;
  if (presenter) {
    const screen = screenNow();
    presenter.setScreen(model.screen ? { w: model.screen.w, h: model.screen.h } : null);
    // A frozen stage keeps the time it froze at; overlays never animate over a dead picture.
    if (freeze) frozenT ??= sessionNow();
    else frozenT = null;
    const t = freeze ? frozenT : sessionNow();
    const focus = lastScene?.cursor?.visible
      ? { x: lastScene.cursor.x, y: lastScene.cursor.y }
      : undefined;
    const cam: Camera = cameraFor({
      stageW: viewport.w,
      stageH: viewport.h,
      desktopW: screen.w,
      desktopH: screen.h,
      zoom,
      focus,
    });
    presenter.setCamera(cam);
    const scene = t === null ? null : sceneAt(model, t, view);
    lastScene = scene;
    presenter.draw(scene);
    try {
      presenter.render();
      // Uploading a texture does not make it visible. Manual admission acknowledges only
      // a successful canvas render, and a retired pump cannot publish its pending stats.
      if (pendingStats?.generation === sourceGeneration) {
        scope.postMessage({
          type: "stats",
          sourceId: pendingStats.sourceId,
          stats: pendingStats.stats,
        });
        pendingStats = undefined;
      }
      if (oracle.enabled && t !== null)
        oracle.onTick(presenter, model, t, scene, cam, viewport, screen);
    } catch (err) {
      report(err);
    }
  }
  animationFrame = requestAnimationFrame(tick);
}

let queue = Promise.resolve();
scope.onmessage = (e) => {
  queue = queue.then(() => handle(e.data));
};
async function handle(m: WorkerIn): Promise<void> {
  try {
    switch (m.type) {
      case "init": {
        viewport = { w: m.width, h: m.height };
        view = { reducedMotion: m.reducedMotion };
        presenter = await PixiPresenter.create(m.canvas, {
          width: m.width,
          height: m.height,
          dpr: m.dpr,
          theme: m.theme,
          warn: (message) => scope.postMessage({ type: "warn", message }),
        });
        oracle.dpr = m.dpr;
        scheduleTick();
        return;
      }
      case "resize":
        viewport = { w: m.width, h: m.height };
        presenter?.setViewport(m.width, m.height);
        return;
      case "probe":
        probe = m.rect ? { rect: m.rect, threshold: m.threshold, last: null } : null;
        return;
      case "events": {
        model = foldEvents(model, m.events);
        // Task 16: a window already open when its intent arrives (an Instant click) gets its
        // baseline now, not a tick later, so the press's frame cannot replace the kept one first.
        const t = freeze ? frozenT : sessionNow();
        if (oracle.enabled && t !== null) oracle.onModel(model, t, screenNow());
        return;
      }
      case "session-reset":
        model = emptyModel();
        lastScene = null;
        clock = null;
        oracle.clock = null;
        return;
      case "clock":
        clock = m.clock;
        oracle.clock = m.clock;
        return;
      case "view":
        if (m.view.zoom !== undefined) zoom = m.view.zoom;
        if (m.view.freeze !== undefined) freeze = m.view.freeze;
        if (m.view.reducedMotion !== undefined) view = { reducedMotion: m.view.reducedMotion };
        scheduleTick();
        return;
      case "theme":
        presenter?.overlays.setTheme(m.theme);
        return;
      case "oracle": {
        const reply = presenter
          ? await oracle.handle(m.command, presenter, model, view)
          : { error: "no presenter" };
        scope.postMessage({ type: "oracle-reply", id: m.command.id, reply });
        return;
      }
      case "stop":
      case "frames": {
        const generation = ++sourceGeneration;
        pendingStats = undefined;
        await pump?.stop();
        pump = undefined;
        oracle.dispose();
        if (m.type === "frames") {
          if (!presenter) {
            m.first?.close();
            await m.readable.cancel();
            throw new Error("frames before init");
          }
          pump = pumpFrames(
            m.readable,
            probing(presenter),
            (stats) => {
              if (generation !== sourceGeneration) return;
              pendingStats = {
                generation,
                sourceId: m.sourceId,
                // The stage outlives its taps. Keep its delivered-frame counter monotonic
                // when a reconnect starts a fresh pump with its own local counter.
                stats: { ...stats, presented: presenter?.presented ?? stats.presented },
              };
            },
            { first: m.first, onError: report },
          );
        }
        return;
      }
    }
  } catch (err) {
    report(err);
  }
}
function report(err: unknown): void {
  scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
}
