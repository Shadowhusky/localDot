import type { FileVersion } from "@localdot/protocol";
import type { TaskScan } from "./task-scan.ts";

export const LINEAGE_DEPTH = 16;
export interface LineageDeps {
  scan(id: string): Promise<TaskScan | undefined>;
  // Whether the bytes behind a version are still stored (legacy results have no number).
  stored(sessionId: string, name: string, version: number | null): boolean;
}

// Versions of one file across a task and the tasks it revises, oldest first. A revising task
// names its parent in session.start; only a parent link for the same file name is followed.
export async function fileVersions(
  deps: LineageDeps,
  sessionId: string,
  name: string,
): Promise<FileVersion[]> {
  const chain: { id: string; scan: TaskScan }[] = [];
  const seen = new Set<string>();
  let id: string | undefined = sessionId;
  while (id && !seen.has(id) && chain.length < LINEAGE_DEPTH) {
    seen.add(id);
    const scan = await deps.scan(id);
    if (!scan) break;
    chain.unshift({ id, scan });
    id = scan.revises?.name === name ? scan.revises.sessionId : undefined;
  }
  const versions: FileVersion[] = [];
  for (const { id, scan } of chain) {
    const mentions = scan.results.flatMap((result) =>
      result.files.filter((f) => f.name === name).map((file) => ({ result, file })),
    );
    mentions.forEach(({ result, file }, index) => {
      // A legacy result without a number is only the bytes in out/ if nothing replaced them.
      const reachable = file.version !== null || index === mentions.length - 1;
      versions.push({
        sessionId: id,
        version: file.version,
        label: 0,
        bytes: file.bytes,
        resultId: result.id,
        tMs: result.tMs,
        available: reachable && deps.stored(id, name, file.version),
      });
    });
  }
  return versions.map((v, i) => ({ ...v, label: i + 1 })).slice(-64);
}
