import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { bytes, count } from "../copy/format.ts";
import type { ApiClient } from "../lib/api.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Spinner } from "../ui/Spinner.tsx";
import { downloadResult, FILE_LIMITS, safeTransferName } from "./file-transfer.ts";
import type { AgentResult } from "./model.ts";

type FileRow = AgentResult["files"][number];
interface Selection {
  resultId: string;
  file: FileRow;
  api: ApiClient;
  sessionId: string;
  abort: AbortController;
}
export type FileState = "busy" | "done" | "failed";
// How long a finished download shows its check.
const DONE_MS = 1500;

const fileKey = (resultId: string, file: FileRow) => `${resultId}/${file.name}`;
const valid = (file: FileRow) =>
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
    async (resultId: string, file: FileRow): Promise<boolean> => {
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
        abort: new AbortController(),
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
        // The model's arbitrary path is never a fetch target; only this session's validated name is used.
        const blob = await downloadResult(
          record.api,
          record.sessionId,
          record.file.name,
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
      state: (resultId: string, file: FileRow) => states.get(fileKey(resultId, file)),
      busy: [...states.values()].includes("busy"),
      request,
      cancel,
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

function extension(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && name.length - dot <= 5 ? name.slice(dot + 1).toUpperCase() : "";
}

export function ResultCard({
  result,
  downloads,
  onReplay,
}: {
  result: AgentResult;
  downloads: ResultDownloads;
  onReplay?: () => void;
}) {
  const files = result.files;
  const all = async () => {
    for (const file of files)
      if (valid(file) && !(await downloads.request(result.id, file))) return;
  };
  return (
    <section className="result-card" aria-label="Task result">
      <p className="result-summary">{result.summary}</p>
      {files.length > 0 && (
        <ul className="result-files" aria-label={`Files in result ${result.id}`}>
          {files.map((file) => {
            const ok = valid(file);
            const state = downloads.state(result.id, file);
            const type = ok ? extension(file.name) : "";
            return (
              <li key={file.name} className="result-file" data-state={state}>
                <span className="result-file-tile" aria-hidden="true">
                  {type || <Icon name="file" size={16} />}
                </span>
                <span className="result-file-text">
                  {ok ? <FileName name={file.name} /> : <span>Unavailable file name</span>}
                  <span className="result-file-meta num">
                    {!ok
                      ? "Can't be downloaded"
                      : state === "busy"
                        ? "Downloading…"
                        : state === "failed"
                          ? "Couldn't download. Try again."
                          : bytes(file.bytes)}
                  </span>
                </span>
                <span className="result-file-action">
                  {state === "busy" && <Spinner className="result-file-ring" />}
                  <IconButton
                    icon={state === "busy" ? "x" : state === "done" ? "check" : "download"}
                    label={
                      state === "busy"
                        ? "Cancel download"
                        : ok
                          ? `Download ${file.name}`
                          : "Unavailable file"
                    }
                    data-state={state}
                    disabledReason={
                      state === "busy"
                        ? undefined
                        : !ok
                          ? "This file can't be downloaded."
                          : !downloads.sessionId
                            ? "This task is no longer available."
                            : downloads.busy
                              ? "Another download is still running."
                              : undefined
                    }
                    onClick={() => {
                      if (state === "busy") downloads.cancel();
                      else void downloads.request(result.id, file);
                    }}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {(files.length > 1 || onReplay) && (
        <div className="result-actions">
          {onReplay && (
            <Button
              variant="quiet"
              size="sm"
              icon="play"
              className="result-replay"
              aria-label="Replay this task"
              onClick={onReplay}
            >
              Replay
            </Button>
          )}
          {files.length > 1 && (
            <Button
              size="sm"
              icon="download"
              variant="quiet"
              className="result-all"
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
          )}
        </div>
      )}
      {files.length > 0 && (
        <p className="thread-note">Files download to this device. They never open on their own.</p>
      )}
    </section>
  );
}
