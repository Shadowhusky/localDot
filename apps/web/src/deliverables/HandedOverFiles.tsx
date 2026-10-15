import { useMemo, useRef } from "react";
import type { AgentResult } from "../agent/model.ts";
import { useResultDownloads } from "../agent/ResultFiles.tsx";
import type { ApiClient } from "../lib/api.ts";
import { useVirtualRows } from "../ui/useVirtualRows.ts";
import { DeliverableFile } from "./DeliverableFile.tsx";
import { FileViewerScope } from "./viewer/scope.tsx";

const estimateFile = () => 64;
type Handed = { result: AgentResult; file: AgentResult["files"][number] };

// Each file name once, as the latest result handed it over.
export function latestFiles(results: readonly AgentResult[]): Handed[] {
  const latest = new Map<string, Handed>();
  for (const result of results)
    for (const file of result.files) {
      latest.delete(file.name);
      latest.set(file.name, { result, file });
    }
  return [...latest.values()];
}

// The files a task handed over, in Activity: the same rows as in its result, closed and flat.
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
  const files = useMemo(() => latestFiles(results), [results]);
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
            />
          );
        })}
        <li aria-hidden="true" style={{ height: windowed.after }} />
      </ul>
    </FileViewerScope>
  );
}
