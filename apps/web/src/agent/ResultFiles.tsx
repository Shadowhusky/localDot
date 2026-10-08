import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { Button } from "../ui/Button.tsx";
import { downloadResult, FILE_LIMITS, safeTransferName } from "./file-transfer.ts";
import type { AgentResult } from "./model.ts";

type FileRow = AgentResult["files"][number];
const bytes = (value: number) =>
  value < 1024
    ? `${value.toLocaleString()} bytes`
    : value < 1024 * 1024
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / (1024 * 1024)).toFixed(1)} MB`;
interface Selection {
  resultId: string;
  file: FileRow;
  api: ApiClient;
  sessionId: string;
  abort: AbortController;
}
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
export function ResultFiles({
  api,
  sessionId,
  results,
  ended,
  idle,
}: {
  api: ApiClient;
  sessionId: string | null;
  results: readonly AgentResult[];
  ended: boolean;
  idle: boolean;
}) {
  const [pending, setPending] = useState(false),
    [message, setMessage] = useState<string | null>(null);
  const current = useRef({ api, sessionId, results }),
    active = useRef<Selection | null>(null),
    mounted = useRef(true),
    urls = useRef(new Set<string>()),
    timers = useRef(new Set<ReturnType<typeof setTimeout>>());
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
    if (mounted.current) {
      setPending(false);
      setMessage(null);
    }
  }, [release]);
  useLayoutEffect(() => {
    const old = current.current;
    current.current = { api, sessionId, results };
    if (
      old.api !== api ||
      old.sessionId !== sessionId ||
      (active.current && !present(results, active.current))
    )
      retire();
  }, [api, sessionId, results, retire]);
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
  const request = async (resultId: string, file: FileRow) => {
    const owner = current.current;
    if (
      active.current ||
      !owner.sessionId ||
      !navigator.onLine ||
      document.visibilityState === "hidden" ||
      !safeTransferName(file.name) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > FILE_LIMITS.bytes
    )
      return;
    const record: Selection = {
      resultId,
      file,
      api: owner.api,
      sessionId: owner.sessionId,
      abort: new AbortController(),
    };
    if (!present(owner.results, record)) return;
    release();
    active.current = record;
    setPending(true);
    setMessage(null);
    const owns = () =>
      mounted.current &&
      active.current === record &&
      current.current.api === record.api &&
      current.current.sessionId === record.sessionId &&
      present(current.current.results, record) &&
      !record.abort.signal.aborted;
    try {
      // The model's arbitrary path is never a fetch target; only this session's validated name is used.
      const blob = await downloadResult(
        record.api,
        record.sessionId,
        record.file.name,
        record.abort.signal,
      );
      if (!owns()) return;
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
        setMessage("Download requested. Check your browser's downloads.");
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
      if (owns())
        setMessage("The download was cancelled or could not be verified. You can try it again.");
    } finally {
      if (active.current === record) {
        active.current = null;
        record.abort.abort();
        if (mounted.current) setPending(false);
      }
    }
  };
  if (!results.length) return null;
  const latest = results.at(-1);
  return (
    <section className="activity-results" aria-label="Result files">
      {results.map((result) => (
        <section key={result.id} className="activity-result" aria-label="Task result">
          <div className="activity-section-head">
            <h3 className="activity-section-title">Result</h3>
            {result !== latest ? (
              <span className="activity-section-meta">Earlier</span>
            ) : ended ? (
              <span className="activity-section-meta">Task ended</span>
            ) : idle ? (
              <span className="activity-section-meta">Ready for a follow-up</span>
            ) : null}
          </div>
          <p className="result-summary">{result.summary}</p>
          {result.files.length > 0 && (
            <ul className="activity-files" aria-label={`Files in result ${result.id}`}>
              {result.files.map((file) => {
                const valid =
                  safeTransferName(file.name) &&
                  Number.isSafeInteger(file.bytes) &&
                  file.bytes >= 0 &&
                  file.bytes <= FILE_LIMITS.bytes;
                return (
                  <li key={file.name} className="activity-file">
                    <span className="activity-file-name">
                      {valid ? file.name : "Unavailable file name"}
                    </span>
                    <span className="activity-file-size num">
                      {valid ? bytes(file.bytes) : "Can't be downloaded"}
                    </span>
                    <Button
                      size="sm"
                      aria-label={valid ? `Download ${file.name}` : "Unavailable file"}
                      disabledReason={
                        !valid
                          ? "This file can't be downloaded."
                          : !sessionId
                            ? "This task is no longer available."
                            : pending
                              ? "Another download is still running."
                              : undefined
                      }
                      onClick={() => void request(result.id, file)}
                    >
                      Download
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}
      {results.some((result) => result.files.length) && (
        <p className="activity-note">
          Files download to this device. They never open on their own.
        </p>
      )}
      {(pending || message) && (
        <div className="activity-files-status">
          {pending && (
            <Button
              variant="quiet"
              size="sm"
              onClick={() => {
                retire();
                setMessage("Download cancelled.");
              }}
            >
              Cancel download
            </Button>
          )}
          <p role="status">{message}</p>
        </div>
      )}
    </section>
  );
}
