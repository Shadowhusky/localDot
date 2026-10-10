import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import type { AgentResult } from "../../agent/model.ts";
import type { ResultDownloads } from "../../agent/ResultFiles.tsx";
import type { ApiClient } from "../../lib/api.ts";
import { ErrorBoundary } from "../../ui/ErrorBoundary.tsx";
import { Sheet } from "../../ui/Sheet.tsx";
import { showToast } from "../../ui/Toast.tsx";
import { ViewerLoading } from "./states.tsx";

type ResultFile = AgentResult["files"][number];
// One file a list shows, by the result that handed it over and the task whose copy it is.
export interface ViewerEntry {
  resultId: string;
  file: ResultFile;
  sessionId: string;
}
// The version a row is showing, when it is not the file's own.
export interface ShownVersion {
  sessionId: string;
  version: number | null;
  bytes: number;
  label?: number;
}
export const entryKey = (entry: Pick<ViewerEntry, "resultId" | "file">) =>
  `${entry.resultId}/${entry.file.name}`;

const FileViewer = lazy(() =>
  import("./FileViewer.tsx").then((module) => ({ default: module.FileViewer })),
);
const Context = createContext<((key: string, shown?: ShownVersion) => void) | null>(null);

// Opens the full preview of a file in the nearest list of files, or null outside one.
export function useFileViewer(): ((key: string, shown?: ShownVersion) => void) | null {
  return useContext(Context);
}

// A list of files whose rows open the full preview, which then moves between the list's files.
// The previewer's code loads the first time a file is opened.
export function FileViewerScope({
  api,
  entries,
  downloads,
  onMac,
  children,
}: {
  api: ApiClient;
  entries: readonly ViewerEntry[];
  downloads: Pick<ResultDownloads, "state" | "busy" | "request" | "sessionId">;
  onMac: boolean;
  children: ReactNode;
}) {
  const [viewing, setViewing] = useState<{
    open: boolean;
    key: string;
    shown?: ShownVersion;
  } | null>(null);
  const keys = useMemo(() => entries.map(entryKey), [entries]);
  const open = useCallback(
    (key: string, shown?: ShownVersion) => {
      if (keys.includes(key)) setViewing({ open: true, key, shown });
      else
        showToast({
          title: "This file is no longer in the list. Reopen the task and try again.",
          tone: "neutral",
        });
    },
    [keys],
  );
  const index = viewing ? keys.indexOf(viewing.key) : -1;
  return (
    <Context.Provider value={open}>
      {children}
      {viewing && index >= 0 && (
        <ErrorBoundary floating>
          <Suspense
            fallback={
              <Sheet open={viewing.open} title="Opening file" onClose={() => setViewing(null)}>
                <ViewerLoading label="Loading the file viewer" />
              </Sheet>
            }
          >
            <FileViewer
              api={api}
              entries={entries}
              index={index}
              shown={viewing.shown && { key: viewing.key, ...viewing.shown }}
              open={viewing.open}
              downloads={downloads}
              onMac={onMac}
              onIndex={(next) => {
                const key = keys[next];
                if (key) setViewing({ open: true, key });
              }}
              onClose={() => setViewing((was) => was && { ...was, open: false })}
            />
          </Suspense>
        </ErrorBoundary>
      )}
    </Context.Provider>
  );
}
