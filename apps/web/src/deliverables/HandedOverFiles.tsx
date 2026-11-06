import { ulidTime } from "@localdot/protocol";
import { useMemo, useRef } from "react";
import type { AgentResult } from "../agent/model.ts";
import { useResultDownloads } from "../agent/ResultFiles.tsx";
import { timeLabel } from "../agent/thread.ts";
import type { ApiClient } from "../lib/api.ts";
import { useVirtualRows } from "../ui/useVirtualRows.ts";
import { DeliverableFile } from "./DeliverableFile.tsx";
import { FileViewerScope } from "./viewer/scope.tsx";

const estimateFile = () => 64;
type Handed = { result: AgentResult; file: AgentResult["files"][number] };

// Each task's file name once, as its latest result handed it over. Two tasks' files of one name are
// two files, unless a revision says otherwise, which the daemon has already settled.
export function latestFiles(results: readonly AgentResult[]): Handed[] {
  const latest = new Map<string, Handed>();
  for (const result of results)
    for (const file of result.files) {
      const key = `${result.sessionId ?? ""}/${file.name}`;
      latest.delete(key);
      latest.set(key, { result, file });
    }
  return [...latest.values()];
}

// The files a conversation handed over, in the panel, newest first: the same rows as in their
// results, closed and flat, each saying when once they come from more than one task.
export function HandedOverFiles({
  api,
  sessionId,
  results,
  onMac,
}: {
  api: ApiClient;
  sessionId: string;
  results: readonly AgentResult[];
  onMac: boolean;
}) {
  const downloads = useResultDownloads(api, sessionId, results);
  const files = useMemo(() => latestFiles(results).reverse(), [results]);
  const tasks = new Set(results.map((result) => result.sessionId ?? sessionId));
  const whenOf = (result: AgentResult): string | undefined =>
    tasks.size > 1 && result.at !== undefined
      ? timeLabel(ulidTime(result.sessionId ?? sessionId) + result.at / 1000)
      : undefined;
  const entries = useMemo(
    () =>
      files.map(({ result, file }) => ({
        resultId: result.id,
        file,
        sessionId: result.sessionId ?? sessionId,
      })),
    [files, sessionId],
  );
  const list = useRef<HTMLUListElement>(null);
  const keys = useMemo(() => files.map(({ result, file }) => `${result.id}/${file.name}`), [files]);
  const windowed = useVirtualRows(list, keys, estimateFile);
  return (
    <FileViewerScope api={api} entries={entries} downloads={downloads} onMac={onMac}>
      <ul ref={list} className="deliverables activity-deliverables" aria-label="Handed over">
        <li aria-hidden="true" style={{ height: windowed.before }} />
        {windowed.indexes.map((index) => {
          const item = files[index];
          if (!item) return null;
          const { result, file } = item;
          return (
            <DeliverableFile
              measure={windowed.measure}
              index={index}
              key={`${result.id}/${file.name}`}
              api={api}
              sessionId={result.sessionId ?? sessionId}
              resultId={result.id}
              file={file}
              downloads={downloads}
              refresh={results.length}
              onMac={onMac}
              when={whenOf(result)}
            />
          );
        })}
        <li aria-hidden="true" style={{ height: windowed.after }} />
      </ul>
    </FileViewerScope>
  );
}
