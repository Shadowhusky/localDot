import { ULID_PATTERN } from "@localdot/protocol";
import type { BrowserScope } from "../browser/client.ts";
import type { ScreenSelection } from "../browser/screen-controller.ts";
import { RecordingBudget } from "./budget.ts";
import { Recorder, type RecorderDeps, SHUTDOWN_FINALIZE_MS } from "./recorder.ts";

export class ScreenRecordingError extends Error {
  constructor() {
    super("Screen recording could not be attached.");
    this.name = "ScreenRecordingError";
  }
}
// How long frames already on their way still show the window before: a capture, its encoding and
// its trip through the stream.
export const STREAM_CATCHES_UP_MS = 300;

interface Owner {
  epoch: number;
  closed: boolean;
  budget: RecordingBudget;
  stopping?: Promise<void>;
}

// A pair of real unattended recorders: separate files/geometry, shared session clock,
// privacy authority and storage allowance. No viewer or UI selection owns their lifetime.
export class ScreenRecordings {
  readonly desktop: Recorder;
  readonly browser: Recorder;
  readonly #owners = new Map<string, Owner>();
  // The task each computer's screen last changed to.
  readonly #onScreen = new Map<string, string>();
  constructor(
    private readonly deps: Omit<RecorderDeps, "screen" | "usageFor">,
    browser: Pick<RecorderDeps, "cells" | "feedFor">,
    private readonly maxBytes?: number,
  ) {
    this.desktop = new Recorder({
      ...deps,
      screen: "desktop",
      onFinished: undefined,
      usageFor: (id) => this.#owner(id).budget.owner("desktop"),
    });
    this.browser = new Recorder({
      ...deps,
      ...browser,
      screen: "browser",
      onFinished: undefined,
      usageFor: (id) => this.#owner(id).budget.owner("browser"),
    });
  }
  #owner(id: string): Owner {
    if (!ULID_PATTERN.test(id)) throw new ScreenRecordingError();
    let owner = this.#owners.get(id);
    if (!owner) {
      owner = { epoch: 0, closed: false, budget: new RecordingBudget(this.maxBytes) };
      this.#owners.set(id, owner);
    }
    return owner;
  }
  async start(cellId: string, sessionId: string): Promise<void> {
    if (this.#owner(sessionId).closed) throw new ScreenRecordingError();
    await this.desktop.start(cellId, sessionId);
  }
  async attach(sessionId: string, selection: ScreenSelection, scope: BrowserScope): Promise<void> {
    scope.check();
    const owner = this.#owner(sessionId),
      epoch = owner.epoch;
    if (owner.closed) throw new ScreenRecordingError();
    const check = () => {
      scope.check();
      if (scope.signal.aborted || owner.closed || epoch !== owner.epoch)
        throw new ScreenRecordingError();
    };
    try {
      check();
      // The screen controller calls this only after the physical grant and manual-input drain.
      // A later fence increments epoch and closes both gates synchronously.
      this.desktop.release(sessionId);
      this.browser.release(sessionId);
      const recorder = selection.screen === "browser" ? this.browser : this.desktop;
      const attached = await recorder.attach(selection.cellId, sessionId);
      check();
      if (attached === "unavailable") throw new ScreenRecordingError();
      if (attached === "ready") {
        const info = recorder.info(sessionId);
        if (
          !info?.live ||
          info.manifest.width !== selection.geometry.w ||
          info.manifest.height !== selection.geometry.h
        )
          throw new ScreenRecordingError();
      }
    } catch {
      await this.fence(sessionId);
      throw new ScreenRecordingError();
    }
  }
  // One display, one stream: a task's recording takes in only what its own window shows. Before a
  // task's window comes to a screen, every other task's recording of it stops taking frames, and
  // goes on once its own window is back.
  coming(
    cellId: string,
    sessionId: string,
    screen: "desktop" | "browser",
    on: readonly string[],
  ): void {
    const key = `${cellId}\0${screen}`;
    if (this.#onScreen.get(key) === sessionId) return;
    this.#onScreen.set(key, sessionId);
    for (const other of on) if (other !== sessionId) this[screen].away(other);
  }
  up(sessionId: string, screen: "desktop" | "browser"): void {
    this[screen].back(sessionId, STREAM_CATCHES_UP_MS);
  }
  // The user's control may reach either screen, and no other task's recording sees it.
  forUser(cellId: string, sessionId: string, on: readonly string[]): void {
    this.coming(cellId, sessionId, "desktop", on);
    this.coming(cellId, sessionId, "browser", on);
  }
  fence(sessionId: string): Promise<void> {
    const owner = this.#owner(sessionId);
    owner.epoch++;
    const waits = [this.desktop.hold(sessionId), this.browser.hold(sessionId)];
    return Promise.allSettled(waits).then((results) => {
      if (results.some((result) => result.status === "rejected")) throw new ScreenRecordingError();
    });
  }
  stop(sessionId: string): Promise<void> {
    const owner = this.#owner(sessionId);
    if (owner.stopping) return owner.stopping;
    owner.closed = true;
    const completion = Promise.withResolvers<void>();
    owner.stopping = completion.promise;
    void Promise.allSettled([
      this.fence(sessionId),
      this.desktop.stop(sessionId),
      this.browser.stop(sessionId),
    ])
      .then(async (results) => {
        if (results.some((result) => result.status === "rejected"))
          throw new ScreenRecordingError();
        await this.deps.onFinished?.(sessionId);
      })
      .then(completion.resolve, completion.reject);
    return owner.stopping;
  }
  isLive(sessionId: string): boolean {
    return this.desktop.isLive(sessionId) || this.browser.isLive(sessionId);
  }
  info(sessionId: string, screen: "desktop" | "browser" = "desktop") {
    return this[screen].info(sessionId);
  }
  async recoverAll() {
    const results = await Promise.all([this.desktop.recoverAll(), this.browser.recoverAll()]);
    return results.reduce(
      (total, result) => ({
        recovered: total.recovered + result.recovered,
        failed: total.failed + result.failed,
        quarantined: total.quarantined + result.quarantined,
      }),
      { recovered: 0, failed: 0, quarantined: 0 },
    );
  }
  async stopAll(timeoutMs = SHUTDOWN_FINALIZE_MS): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([...this.#owners.keys()].map((id) => this.stop(id))),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
