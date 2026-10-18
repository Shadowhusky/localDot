import { readTheme } from "../stage/theme.ts";
import type { ExportContext } from "./export-context.ts";
import type { ExportPlan, ExportRequest } from "./export-plan.ts";
import type { PreviewIn, PreviewOut } from "./preview-protocol.ts";

export interface PreviewState {
  playing: boolean;
  loading: boolean;
  visible: boolean;
  positionMs: number;
  error: boolean;
}

export const initialPreview = (): PreviewState => ({
  playing: false,
  loading: false,
  visible: false,
  positionMs: 0,
  error: false,
});

// One requested frame at a time: a slow decoder never accumulates a queue of old frames.
// The clock is output time, so trimming, speed and idle removal agree with the saved file.
export class PreviewPlayer {
  readonly #worker: Worker;
  readonly #canvas: HTMLCanvasElement;
  readonly #plan: ExportPlan;
  readonly #change: (state: PreviewState) => void;
  #state = initialPreview();
  #ready = false;
  #closed = false;
  #inFlight = false;
  #wanted = 0;
  #shown = -1;
  #raf = 0;
  #timeout = 0;
  #anchor = 0;
  #playFrom = 0;

  constructor(
    surface: HTMLElement,
    context: ExportContext,
    request: ExportRequest,
    plan: ExportPlan,
    change: (state: PreviewState) => void,
  ) {
    this.#plan = plan;
    this.#change = change;
    this.#canvas = document.createElement("canvas");
    this.#canvas.setAttribute("aria-label", "Video preview");
    this.#canvas.setAttribute("role", "img");
    this.#canvas.width = Math.min(960, request.size.w);
    this.#canvas.height = Math.round((this.#canvas.width * request.size.h) / request.size.w);
    const canvas = this.#canvas.transferControlToOffscreen();
    this.#worker = new Worker(new URL("./preview-worker.ts", import.meta.url), { type: "module" });
    surface.append(this.#canvas);
    this.#worker.onmessage = ({ data }: MessageEvent<PreviewOut>) => {
      if (this.#closed) return;
      if (data.type === "error") return this.#fail();
      window.clearTimeout(this.#timeout);
      if (data.type === "ready") {
        this.#ready = true;
        this.#anchor = performance.now();
        this.#send();
      } else {
        this.#inFlight = false;
        this.#shown = data.index;
        this.#canvas.dataset.frame = String(data.index);
        this.#canvas.dataset.sessionMs = String(data.sessionMs);
        if (!this.#state.visible && this.#state.playing) this.#anchor = performance.now();
        const ended = this.#state.playing && data.index === this.#plan.frames - 1;
        this.#set({
          visible: true,
          loading: false,
          positionMs: ended ? this.#plan.durationS * 1000 : (data.index / this.#plan.fps) * 1000,
          ...(ended ? { playing: false } : {}),
        });
        this.#send();
      }
      this.#schedule();
    };
    this.#worker.onerror = this.#worker.onmessageerror = () => this.#fail();
    try {
      const message: PreviewIn = {
        type: "start",
        canvas,
        context,
        request,
        theme: readTheme(getComputedStyle(document.documentElement)),
      };
      this.#worker.postMessage(message, [canvas]);
      this.#watch();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  #set(patch: Partial<PreviewState>) {
    this.#state = { ...this.#state, ...patch };
    this.#change(this.#state);
  }

  #watch() {
    window.clearTimeout(this.#timeout);
    this.#timeout = window.setTimeout(() => this.#fail(), 15_000);
  }

  #fail() {
    if (this.#closed) return;
    this.close();
    this.#set({ error: true, playing: false, loading: false, visible: false });
  }

  #send() {
    if (this.#closed || !this.#ready || this.#inFlight || this.#wanted === this.#shown) return;
    this.#inFlight = true;
    this.#worker.postMessage({ type: "frame", index: this.#wanted } satisfies PreviewIn);
    this.#watch();
  }

  #schedule() {
    if (this.#closed || !this.#state.playing || !this.#ready || this.#raf) return;
    this.#raf = requestAnimationFrame(() => {
      this.#raf = 0;
      const elapsed = this.#playFrom + performance.now() - this.#anchor;
      this.#wanted = Math.min(this.#plan.frames - 1, Math.floor((elapsed / 1000) * this.#plan.fps));
      this.#send();
      this.#schedule();
    });
  }

  play() {
    if (this.#closed) return;
    if (this.#shown >= this.#plan.frames - 1) this.#wanted = 0;
    else this.#wanted = Math.max(0, this.#shown);
    this.#playFrom = (this.#wanted / this.#plan.fps) * 1000;
    this.#anchor = performance.now();
    this.#set({ playing: true, loading: !this.#state.visible });
    this.#send();
    this.#schedule();
  }

  pause() {
    if (this.#closed) return;
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    this.#wanted = Math.max(0, this.#shown);
    this.#set({ playing: false });
  }

  seek(positionMs: number) {
    if (this.#closed) return;
    this.pause();
    this.#wanted = Math.max(
      0,
      Math.min(this.#plan.frames - 1, Math.floor((positionMs / 1000) * this.#plan.fps)),
    );
    this.#set({
      positionMs: (this.#wanted / this.#plan.fps) * 1000,
      loading: !this.#state.visible,
    });
    this.#send();
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    cancelAnimationFrame(this.#raf);
    window.clearTimeout(this.#timeout);
    this.#worker.terminate();
    this.#canvas.remove();
  }
}
