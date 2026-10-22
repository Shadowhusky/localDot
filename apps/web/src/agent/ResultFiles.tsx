import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { bytes, count } from "../copy/format.ts";
import { downloadVersion, isLoopbackPage } from "../deliverables/api.ts";
import { DeliverableFile } from "../deliverables/DeliverableFile.tsx";
import { ProofStrip, ReplayRow } from "../deliverables/ProofStrip.tsx";
import { useProof } from "../deliverables/useProof.ts";
import { FileViewerScope, type ViewerEntry } from "../deliverables/viewer/scope.tsx";
import type { ApiClient } from "../lib/api.ts";
import { Button } from "../ui/Button.tsx";
import { Card, FileRow } from "../ui/Card.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { downloadResult, FILE_LIMITS, safeTransferName } from "./file-transfer.ts";
import type { AgentResult } from "./model.ts";
import { SafeMarkdown } from "./SafeMarkdown.tsx";

type ResultFile = AgentResult["files"][number];
// The stored version a download fetches, by the task that handed it over and its number.
export interface DownloadVersion {
  readonly sessionId: string;
  readonly version: number | null;
}
interface Selection {
  resultId: string;
  file: ResultFile;
  // A version the user chose to look at; otherwise the file's own version.
  version?: DownloadVersion;
  api: ApiClient;
  sessionId: string;
  // The task whose file it is: an earlier task's result keeps its own.
  task: string;
  abort: AbortController;
}
export type FileState = "busy" | "done" | "failed";
// How long a finished download shows its check.
const DONE_MS = 1500;
// A result shows this many files and folds the rest behind Show more, unless that would fold one.
const FOLD_AFTER = 3;

const fileKey = (resultId: string, file: ResultFile) => `${resultId}/${file.name}`;
const valid = (file: ResultFile) =>
  safeTransferName(file.name) &&
  Number.isSafeInteger(file.bytes) &&
  file.bytes >= 0 &&
  file.bytes <= FILE_LIMITS.bytes;

function present(results: readonly AgentResult[], selection: Selection): boolean {
  return results.some(
    (result) =>
      result.id === selection.resultId &&
      result.files.some(
        (file) =>
          file.name === selection.file.name &&
          file.path === selection.file.path &&
          file.bytes === selection.file.bytes,
      ),
  );
}

// One download at a time across the task's results. A file is fetched only on the user's press,
// by this session's validated name, and handed to the browser as an inert attachment.
export function useResultDownloads(
  api: ApiClient | null,
  sessionId: string | null,
  results: readonly AgentResult[],
  announce?: (text: string) => void,
) {
  const [states, setStates] = useState<ReadonlyMap<string, FileState>>(new Map());
  const current = useRef({ api, sessionId, results, announce }),
    active = useRef<Selection | null>(null),
    mounted = useRef(true),
    urls = useRef(new Set<string>()),
    timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const mark = useCallback((key: string, state: FileState | null) => {
    setStates((old) => {
      const next = new Map(old);
      if (state) next.set(key, state);
      else next.delete(key);
      return next;
    });
  }, []);
  const release = useCallback(() => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current.clear();
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current.clear();
  }, []);
  const retire = useCallback(() => {
    active.current?.abort.abort();
    active.current = null;
    release();
    if (mounted.current) setStates(new Map());
  }, [release]);
  useLayoutEffect(() => {
    const old = current.current;
    current.current = { api, sessionId, results, announce };
    if (
      old.api !== api ||
      old.sessionId !== sessionId ||
      (active.current && !present(results, active.current))
    )
      retire();
  }, [api, sessionId, results, announce, retire]);
  useEffect(() => {
    mounted.current = true;
    const hidden = () => {
      if (document.visibilityState === "hidden") retire();
    };
    window.addEventListener("pagehide", retire);
    window.addEventListener("offline", retire);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      mounted.current = false;
      retire();
      window.removeEventListener("pagehide", retire);
      window.removeEventListener("offline", retire);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [retire]);

  const request = useCallback(
    async (resultId: string, file: ResultFile, version?: DownloadVersion): Promise<boolean> => {
      const owner = current.current;
      if (
        active.current ||
        !owner.api ||
        !owner.sessionId ||
        !navigator.onLine ||
        document.visibilityState === "hidden" ||
        !valid(file)
      )
        return false;
      const record: Selection = {
        resultId,
        file,
        api: owner.api,
        sessionId: owner.sessionId,
        task: owner.results.find((result) => result.id === resultId)?.sessionId ?? owner.sessionId,
        abort: new AbortController(),
        ...(version ? { version } : {}),
      };
      if (!present(owner.results, record)) return false;
      release();
      active.current = record;
      const key = fileKey(resultId, file);
      mark(key, "busy");
      const owns = () =>
        mounted.current &&
        active.current === record &&
        current.current.api === record.api &&
        current.current.sessionId === record.sessionId &&
        present(current.current.results, record) &&
        !record.abort.signal.aborted;
      let saved = false;
      try {
        // The model's arbitrary path is never a fetch target; only this session's validated name is
        // used. A card fetches its own version: a later result may have replaced the newest copy.
        const chosen = record.version ?? {
          sessionId: record.task,
          version: record.file.version ?? null,
        };
        const blob =
          chosen.version === null
            ? await downloadResult(
                record.api,
                chosen.sessionId,
                record.file.name,
                record.abort.signal,
              )
            : await downloadVersion(
                record.api,
                chosen.sessionId,
                record.file.name,
                chosen.version,
                record.abort.signal,
              );
        if (!owns()) return false;
        const url = URL.createObjectURL(blob);
        urls.current.add(url);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = record.file.name;
        anchor.hidden = true;
        anchor.rel = "noopener noreferrer";
        try {
          document.body.append(anchor);
          anchor.click();
          saved = true;
          mark(key, "done");
          current.current.announce?.(`${record.file.name} downloaded.`);
          const done = setTimeout(() => {
            timers.current.delete(done);
            if (mounted.current) mark(key, null);
          }, DONE_MS);
          timers.current.add(done);
        } finally {
          anchor.remove();
          const timer = setTimeout(() => {
            URL.revokeObjectURL(url);
            urls.current.delete(url);
            timers.current.delete(timer);
          }, 1000);
          timers.current.add(timer);
        }
      } catch {
        if (owns()) {
          mark(key, "failed");
          current.current.announce?.(`${record.file.name} couldn't be downloaded. Try again.`);
        }
      } finally {
        if (active.current === record) {
          active.current = null;
          record.abort.abort();
        }
      }
      return saved;
    },
    [mark, release],
  );
  const cancel = useCallback(() => {
    const record = active.current;
    if (!record) return;
    active.current = null;
    record.abort.abort();
    mark(fileKey(record.resultId, record.file), null);
    current.current.announce?.("Download cancelled.");
  }, [mark]);
  // The same object until a download's state changes, so the results that show it redraw only then.
  return useMemo(
    () => ({
      state: (resultId: string, file: ResultFile) => states.get(fileKey(resultId, file)),
      busy: [...states.values()].includes("busy"),
      request,
      cancel,
      api,
      sessionId: api ? sessionId : null,
    }),
    [states, request, cancel, api, sessionId],
  );
}
export type ResultDownloads = ReturnType<typeof useResultDownloads>;

// Keeps the end of a long name (its extension) in view; the middle gives way.
export function FileName({ name }: { name: string }) {
  const tail = Math.min(8, Math.max(0, name.length - 4));
  return (
    <span className="file-name" title={name}>
      <span className="file-name-head">{name.slice(0, name.length - tail)}</span>
      <span className="file-name-tail">{name.slice(name.length - tail)}</span>
    </span>
  );
}

// A list's files open the full preview once the list knows its task.
function ViewerScope({
  api,
  entries,
  downloads,
  onMac,
  children,
}: {
  api: ApiClient | null;
  entries: ViewerEntry[];
  downloads: ResultDownloads;
  onMac: boolean;
  children: ReactNode;
}) {
  if (!api || entries.length === 0) return children;
  return (
    <FileViewerScope api={api} entries={entries} downloads={downloads} onMac={onMac}>
      {children}
    </FileViewerScope>
  );
}

export interface ResultCardProps {
  result: AgentResult;
  downloads: ResultDownloads;
  // Opens the task in Replay when its proof can't be read.
  onReplay?: () => void;
  // Changes when the conversation gets another result, so each file's versions are read again.
  refresh?: number;
  onMac?: boolean;
  // A composer is in reach to take a revision.
  revisable?: boolean;
}

// A result: what dot says it did, the files it handed over, and the proof of the work. In the chat
// it stays short: one line a file, previews closed, and the files after the first few folded away.
export function ResultCard({
  result,
  downloads,
  onReplay,
  refresh = 0,
  onMac = isLoopbackPage(),
  revisable = true,
}: ResultCardProps) {
  const files = result.files;
  const api = downloads.api;
  const task = result.sessionId ?? downloads.sessionId;
  const list = useId();
  const [unfolded, setUnfolded] = useState(false);
  const folds = files.length > FOLD_AFTER + 1;
  const shown = folds && !unfolded ? files.slice(0, FOLD_AFTER) : files;
  const entries = useMemo<ViewerEntry[]>(
    () =>
      task
        ? files.filter(valid).map((file) => ({ resultId: result.id, file, sessionId: task }))
        : [],
    [files, result.id, task],
  );
  const all = async () => {
    for (const file of files)
      if (valid(file) && !(await downloads.request(result.id, file))) return;
  };
  const downloadAll = files.length > 1 && (
    <Button
      size="sm"
      icon="download"
      variant="quiet"
      aria-label={`Download all ${count(files.length, "file", "files")}`}
      disabledReason={
        !downloads.sessionId
          ? "This task is no longer available."
          : downloads.busy
            ? "Another download is still running."
            : undefined
      }
      onClick={() => void all()}
    >
      Download all
    </Button>
  );
  const folded = files.length - FOLD_AFTER;
  return (
    <section className="result-card" aria-label="Task result">
      {result.summary && (
        <div className="result-summary">
          <SafeMarkdown text={result.summary} />
        </div>
      )}
      {files.length > 0 && (
        <Card variant="file" className="result-files">
          {downloadAll && (
            <div className="deliverables-head">
              <span className="deliverables-count num">{count(files.length, "file", "files")}</span>
              {downloadAll}
            </div>
          )}
          <ViewerScope api={api} entries={entries} downloads={downloads} onMac={onMac}>
            <ul id={list} className="deliverables" aria-label={`Files in result ${result.id}`}>
              {shown.map((file, index) =>
                valid(file) && api && task ? (
                  <DeliverableFile
                    key={`${file.name}/${file.version ?? 0}`}
                    api={api}
                    sessionId={task}
                    resultId={result.id}
                    file={file}
                    downloads={downloads}
                    refresh={refresh}
                    onMac={onMac}
                    revisable={revisable}
                    compact
                  />
                ) : valid(file) ? (
                  // Without its task the file is still listed, with nothing it can do.
                  <li key={file.name} className="deliverable">
                    <FileRow
                      name={file.name}
                      meta={bytes(file.bytes)}
                      compact
                      actions={
                        <IconButton
                          icon="download"
                          label={`Download ${file.name}`}
                          disabledReason="This task is no longer available."
                        />
                      }
                    />
                  </li>
                ) : (
                  // biome-ignore lint/suspicious/noArrayIndexKey: an unsafe name is never shown or used as a key.
                  <li key={index} className="deliverable">
                    <FileRow name="Unavailable file" meta="Can't be downloaded" compact />
                  </li>
                ),
              )}
            </ul>
          </ViewerScope>
          {folds && (
            <div className="deliverables-more">
              <Button
                variant="quiet"
                size="sm"
                aria-expanded={unfolded}
                aria-controls={list}
                aria-label={
                  unfolded ? "Show fewer files" : `Show ${count(folded, "more file", "more files")}`
                }
                onClick={() => setUnfolded((was) => !was)}
              >
                {unfolded ? "Show fewer" : `Show ${folded.toLocaleString()} more`}
              </Button>
            </div>
          )}
        </Card>
      )}
      {api && task ? (
        <ResultProof
          api={api}
          task={task}
          resultId={result.id}
          refresh={refresh}
          onReplay={onReplay}
        />
      ) : (
        onReplay && <ReplayRow onReplay={onReplay} />
      )}
    </section>
  );
}

function ResultProof({
  api,
  task,
  resultId,
  refresh,
  onReplay,
}: {
  api: ApiClient;
  task: string;
  resultId: string;
  refresh: number;
  onReplay?: () => void;
}) {
  const proof = useProof(api, task, refresh);
  return (
    <ProofStrip api={api} sessionId={task} resultId={resultId} proof={proof} onReplay={onReplay} />
  );
}
