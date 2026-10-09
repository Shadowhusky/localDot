import type { ExportHostCheck, HostExport } from "@localdot/protocol";
import { ExportFailure, type ExportRenderer, type RenderIo, type RenderResult } from "../jobs.ts";

export const ABLE: ExportHostCheck = {
  maxPixels: { mp4: 2560 * 1600, webm: 2560 * 1600 },
  decodes: true,
  graphics: "fake",
};

export interface Rendering {
  job: HostExport;
  io: RenderIo;
  signal: AbortSignal;
  settled: boolean;
  finish(frames: number): void;
  fail(reason?: string | Error): void;
}

// A renderer a test (or the UI fixture) drives by hand: each render waits until it is told to
// finish or fail, and stops when its signal aborts.
export class FakeRenderer implements ExportRenderer {
  able: ExportHostCheck | null = ABLE;
  checks = 0;
  readonly renders: Rendering[] = [];
  readonly #waiters = new Set<(rendering: Rendering) => void>();

  async check(): Promise<ExportHostCheck | null> {
    this.checks++;
    return this.able;
  }

  render(job: HostExport, io: RenderIo, signal: AbortSignal): Promise<RenderResult> {
    return new Promise<RenderResult>((resolve, reject) => {
      const settle = () => {
        rendering.settled = true;
        signal.removeEventListener("abort", stop);
      };
      const stop = () => {
        settle();
        reject(signal.reason);
      };
      const rendering: Rendering = {
        job,
        io,
        signal,
        settled: false,
        finish: (frames) => {
          settle();
          resolve({ frames });
        },
        fail: (reason) => {
          settle();
          reject(
            reason instanceof Error
              ? reason
              : reason
                ? new ExportFailure(reason)
                : new Error("broken"),
          );
        },
      };
      signal.addEventListener("abort", stop, { once: true });
      this.renders.push(rendering);
      for (const waiter of this.#waiters) waiter(rendering);
      this.#waiters.clear();
    });
  }

  // The render under way, or the next one to start.
  next(): Promise<Rendering> {
    const open = this.renders.find((rendering) => !rendering.settled);
    if (open) return Promise.resolve(open);
    return new Promise((resolve) => this.#waiters.add(resolve));
  }
}
