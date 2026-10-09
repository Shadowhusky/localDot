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
import { WorkerReplay } from "../replay/worker-replay.ts";
import { sessionMsAt } from "../session/clock-sync.ts";
import { OracleCapture } from "./oracle.ts";
import { PixiPresenter } from "./pixi-presenter.ts";
import { meanLuma, type ProbeRect, wallNow } from "./probe.ts";
import { type Presenter, type PumpStats, pumpFrames } from "./pump.ts";
import { RenderGate, sceneKey } from "./render-gate.ts";
import type {
  FieldMark,
  StageClock,
  StageViewPatch,
  WorkerIn,
  WorkerOut,
} from "./worker-protocol.ts";

const scope = self as unknown as {
  postMessage(message: WorkerOut, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
};

let presenter: PixiPresenter | undefined;
let replay: WorkerReplay | undefined;
let pump: { stop(): Promise<void> } | undefined;
let sourceGeneration = 0;
let pushed:
  | { sourceId?: number; controller: ReadableStreamDefaultController<VideoFrame> }
  | undefined;
// The track this worker reads (Safari), ended with its pump.
let track: MediaStreamTrack | undefined;
let pendingStats: { generation: number; sourceId?: number; stats: PumpStats } | undefined;
let probe: { rect: ProbeRect; threshold: number; last: boolean | null } | null = null;
let model: SessionModel = emptyModel();
let view: View = { reducedMotion: false };
let selection: StageViewPatch["selection"] = null;
let fields: readonly FieldMark[] = [];
let zoom = 1;
let freeze = false;
let frozenT: number | null = null;
let clock: StageClock | null = null;
let viewport = { w: 1, h: 1 };
let lastScene: Scene | null = null;
const oracle = new OracleCapture();
const gate = new RenderGate();
let animationFrame: number | null = null;
let idleLook: ReturnType<typeof setTimeout> | null = null;

// The rings on the fields dot will fill, on the screen shown.
function showFields(): void {
  const shown = selection?.screen ?? "desktop";
  presenter?.overlays.setFields(
    fields.filter((field) => field.screen === shown),
    view.reducedMotion,
  );
}

// Looks at the stage on the next display frame, sooner than an idle look would.
function wake(): void {
  if (idleLook !== null) clearTimeout(idleLook);
  idleLook = null;
  if (animationFrame === null) animationFrame = requestAnimationFrame(tick);
}

function sessionNow(): number | null {
  if (!clock) return null;
  return sessionMsAt(wallNow(), clock);
}

function screenNow(): { w: number; h: number } {
  return selection?.geometry ?? model.screen ?? presenter?.frameSize ?? { w: 1280, h: 800 };
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
      wake();
    },
  };
}

function tick(): void {
  animationFrame = null;
  if (replay) {
    replay.tick();
    animationFrame = requestAnimationFrame(tick);
    return;
  }
  const now = performance.now();
  if (presenter) {
    const screen = screenNow();
    presenter.setScreen(selection || model.screen ? screen : null);
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
    const scene = t === null ? null : sceneAt(model, t, view);
    lastScene = scene;
    const key = sceneKey(scene, cam, screen, presenter.fades(now));
    if (gate.due(now, key, presenter.hasFrame || oracle.enabled)) {
      presenter.setCamera(cam);
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
        gate.invalidate();
        report(err);
      }
    }
  }
  // An idle look still waits for a display frame, so a hidden page gets none.
  const wait = gate.wait(now);
  if (wait > 0) idleLook = setTimeout(wake, wait);
  else animationFrame = requestAnimationFrame(tick);
}

let queue = Promise.resolve();
scope.onmessage = (e) => {
  queue = queue.then(async () => {
    await handle(e.data);
    // A frame wakes the stage when the pump hands it over.
    if (e.data.type === "frame") return;
    gate.invalidate();
    if (presenter) wake();
  });
};
scope.postMessage({ type: "caps", tracks: typeof MediaStreamTrackProcessor === "function" });
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
        if (fields.length) showFields();
        return;
      }
      case "resize":
        viewport = { w: m.width, h: m.height };
        presenter?.setViewport(m.width, m.height);
        replay?.invalidate();
        return;
      case "probe":
        probe = m.rect ? { rect: m.rect, threshold: m.threshold, last: null } : null;
        return;
      case "events": {
        model = foldEvents(model, m.events);
        replay?.invalidate();
        // Task 16: a window already open when its intent arrives (an Instant click) gets its
        // baseline now, not a tick later, so the press's frame cannot replace the kept one first.
        const t = freeze ? frozenT : sessionNow();
        if (oracle.enabled && t !== null) oracle.onModel(model, t, screenNow());
        return;
      }
      case "session-reset":
        replay?.close();
        replay = undefined;
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
        if (m.view.reducedMotion !== undefined)
          view = { ...view, reducedMotion: m.view.reducedMotion };
        if (m.view.dim !== undefined) presenter?.setDim(m.view.dim, view.reducedMotion);
        if (m.view.fields !== undefined) fields = m.view.fields;
        if (m.view.selection !== undefined) {
          selection = m.view.selection;
          view = {
            ...view,
            screen: selection?.screen ?? "desktop",
            screenRevision: selection?.revision,
          };
          lastScene = null;
        }
        if (m.view.fields !== undefined || m.view.selection !== undefined) showFields();
        replay?.invalidate();
        return;
      case "theme":
        presenter?.overlays.setTheme(m.theme);
        replay?.invalidate();
        return;
      case "replay-open": {
        sourceGeneration++;
        pendingStats = undefined;
        await pump?.stop();
        pump = undefined;
        endTrack();
        oracle.dispose();
        replay?.close();
        if (!presenter) throw new Error("replay before init");
        replay = new WorkerReplay(m.source, {
          presenter,
          model: () => model,
          view: () => view,
          viewport: () => viewport,
          post: (message) =>
            scope.postMessage(
              message.type === "replay-status" ||
                message.type === "replay-time" ||
                message.type === "replay-ended"
                ? { ...message, owner: m.source.owner }
                : message,
            ),
        });
        return;
      }
      case "replay-transport":
        replay?.transport(m.transport);
        return;
      case "replay-seek":
        replay?.seek(m.tMs, m.mode);
        return;
      case "replay-close":
        replay?.close();
        replay = undefined;
        return;
      case "replay-probe": {
        const active = replay;
        void (active?.probe(m.command) ?? Promise.resolve({ error: "No replay is open." }))
          .catch(() => ({ error: "Replay probe failed." }))
          .then((reply) =>
            scope.postMessage({ type: "replay-probe-reply", id: m.command.id, reply }),
          );
        return;
      }
      case "oracle": {
        const reply = presenter
          ? await oracle.handle(m.command, presenter, model, view)
          : { error: "no presenter" };
        scope.postMessage({ type: "oracle-reply", id: m.command.id, reply });
        return;
      }
      case "frame": {
        const target = pushed;
        if (
          !target ||
          target.sourceId !== m.sourceId ||
          (target.controller.desiredSize ?? 0) <= 0
        ) {
          m.frame.close();
          return;
        }
        target.controller.enqueue(m.frame);
        return;
      }
      case "stop":
      case "frames": {
        endPushed();
        const generation = ++sourceGeneration;
        pendingStats = undefined;
        await pump?.stop();
        pump = undefined;
        endTrack();
        oracle.dispose();
        if (m.type === "frames") {
          const readable =
            m.readable ??
            (m.track ? readTrack(m.track) : m.pushed ? pushedFrames(m.sourceId) : undefined);
          if (replay || !readable) {
            m.first?.close();
            void readable?.cancel().catch(() => {});
            endTrack();
            return;
          }
          if (!presenter) {
            m.first?.close();
            await readable.cancel();
            endTrack();
            throw new Error("frames before init");
          }
          pump = pumpFrames(
            readable,
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
// A one-frame queue for frames the page posts one by one: one that would wait is dropped.
function pushedFrames(sourceId: number | undefined): ReadableStream<VideoFrame> {
  return new ReadableStream<VideoFrame>(
    {
      start(controller) {
        pushed = { sourceId, controller };
      },
      cancel() {
        if (pushed?.sourceId === sourceId) pushed = undefined;
      },
    },
    new CountQueuingStrategy({ highWaterMark: 1 }),
  );
}

function readTrack(next: MediaStreamTrack): ReadableStream<VideoFrame> {
  track = next;
  return new MediaStreamTrackProcessor({ track: next as MediaStreamTrack & MediaStreamVideoTrack })
    .readable;
}

function endTrack(): void {
  track?.stop();
  track = undefined;
}

function endPushed(): void {
  const ending = pushed;
  pushed = undefined;
  try {
    ending?.controller.close();
  } catch {}
}

function report(err: unknown): void {
  scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
}
