import { useMemo } from "react";
import type { AgentResult } from "../agent/model.ts";
import { useResultDownloads } from "../agent/ResultFiles.tsx";
import type { ApiClient } from "../lib/api.ts";
import { Card } from "../ui/Card.tsx";
import { DeliverableFile } from "./DeliverableFile.tsx";
import { FileViewerScope } from "./viewer/scope.tsx";

// The files a recorded task handed over, beside its recording in Replay.
export function RecordingFiles({
  api,
  sessionId,
  files,
  onMac,
}: {
  api: ApiClient;
  sessionId: string;
  files: AgentResult["files"];
  onMac: boolean;
}) {
  const results = useMemo(() => [{ id: sessionId, summary: "", files }], [sessionId, files]);
  const downloads = useResultDownloads(api, sessionId, results);
  const entries = useMemo(
    () => files.map((file) => ({ resultId: sessionId, file, sessionId })),
    [files, sessionId],
  );
  return (
    <Card variant="file">
      <FileViewerScope api={api} entries={entries} downloads={downloads} onMac={onMac}>
        <ul className="deliverables" aria-label="Files">
          {files.map((file) => (
            <DeliverableFile
              key={`${file.name}/${file.version ?? 0}`}
              api={api}
              sessionId={sessionId}
              resultId={sessionId}
              file={file}
              downloads={downloads}
              refresh={files.length}
              onMac={onMac}
              revisable={false}
            />
          ))}
        </ul>
      </FileViewerScope>
    </Card>
  );
}
