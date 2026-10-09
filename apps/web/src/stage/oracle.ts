import {
  type Camera,
  cameraFor,
  type Scene,
  type SessionModel,
  sceneAt,
  toCanvas,
  type View,
} from "@localdot/stage";
import { sessionMsAt } from "../session/clock-sync.ts";
import type { PixiPresenter } from "./pixi-presenter.ts";
import type { OracleCommand, StageClock } from "./worker-protocol.ts";

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Two overlay-only crops per tick and zoom: `crop` centred on the action point (the ring band and
// the target box live there) and `cursorShot` around the drawn cursor wherever it is, so the
// hotspot can be checked on an unsquashed, fully opaque arrow at any point of the travel or the
// hold. That check needs few shots: one per SHOT_EVERY_MS keeps the tick rate up in the dwell.
export interface TickCapture {
  t: number;
  presented: number;
  zoom: number;
  scale: number;
  actionId: string;
  expected: { x: number; y: number };
  crop: CropRect;
  png: string;
  cursorInCrop: { x: number; y: number } | null;
  cursorShot: {
    crop: CropRect;
    tip: { x: number; y: number };
    press: number;
    lean: number;
    alpha: number;
    png: string;
  } | null;
  rings: number;
  typingShown: number;
  typingCount: number;
}

export interface FrameCapture {
  t: number;
  presented: number;
  actionId: string;
  luma: string;
}

export interface OracleDump {
  ticks: TickCapture[];
  frames: FrameCapture[];
  errors: string[];
  dpr: number;
}

interface Region {
  id: string;
  point: { x: number; y: number };
  kind: "click" | "type" | "key";
  from: number;
  until: number;
}

interface KeptFrame {
  frame: VideoFrame;
  at: number;
  presented: number;
}

// The arrow with its edge and shadow spans about x −2…16, y −2…25 CSS px from the tip
// (geometry.ts), 36 × 54 canvas px at DPR 2. A cursor shot is 96 px with the tip at (32, 24), so a
// 64 px template placed around the tip fits (template origin ≥ 0 and ≤ 32 both ways). The action
// crop is 96 px centred on the point: the whole 11–21 CSS px ring band (22–42 px at DPR 2) fits.
const CROP = 96;
const CROP_CENTRE = { x: CROP / 2, y: CROP / 2 };
const SHOT_TIP = { x: 32, y: 24 };
const SHOT_EVERY_MS = 50;
const TEMPLATE = 64;
const TEMPLATE_TIP = { x: 16, y: 10 };
const LUMA = 64;
const MAX_TICKS = 4000;
const MAX_FRAMES = 3000;

const cropAt = (c: { x: number; y: number }, at: { x: number; y: number }): CropRect => ({
  x: Math.round(c.x - at.x),
  y: Math.round(c.y - at.y),
  w: CROP,
  h: CROP,
});

const lumaRect = (p: { x: number; y: number }, screen: { w: number; h: number }) => ({
  x: Math.max(0, Math.min(screen.w - LUMA, Math.round(p.x - LUMA / 2))),
  y: Math.max(0, Math.min(screen.h - LUMA, Math.round(p.y - LUMA / 2))),
  width: LUMA,
  height: LUMA,
});

const toBase64 = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

async function pngOf(rgba: Uint8ClampedArray, w: number, h: number): Promise<string> {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no 2d context for the oracle");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  const blob = await c.convertToBlob({ type: "image/png" });
  return toBase64(new Uint8Array(await blob.arrayBuffer()));
}

async function copyLuma(
  frame: VideoFrame,
  rect: { x: number; y: number; width: number; height: number },
): Promise<Uint8Array> {
  const size = frame.allocationSize({ rect });
  const buf = new Uint8Array(size);
  const [layout] = await frame.copyTo(buf, { rect });
  const out = new Uint8Array(rect.width * rect.height);
  if (!layout) return out;
  for (let row = 0; row < rect.height; row++)
    out.set(
      buf.subarray(
        layout.offset + row * layout.stride,
        layout.offset + row * layout.stride + rect.width,
      ),
      row * rect.width,
    );
  return out;
}

// Captures only inside a window around each action: from 100 ms before the planned arrival (the
// press comes after a ≤ 90 ms dwell) to 1.5 s after the dispatch, so a session's dump stays a few
// megabytes.
function regionsAt(model: SessionModel, t: number): Region[] {
  const out: Region[] = [];
  for (const a of model.actions) {
    const point =
      a.dispatch && "at" in a.dispatch.input
        ? a.dispatch.input.at
        : (a.target?.point ?? a.plan?.to ?? a.point);
    if (!point) continue;
    const kind = a.verb === "type" ? "type" : a.verb === "key" ? "key" : "click";
    const arrival = a.plan ? a.plan.startsAt + a.plan.durationMs : a.intentT;
    const from = arrival - 100;
    const until = (a.dispatch?.t ?? arrival) + 1500;
    if (t >= from && t <= until) out.push({ id: a.id, point, kind, from, until });
  }
  return out;
}

export class OracleCapture {
  enabled = false;
  dpr = 1;
  zooms = [1];
  clock: StageClock | null = null;
  ticks: TickCapture[] = [];
  frames: FrameCapture[] = [];
  errors: string[] = [];
  #regions: Region[] = [];
  #screen = { w: 2560, h: 1600 };
  #latest: KeptFrame | null = null;
  // Windows that already have a luma crop: each gets one baseline, and only when it opens.
  #opened = new Set<string>();
  // "<action id> <zoom>" → session ms of the last cursor shot.
  #lastShot = new Map<string, number>();

  // Every decoded frame comes through here. While the oracle is off (production) nothing is kept
  // (P3-C12): a held decoded frame is ~12 MB at 2× I444 and can starve the decode frame pool.
  // While it is on, a still screen sends no frames (Selkies encodes on damage, A30), so a clone of
  // the newest is kept until the next one replaces it: a window that opens on a still screen takes
  // its baseline from it.
  onFrame(frame: VideoFrame, at: number, presented: number): void {
    if (!this.enabled) return;
    this.#latest?.frame.close();
    const kept = { frame: frame.clone(), at, presented };
    this.#latest = kept;
    this.#lumaCrops(kept, this.#regions);
  }

  dispose(): void {
    this.#latest?.frame.close();
    this.#latest = null;
  }

  // One luma crop of `kept` per window, with that frame's own time and count. The windows are
  // marked at once, so no frame is cropped twice for one window, and the bytes come from a clone:
  // copyTo is async and the kept frame may be replaced and closed before it resolves. A failed
  // crop is recorded in `errors` under its window's id, and the other windows still get theirs.
  #lumaCrops(kept: KeptFrame, regions: Region[]): void {
    if (!this.clock || regions.length === 0) return;
    const t = sessionMsAt(kept.at, this.clock);
    const jobs = regions.map((r) => ({ id: r.id, rect: lumaRect(r.point, this.#screen) }));
    for (const job of jobs) this.#opened.add(job.id);
    const copy = kept.frame.clone();
    void (async () => {
      for (const job of jobs) {
        try {
          const luma = await copyLuma(copy, job.rect);
          this.frames.push({
            t,
            presented: kept.presented,
            actionId: job.id,
            luma: toBase64(luma),
          });
        } catch (err) {
          this.errors.push(`${job.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (this.frames.length > MAX_FRAMES) this.frames.splice(0, this.frames.length - MAX_FRAMES);
    })().finally(() => copy.close());
  }

  // Runs on every tick and right after the worker folds events: an Instant click's window is
  // already open when its intent arrives, so its baseline is taken then, from the kept frame,
  // before the press's frame can replace it.
  onModel(model: SessionModel, t: number, screen: { w: number; h: number }): void {
    this.#screen = screen;
    this.#regions = regionsAt(model, t);
    const latest = this.#latest;
    if (latest)
      this.#lumaCrops(
        latest,
        this.#regions.filter((r) => !this.#opened.has(r.id)),
      );
  }

  onTick(
    p: PixiPresenter,
    model: SessionModel,
    t: number,
    scene: Scene | null,
    cam: Camera,
    viewport: { w: number; h: number },
    screen: { w: number; h: number },
  ): void {
    this.onModel(model, t, screen);
    if (!scene) return;
    for (const r of this.#regions) {
      for (const zoom of this.zooms) {
        const camZ =
          zoom === 1
            ? cam
            : cameraFor({
                stageW: viewport.w,
                stageH: viewport.h,
                desktopW: screen.w,
                desktopH: screen.h,
                zoom,
                focus: r.point,
              });
        const c = toCanvas(camZ, r.point);
        const crop = cropAt(c, CROP_CENTRE);
        const rgba = p.extract(crop, "overlays", camZ, scene);
        const action = model.actions.find((a) => a.id === r.id);
        const typingCount = Math.max(
          0,
          ...(action?.progress.filter((pr) => pr.t <= t).map((pr) => pr.count) ?? [0]),
        );
        const rings = scene.rings.filter(
          (ring) => Math.hypot(ring.x - r.point.x, ring.y - r.point.y) < 4,
        ).length;
        const typingShown = scene.typing ? [...scene.typing.text].length + scene.typing.more : 0;
        const cursor = scene.cursor?.visible ? scene.cursor : null;
        const cursorCanvas = cursor ? toCanvas(camZ, { x: cursor.x, y: cursor.y }) : null;
        const cursorInCrop = cursorCanvas
          ? { x: cursorCanvas.x - crop.x, y: cursorCanvas.y - crop.y }
          : null;
        let cursorShot: TickCapture["cursorShot"] = null;
        let cursorRgba: Uint8ClampedArray | null = null;
        const shotKey = `${r.id} ${zoom}`;
        if (
          cursor &&
          cursorCanvas &&
          t - (this.#lastShot.get(shotKey) ?? Number.NEGATIVE_INFINITY) >= SHOT_EVERY_MS
        ) {
          this.#lastShot.set(shotKey, t);
          const shotCrop = cropAt(cursorCanvas, SHOT_TIP);
          cursorRgba = p.extract(shotCrop, "overlays", camZ, scene);
          cursorShot = {
            crop: shotCrop,
            tip: { x: cursorCanvas.x - shotCrop.x, y: cursorCanvas.y - shotCrop.y },
            press: cursor.press,
            lean: cursor.lean,
            alpha: cursor.alpha,
            png: "",
          };
        }
        const tick: TickCapture = {
          t,
          presented: p.presented,
          zoom,
          scale: camZ.scale,
          actionId: r.id,
          expected: { x: c.x - crop.x, y: c.y - crop.y },
          crop,
          png: "",
          cursorInCrop,
          cursorShot,
          rings,
          typingShown,
          typingCount,
        };
        this.ticks.push(tick);
        void pngOf(rgba, CROP, CROP).then((png) => {
          tick.png = png;
        });
        if (cursorRgba && cursorShot) {
          const shot = cursorShot;
          void pngOf(cursorRgba, CROP, CROP).then((png) => {
            shot.png = png;
          });
        }
      }
    }
    if (this.ticks.length > MAX_TICKS) this.ticks.splice(0, this.ticks.length - MAX_TICKS);
  }

  async handle(
    command: OracleCommand,
    p: PixiPresenter,
    model: SessionModel,
    view: View,
  ): Promise<unknown> {
    switch (command.op) {
      case "enable":
        // A frame kept while already on stays: it is still what the screen shows.
        this.enabled = true;
        this.zooms = command.zooms;
        this.ticks = [];
        this.frames = [];
        this.errors = [];
        this.#opened.clear();
        this.#lastShot.clear();
        return { ok: true };
      case "dump":
        await new Promise((r) => setTimeout(r, 50));
        return {
          ticks: this.ticks.filter((t) => t.png && (!t.cursorShot || t.cursorShot.png)),
          frames: this.frames,
          errors: this.errors,
          dpr: this.dpr,
        } satisfies OracleDump;
      case "template": {
        // The arrow alone at zoom 1, unpressed, upright and opaque, without its name chip: the
        // sprite the matcher looks for. Overlays keep their CSS size at every zoom (unit =
        // dpr / cam.scale), so one template serves zoom 1 and zoom 2.
        const scene: Scene = {
          control: true,
          cursor: {
            x: 100,
            y: 100,
            visible: true,
            alpha: 1,
            press: 0,
            lean: 0,
            chipAlpha: 0,
            name: "dot",
          },
          target: null,
          press: null,
          rings: [],
          drag: null,
          typing: null,
          keycaps: null,
          scroll: null,
          cancel: null,
          hud: { label: "", state: "working", control: true, elapsedMs: 0 },
        };
        const live = cameraFor({
          stageW: p.app.renderer.width,
          stageH: p.app.renderer.height,
          desktopW: model.screen?.w ?? this.#screen.w,
          desktopH: model.screen?.h ?? this.#screen.h,
          zoom: 1,
        });
        const c = toCanvas(live, { x: 100, y: 100 });
        const crop = {
          x: Math.round(c.x - TEMPLATE_TIP.x),
          y: Math.round(c.y - TEMPLATE_TIP.y),
          w: TEMPLATE,
          h: TEMPLATE,
        };
        const rgba = p.extract(crop, "overlays", live, scene);
        return {
          png: await pngOf(rgba, TEMPLATE, TEMPLATE),
          w: TEMPLATE,
          h: TEMPLATE,
          tip: { x: c.x - crop.x, y: c.y - crop.y },
        };
      }
      case "render-twice": {
        const live = cameraFor({
          stageW: p.app.renderer.width,
          stageH: p.app.renderer.height,
          desktopW: model.screen?.w ?? this.#screen.w,
          desktopH: model.screen?.h ?? this.#screen.h,
          zoom: 1,
        });
        const whole = { x: 0, y: 0, w: p.app.renderer.width, h: p.app.renderer.height };
        const a = p.extract(whole, "overlays", live, sceneAt(model, command.tMs, view));
        p.draw(null);
        const b = p.extract(whole, "overlays", live, sceneAt(model, command.tMs, view));
        let identical = a.length === b.length;
        for (let i = 0; identical && i < a.length; i++) if (a[i] !== b[i]) identical = false;
        return { identical, bytes: a.length };
      }
    }
  }
}
