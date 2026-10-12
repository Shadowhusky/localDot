import { ULID_PATTERN } from "@localdot/protocol";
import { z } from "zod";
import { sessionEnded } from "../../event-file.ts";
import { NativeBoot, NativeBootRecords } from "./native-boot.ts";
import { interruptedNativeTasks, nativeTaskState } from "./native-tasks.ts";
import { PrivateRecords } from "./private-records.ts";
import { SafetyIntentStore } from "./store.ts";

const Id = z.string().regex(ULID_PATTERN);
export const FenceRecord = z.strictObject({
  cellId: Id,
  sessionId: Id,
  revision: z.number().int().positive().safe(),
  executor: z.enum(["api", "native"]),
  nativeRetired: z.boolean(),
  replacementRequest: Id.optional(),
});
export type FenceRecord = z.infer<typeof FenceRecord>;
// A fence is permanent. Failure to persist/read it closes admission; nothing in replacement removes it.
export class ComputerFences {
  readonly #held = new Map<string, FenceRecord>();
  readonly #durable = new Set<string>();
  readonly #listeners = new Set<(id: string) => void>();
  #records?: PrivateRecords<FenceRecord>;
  #boots?: NativeBootRecords;
  #unavailable = false;
  #recovering = true;
  constructor(
    home: string,
    private readonly additionalFence: (id: string) => boolean = () => false,
    private readonly boot?: NativeBoot,
  ) {
    try {
      if (boot) {
        NativeBoot.parse(boot);
        this.#boots = new NativeBootRecords(home);
      }
      this.#records = new PrivateRecords(home, "fences", (raw, id) => {
        const record = FenceRecord.parse(raw);
        if (record.cellId !== id) throw new Error("fence owner mismatch");
        return record;
      });
      for (const record of this.#records.list()) {
        this.#held.set(record.cellId, Object.freeze(record));
        this.#durable.add(record.cellId);
      }
      for (const record of this.#held.values()) this.#reconcileBoot(record);
      // A crashed unsettled Pause is deny-only recovery. No recorded snapshot can mint a Resume permit.
      // An intent left by a task that recorded its end is stale: that task settled its own tools.
      const { intents, refused } = new SafetyIntentStore(home).scan();
      for (const intent of intents)
        if (
          intent.pause &&
          intent.pause.phase !== "paused" &&
          !sessionEnded(home, intent.sessionId)
        )
          this.capture(intent.cellId, intent.sessionId, intent.executor ?? "native");
      for (const intent of refused) {
        if (!intent.cellId) throw new Error("unattributable safety intent");
        this.capture(intent.cellId, intent.sessionId, "native");
      }
      for (const task of interruptedNativeTasks(home))
        this.capture(task.cellId, task.sessionId, "native");
      for (const record of this.#held.values())
        if (
          record.executor === "native" &&
          !record.nativeRetired &&
          nativeTaskState(home, record.cellId, record.sessionId) === "exited"
        )
          this.confirmNativeRetirement(record.cellId, record.sessionId);
    } catch {
      this.#unavailable = true;
    } finally {
      this.#recovering = false;
    }
  }
  closeAdmission(): void {
    this.#unavailable = true;
  }
  records(): FenceRecord[] {
    if (this.#unavailable) throw new Error("fence records unavailable");
    return [...this.#held.values()].map((record) => structuredClone(record));
  }
  claimReplacement(cellId: string, requestId: string): void {
    const before = this.record(cellId);
    if (!before || !this.#records) throw new Error("replacement fence unavailable");
    const record = FenceRecord.parse({ ...before, replacementRequest: requestId });
    try {
      this.#records.write(cellId, record);
      this.#held.set(cellId, Object.freeze(record));
    } catch (error) {
      this.#unavailable = true;
      throw error;
    }
  }
  isFenced(id: string): boolean {
    try {
      return this.#unavailable || this.#held.has(id) || this.additionalFence(id);
    } catch {
      this.#unavailable = true;
      return true;
    }
  }
  record(id: string): FenceRecord | undefined {
    if (this.#unavailable || !this.#durable.has(id)) return undefined;
    const record = this.#held.get(id);
    return record && structuredClone(record);
  }
  subscribe(listener: (id: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  capture(cellId: string, sessionId: string, executor: "api" | "native"): void {
    if (this.#held.has(cellId)) return;
    const record = FenceRecord.parse({
      cellId,
      sessionId,
      revision: 1,
      executor,
      nativeRetired: executor === "api",
    });
    this.#held.set(cellId, Object.freeze(record));
    for (const listener of this.#listeners)
      try {
        listener(cellId);
      } catch {}
    try {
      if (this.#unavailable || !this.#records) throw new Error("fence records unavailable");
      this.#records.write(cellId, record);
      this.#durable.add(cellId);
      this.#reconcileBoot(record, !this.#recovering);
    } catch {
      this.#unavailable = true;
    }
  }
  #reconcileBoot(record: FenceRecord, capturedNow = false): void {
    if (!this.boot || !this.#boots || record.executor !== "native" || record.nativeRetired) return;
    const before = this.#boots.read(record.cellId);
    if (!before) {
      // A legacy fence has an unknown original boot. Do not invent a capture-time boot
      // while loading it; a later user confirmation is explicit and audited.
      if (!capturedNow) return;
      this.#boots.write(record.cellId, {
        ...this.boot,
        cellId: record.cellId,
        sessionId: record.sessionId,
        revision: record.revision,
      });
      return;
    }
    if (before.sessionId !== record.sessionId || before.revision !== record.revision)
      throw new Error("native boot task mismatch");
    if (before.host === this.boot.host && before.boot !== this.boot.boot)
      this.confirmNativeRetirement(record.cellId, record.sessionId);
    // The permanent fence remains. Replacement still retires the containers, browser,
    // streams and key grants independently before copying the saved computer data.
  }
  confirmNativeRetirement(cellId: string, sessionId: string): void {
    const before = this.record(cellId);
    if (!before || before.sessionId !== sessionId || before.executor !== "native") return;
    const record = { ...before, nativeRetired: true };
    try {
      this.#records?.write(cellId, record);
      this.#held.set(cellId, Object.freeze(record));
    } catch {
      this.#unavailable = true;
    }
  }
}
