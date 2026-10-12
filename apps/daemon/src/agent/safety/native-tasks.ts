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
export class NativeTasks extends PrivateRecords<z.infer<typeof NativeTaskRecord>> {
  constructor(
    home: string,
    private readonly probe: NativeProcessProbe = nativeProcessProbe,
    private readonly boot = readNativeBoot(),
  ) {
    super(home, "native-tasks", (raw, id) => {
      const record = NativeTaskRecord.parse(raw);
      if (record.cellId !== id || new Set(record.runs.map((r) => r.id)).size !== record.runs.length)
        throw new Error("native task owner mismatch");
      return record;
    });
  }
  // Called synchronously before each spawn. A crash between spawn and identity persistence leaves
  // an explicit unknown launch, never a false exit. Tool callbacks cannot run before this returns.
  spawn(
    cellId: string,
    sessionId: string,
    launch: () => SpawnedProcess & { readonly pid?: number },
  ): SpawnedProcess {
    const before = this.read(cellId);
    if (before && before.sessionId !== sessionId && !before.settled)
      throw new Error("previous native task cleanup is unconfirmed");
    const retained =
      before?.sessionId === sessionId &&
      !before.settled &&
      this.state(cellId, sessionId) !== "exited"
        ? before.runs
        : [];
    const run = { id: ulid() };
    const record = NativeTaskRecord.parse({
      v: 1,
      route: "claude-code",
      cellId,
      sessionId,
      ...(this.boot ? { boot: this.boot } : {}),
      runs: [...retained, run],
    });
    this.write(cellId, record);
    let child: SpawnedProcess & { readonly pid?: number };
    try {
      child = launch();
    } catch (error) {
      this.write(cellId, { ...record, runs: [...retained, { ...run, neverStarted: true }] });
      throw error;
    }
    // Identity is read from the kernel and must name our direct child in its own process group.
    // No process is killed through a PID loaded from disk.
    try {
      const identity = child.pid ? this.probe.identity(child.pid) : undefined;
      if (identity) this.write(cellId, { ...record, runs: [...retained, { ...run, identity }] });
    } catch {
      /* The pre-spawn record remains unknown; ordinary driver cleanup still owns child. */
    }
    return child;
  }
  confirmed(sessionId: string): void {
    for (const record of this.list())
      if (record.sessionId === sessionId) {
        if (record.runs.some((run) => run.identity && this.probe.status(run.identity) === "alive"))
          throw new Error("native task descendants are still running");
        this.write(record.cellId, { ...record, settled: true });
      }
  }
  state(cellId: string, sessionId: string): NativeTaskState {
    const record = this.read(cellId);
    if (!record) return "legacy";
    if (record.cellId !== cellId || record.sessionId !== sessionId) return "unknown";
    if (record.settled) return "exited";
    if (this.boot && record.boot?.host === this.boot.host && record.boot.boot !== this.boot.boot)
      return "exited";
    if (!this.boot || !record.boot || this.boot.host !== record.boot.host) return "unknown";
    const states = record.runs.map((r) =>
      r.neverStarted ? "exited" : r.identity ? this.probe.status(r.identity) : "unknown",
    );
    return states.includes("alive")
      ? "alive"
      : states.every((s) => s === "exited")
        ? "exited"
        : "unknown";
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
