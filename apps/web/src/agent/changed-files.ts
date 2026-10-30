import { isComputerPath } from "@localdot/protocol";
import type { ComputerEntry, FilePatch } from "../deliverables/viewer/scope.tsx";
import type { AgentChange } from "./model.ts";

// The files a task changed on its computer, each once and in the order first changed, with every
// change the task made to it.
export function changedFiles(sessionId: string, changes: readonly AgentChange[]): ComputerEntry[] {
  const files = new Map<string, FilePatch[]>();
  for (const change of changes) {
    if (change.type !== "file" || !isComputerPath(change.path)) continue;
    const own = files.get(change.path) ?? [];
    own.push({ patch: change.patch, op: change.op, truncated: change.truncated });
    files.set(change.path, own);
  }
  return [...files].map(([path, patches]) => ({ sessionId, path, changes: patches }));
}
