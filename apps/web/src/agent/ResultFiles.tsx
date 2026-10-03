import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { downloadResult, FILE_LIMITS, safeTransferName } from "./file-transfer.ts";
import type { AgentResult } from "./model.ts";
import "./files.css";

type FileRow = AgentResult["files"][number];
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
  renderResult,
}: {
  api: ApiClient;
  sessionId: string | null;
  results: readonly AgentResult[];
  renderResult?: (result: AgentResult, files: ReactNode) => ReactNode;
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
  if (!results.length || (!renderResult && !results.some((result) => result.files.length)))
    return null;
  return (
    <section className="result-files" aria-label="Result files">
      <h3>{renderResult ? "Results" : "Result files"}</h3>
      <p className="history-note">
        Download files to inspect them. Files are not opened automatically.
      </p>
      {results.map((result) => {
        const files = (
          <ul key={result.id} aria-label={`Files in result ${result.id}`}>
            {result.files.map((file) => {
              const valid =
                safeTransferName(file.name) &&
                Number.isSafeInteger(file.bytes) &&
                file.bytes >= 0 &&
                file.bytes <= FILE_LIMITS.bytes;
              return (
                <li key={file.name}>
                  <span>{valid ? file.name : "Unavailable file name"}</span>
                  <span>
                    {valid
                      ? `${file.bytes.toLocaleString()} bytes`
                      : "This file cannot be downloaded."}
                  </span>
                  <button
                    type="button"
                    disabled={!valid || !sessionId || pending}
                    onClick={() => void request(result.id, file)}
                    aria-label={valid ? `Download ${file.name}` : "Unavailable file"}
                  >
                    Download
                  </button>
                </li>
              );
            })}
          </ul>
        );
        return (
          <div key={result.id}>
            {renderResult ? renderResult(result, result.files.length ? files : null) : files}
          </div>
        );
      })}
      {pending && (
        <button
          type="button"
          onClick={() => {
            retire();
            setMessage("Download cancelled.");
          }}
        >
          Cancel download
        </button>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
