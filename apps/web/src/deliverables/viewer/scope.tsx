import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import type { AgentResult } from "../../agent/model.ts";
import type { DownloadVersion, FileState, ResultDownloads } from "../../agent/ResultFiles.tsx";
import type { ApiClient } from "../../lib/api.ts";
import { ErrorBoundary } from "../../ui/ErrorBoundary.tsx";
import { showToast } from "../../ui/Toast.tsx";
import { FileViewer } from "./FileViewer.tsx";

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
// A file on dot's computer: one the user sent with a message, or one the task changed, with what
// the task changed in it.
export interface ComputerEntry {
  sessionId: string;
  path: string;
  changes?: readonly FilePatch[];
}
export interface FilePatch {
  patch?: string;
  op?: "create" | "modify" | "delete";
  truncated?: boolean;
}
export type AnyEntry = ViewerEntry | ComputerEntry;
export const isComputerEntry = (entry: AnyEntry): entry is ComputerEntry => "path" in entry;
export const anyEntryKey = (entry: AnyEntry) =>
  isComputerEntry(entry) ? `computer:${entry.sessionId}:${entry.path}` : entryKey(entry);
// How the viewer gets a file: its download's state, why it can't start now, and starting it.
export interface ViewerDownloads<E extends AnyEntry = AnyEntry> {
  state(entry: E): FileState | undefined;
  blocked(entry: E): string | undefined;
  request(entry: E, version?: DownloadVersion): void;
}
export function resultDownloads(
  downloads: Pick<ResultDownloads, "state" | "busy" | "request" | "sessionId">,
): ViewerDownloads<ViewerEntry> {
  return {
    state: (entry) => downloads.state(entry.resultId, entry.file),
    blocked: (entry) =>
      !downloads.sessionId
        ? "This task is no longer available."
        : downloads.busy && downloads.state(entry.resultId, entry.file) !== "busy"
          ? "Another download is still running."
          : undefined,
    request: (entry, version) => void downloads.request(entry.resultId, entry.file, version),
  };
}

const Context = createContext<((key: string, shown?: ShownVersion) => void) | null>(null);

// Opens the full preview of a file in the nearest list of files, or null outside one.
export function useFileViewer(): ((key: string, shown?: ShownVersion) => void) | null {
  return useContext(Context);
}

// A list of files whose rows open the full preview, which then moves between the list's files.
// The sheet shell is always ready; heavy document renderers load inside it.
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
  const getting = useMemo(() => resultDownloads(downloads), [downloads]);
  return (
    <Context.Provider value={open}>
      {children}
      {viewing && index >= 0 && (
        <ErrorBoundary floating>
          <FileViewer
            api={api}
            entries={entries}
            index={index}
            shown={viewing.shown && { key: viewing.key, ...viewing.shown }}
            open={viewing.open}
            downloads={getting}
            onMac={onMac}
            onIndex={(next) => {
              const key = keys[next];
              if (key) setViewing({ open: true, key });
            }}
            onClose={() => setViewing((was) => was && { ...was, open: false })}
          />
        </ErrorBoundary>
      )}
    </Context.Provider>
  );
}
