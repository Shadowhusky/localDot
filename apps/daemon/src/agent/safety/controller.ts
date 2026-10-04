import {
  ModelAdmissionSnapshot,
  type ModelAdmissionWrite,
  type PauseSnapshot,
} from "@localdot/protocol";
import type { AgentSession } from "../session.ts";

export interface ModelOwner {
  readonly cellId: string;
  readonly taskId: string;
}
export interface SafetyControllerDeps {
  owner(): ModelOwner | undefined;
  ownerBoundary?(): Promise<void>;
  ready(): void;
  modelAdmission(cellId: string): Promise<ModelAdmissionSnapshot>;
  setModelAdmission(cellId: string, write: ModelAdmissionWrite): Promise<ModelAdmissionSnapshot>;
  persist(pause: PauseSnapshot | undefined): void;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  // Native readiness is a separate pinned-turn receipt boundary, supplied in Task4.
  mode: "api" | "native";
}
function same(a: ModelOwner | undefined, b: ModelOwner | undefined): boolean {
  return a?.cellId === b?.cellId && a?.taskId === b?.taskId;
}
export class SafetyController {
  #pausing: Promise<void> | undefined;
  #model: (ModelOwner & { generationId: string; epoch: number }) | undefined;
  constructor(
    readonly session: AgentSession,
    readonly deps: SafetyControllerDeps,
  ) {}
  request(requestId: string): PauseSnapshot {
    const pause = this.session.requestSafetyPause(requestId);
    if (!this.#pausing && pause.phase === "pausing") {
      this.#pausing = this.#settle(pause)
        .catch(() => this.invalidate())
        .finally(() => {
          this.#pausing = undefined;
        });
    }
    return pause;
  }
  async settled(): Promise<void> {
    await this.#pausing;
  }
  invalidate(): void {
    const pause = this.session.safetyPause;
    if (!pause || this.session.stopped) return;
    try {
      this.session.uncertainSafetyPause(pause.requestId, pause.revision);
    } catch {
      /* The private fence changes before journal publication. */
    }
    try {
      this.deps.persist(this.session.safetyPause);
    } catch {
      /* Failed durability cannot grant Resume. */
    }
  }
  #current(pause: Pick<PauseSnapshot, "requestId" | "revision">, owner?: ModelOwner): void {
    this.session.abort.signal.throwIfAborted();
    const current = this.session.safetyPause;
    if (
      !current ||
      current.requestId !== pause.requestId ||
      current.revision !== pause.revision ||
      this.session.controlHeld ||
      !same(owner, this.deps.owner())
    )
      throw new Error("safety owner changed");
  }
  #read(value: unknown, owner: ModelOwner, generation?: string): ModelAdmissionSnapshot {
    const snap = ModelAdmissionSnapshot.parse(value);
    if (
      snap.taskId !== owner.taskId ||
      snap.retired ||
      (generation !== undefined && snap.generationId !== generation)
    )
      throw new Error("model owner changed");
    return snap;
  }
  async #settle(pause: PauseSnapshot): Promise<void> {
    try {
      await this.deps.ownerBoundary?.();
      const owner = this.deps.owner();
      this.#current(pause, owner);
      if (this.deps.mode === "native") throw new Error("native pause receipts are not confirmed");
      if (owner) {
        let snap = this.#read(await this.deps.modelAdmission(owner.cellId), owner);
        this.#current(pause, owner);
        snap = this.#read(
          await this.deps.setModelAdmission(owner.cellId, {
            taskId: owner.taskId,
            generationId: snap.generationId,
            state: "paused",
          }),
          owner,
          snap.generationId,
        );
        this.#current(pause, owner);
        if (!snap.paused) throw new Error("model admission not closed");
        while (snap.active !== 0) {
          await this.deps.sleep(100, this.session.abort.signal);
          this.#current(pause, owner);
          snap = this.#read(await this.deps.modelAdmission(owner.cellId), owner, snap.generationId);
          this.#current(pause, owner);
          if (!snap.paused) throw new Error("model admission reopened during Pause");
        }
        this.#model = Object.freeze({
          ...owner,
          generationId: snap.generationId,
          epoch: snap.epoch,
        });
      } else this.#model = undefined;
      this.deps.persist(pause);
      await this.session.safetyBoundary();
      this.#current(pause, owner);
      this.deps.persist({ ...pause, phase: "paused", atStepBoundary: true, resumeAvailable: true });
      this.session.confirmSafetyPause(pause.requestId, pause.revision);
    } catch {
      if (this.session.stopped) return;
      this.session.uncertainSafetyPause(pause.requestId, pause.revision);
      try {
        this.deps.persist(this.session.safetyPause);
      } catch {
        /* Admission remains closed. */
      }
    }
  }
  async resume(requestId: string, revision: number): Promise<void> {
    const owner = this.deps.owner();
    const pause = this.session.safetyPause;
    if (!pause?.resumeAvailable || pause.requestId !== requestId || pause.revision !== revision)
      throw new Error("pause owner not resumable");
    this.deps.ready();
    this.#current(pause, owner);
    if (!same(owner, this.#model)) throw new Error("paused model owner changed");
    this.session.beginSafetyResume(requestId, revision);
    try {
      this.deps.persist(this.session.safetyPause);
      if (owner && this.#model) {
        const snap = this.#read(
          await this.deps.modelAdmission(owner.cellId),
          owner,
          this.#model.generationId,
        );
        this.#current(pause, owner);
        this.deps.ready();
        if (!snap.paused || snap.active !== 0 || snap.epoch !== this.#model.epoch)
          throw new Error("model pause epoch changed");
        const opened = this.#read(
          await this.deps.setModelAdmission(owner.cellId, {
            taskId: owner.taskId,
            generationId: snap.generationId,
            state: "open",
            expectedEpoch: snap.epoch,
          }),
          owner,
          snap.generationId,
        );
        this.#current(pause, owner);
        this.deps.ready();
        if (opened.paused || opened.active !== 0 || opened.epoch <= snap.epoch)
          throw new Error("model Resume not confirmed");
      }
      this.deps.persist(undefined);
      this.#current(pause, owner);
      this.session.resumeSafety(requestId, revision);
      this.#model = undefined;
    } catch (error) {
      if (!this.session.stopped) {
        // An uncertain open acknowledgement never releases tool admission or invites retry.
        try {
          this.session.uncertainSafetyPause(requestId, revision);
        } catch {
          /* A failed completion event cannot skip exact-owner closure below. */
        }
        if (owner && this.#model) {
          try {
            await this.deps.setModelAdmission(owner.cellId, {
              taskId: owner.taskId,
              generationId: this.#model.generationId,
              state: "paused",
            });
          } catch {
            /* Exact old owner only. */
          }
        }
        try {
          this.deps.persist(this.session.safetyPause);
        } catch {
          /* Intent remains fenced. */
        }
      }
      throw error;
    }
  }
}
