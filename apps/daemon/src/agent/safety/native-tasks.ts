import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { ULID_PATTERN, ulid } from "@localdot/protocol";
import { z } from "zod";
import { NativeBoot, readNativeBoot } from "./native-boot.ts";
import { type NativeProcessProbe, nativeProcessProbe, ProcessIdentity } from "./native-process.ts";
import { PrivateRecords } from "./private-records.ts";

const Id = z.string().regex(ULID_PATTERN);
const Run = z
  .strictObject({
    id: Id,
    identity: ProcessIdentity.optional(),
    neverStarted: z.literal(true).optional(),
  })
  .refine((run) => !(run.identity && run.neverStarted), "conflicting launch evidence");
export const NativeTaskRecord = z.strictObject({
  v: z.literal(1),
  route: z.literal("claude-code"),
  settled: z.literal(true).optional(),
  cellId: Id,
  sessionId: Id,
  boot: NativeBoot.optional(),
  runs: z.array(Run).min(1).max(32),
});
export type NativeTaskState = "exited" | "alive" | "unknown" | "legacy";
type TaskRecord = z.infer<typeof NativeTaskRecord>;
const combined = (states: readonly NativeTaskState[]): NativeTaskState =>
  states.includes("alive") ? "alive" : states.every((s) => s === "exited") ? "exited" : "unknown";
// Another task's Claude Code on this computer may still be running and its exit is unconfirmed.
export class NativeCleanupPending extends Error {
  constructor() {
    super("previous native task cleanup is unconfirmed");
    this.name = "NativeCleanupPending";
  }
}
// One record per task, saved under the task's ID. Several tasks share a computer; a record from
// before they did is saved under the computer's ID.
export class NativeTasks extends PrivateRecords<TaskRecord> {
  constructor(
    home: string,
    private readonly probe: NativeProcessProbe = nativeProcessProbe,
    private readonly boot = readNativeBoot(),
  ) {
    super(home, "native-tasks", (raw, id) => {
      const record = NativeTaskRecord.parse(raw);
      if (
        (record.sessionId !== id && record.cellId !== id) ||
        new Set(record.runs.map((r) => r.id)).size !== record.runs.length
      )
        throw new Error("native task owner mismatch");
      return record;
    });
  }
  // Called synchronously before each spawn. A crash between spawn and identity persistence leaves
  // an explicit unknown launch, never a false exit. Tool callbacks cannot run before this returns.
  // Another task's unsettled launch on the computer blocks this one unless that task is still at
  // work there; a settled one is superseded.
  spawn(
    cellId: string,
    sessionId: string,
    launch: () => SpawnedProcess & { readonly pid?: number },
    atWork: (sessionId: string) => boolean = () => false,
  ): SpawnedProcess {
    let before: TaskRecord | undefined;
    const superseded: string[] = [],
      legacy: string[] = [];
    for (const [id, record] of this.entries()) {
      if (record.sessionId === sessionId) {
        if (record.cellId !== cellId) throw new Error("native task owner mismatch");
        if (!before || id === sessionId) before = record;
        if (id !== sessionId) legacy.push(id);
      } else if (record.cellId === cellId) {
        if (record.settled) superseded.push(id);
        else if (!atWork(record.sessionId)) throw new NativeCleanupPending();
      }
    }
    for (const id of superseded) this.remove(id);
    const retained =
      before && !before.settled && this.#state(before) !== "exited" ? before.runs : [];
    const run = { id: ulid() };
    const record = NativeTaskRecord.parse({
      v: 1,
      route: "claude-code",
      cellId,
      sessionId,
      ...(this.boot ? { boot: this.boot } : {}),
      runs: [...retained, run],
    });
    this.write(sessionId, record);
    let child: SpawnedProcess & { readonly pid?: number };
    try {
      for (const id of legacy) this.remove(id);
      child = launch();
    } catch (error) {
      this.write(sessionId, { ...record, runs: [...retained, { ...run, neverStarted: true }] });
      throw error;
    }
    // Identity is read from the kernel and must name our direct child in its own process group.
    // No process is killed through a PID loaded from disk.
    try {
      const identity = child.pid ? this.probe.identity(child.pid) : undefined;
      if (identity) this.write(sessionId, { ...record, runs: [...retained, { ...run, identity }] });
    } catch {
      /* The pre-spawn record remains unknown; ordinary driver cleanup still owns child. */
    }
    return child;
  }
  confirmed(sessionId: string): void {
    for (const [id, record] of this.entries())
      if (record.sessionId === sessionId) {
        if (record.runs.some((run) => run.identity && this.probe.status(run.identity) === "alive"))
          throw new Error("native task descendants are still running");
        this.write(id, { ...record, settled: true });
      }
  }
  // The task's own launches and, as they share its computer, every other unsettled one there:
  // its exit is confirmed only once nothing native is left running on the computer.
  state(cellId: string, sessionId: string): NativeTaskState {
    let own: TaskRecord | undefined,
      ownId: string | undefined,
      onCell = false;
    const others: TaskRecord[] = [];
    for (const [id, record] of this.entries()) {
      if (record.cellId === cellId) onCell = true;
      if (record.sessionId === sessionId && ownId !== sessionId) {
        own = record;
        ownId = id;
      } else if (record.sessionId !== sessionId && record.cellId === cellId && !record.settled)
        others.push(record);
    }
    if (!own) return onCell ? "unknown" : "legacy";
    if (own.cellId !== cellId) return "unknown";
    return combined([own, ...others].map((record) => this.#state(record)));
  }
  #state(record: TaskRecord): NativeTaskState {
    if (record.settled) return "exited";
    if (this.boot && record.boot?.host === this.boot.host && record.boot.boot !== this.boot.boot)
      return "exited";
    if (!this.boot || !record.boot || this.boot.host !== record.boot.host) return "unknown";
    return combined(
      record.runs.map((r) =>
        r.neverStarted ? "exited" : r.identity ? this.probe.status(r.identity) : "unknown",
      ),
    );
  }
}
// doctor never creates missing evidence, and startup checks run before native task admission.
export function nativeTaskState(home: string, cellId: string, sessionId: string): NativeTaskState {
  if (!existsSync(join(home, "safety", "native-tasks"))) return "legacy";
  try {
    return new NativeTasks(home).state(cellId, sessionId);
  } catch {
    return "unknown";
  }
}

export function interruptedNativeTasks(home: string): Array<{ cellId: string; sessionId: string }> {
  if (!existsSync(join(home, "safety", "native-tasks"))) return [];
  return new NativeTasks(home)
    .list()
    .filter((record) => !record.settled)
    .map(({ cellId, sessionId }) => ({ cellId, sessionId }));
}
