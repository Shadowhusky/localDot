import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { QuarantineItem } from "../../../../packages/protocol/src/quarantine.ts";
import { count } from "../copy/format.ts";
import type { ApiClient } from "../lib/api.ts";
import { changeDownload, listDownloads } from "./download-api.ts";
import "../agent/safety.css";
import "./downloads.css";

type Decision = { item: QuarantineItem; action: "release" | "discard" };
const REFRESH_FAILED = "Downloads could not be refreshed. Check the computer and try again.";
const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} bytes`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / 1048576).toFixed(1)} MiB`;
const stateLabel = (item: QuarantineItem) =>
  item.state === "held"
    ? "Waiting for your review"
    : item.state === "releasing"
      ? "Delivery needs checking"
      : item.state === "released"
        ? `Saved to ${item.receipt.path}`
        : item.state === "failed"
          ? "File verification failed"
          : "Discarded";

export function BrowserDownloads({
  api,
  cellId,
  releaseReady,
}: {
  api: ApiClient;
  cellId: string;
  releaseReady: boolean;
}) {
  const [items, setItems] = useState<QuarantineItem[]>([]);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [limit, setLimit] = useState(12);
  const owner = useRef(0);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const poll = useRef<() => Promise<void>>(async () => {});
  const operation = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const epoch = ++owner.current;
    const abort = new AbortController();
    let loading: Promise<void> | undefined;
    // A computer that is still starting refuses the list, so a background failure counts only
    // after a list has loaded once; a refresh the user asked for always reports.
    let loaded = false;
    let asked = false;
    setItems([]);
    setDecision(null);
    setPending(false);
    setMessage(null);
    setLimit(12);
    const load = (explicit = false) => {
      asked ||= explicit;
      if (loading) return loading;
      loading = (async () => {
        try {
          const next = await listDownloads(api, cellId, abort.signal);
          if (epoch === owner.current && !abort.signal.aborted) {
            loaded = true;
            setItems(next);
            setMessage((shown) => (shown === REFRESH_FAILED ? null : shown));
          }
        } catch {
          if (epoch === owner.current && !abort.signal.aborted && (loaded || asked))
            setMessage(REFRESH_FAILED);
        } finally {
          loading = undefined;
          asked = false;
        }
      })();
      return loading;
    };
    refresh.current = () => load(true);
    poll.current = () => load();
    void load();
    return () => {
      owner.current++;
      abort.abort();
      operation.current?.abort();
      operation.current = null;
    };
  }, [api, cellId]);
  const visible = items.filter((item) => item.state !== "discarded");
  const waiting = visible.filter(
    (item) => item.state === "held" || item.state === "releasing",
  ).length;
  const polling = releaseReady || waiting > 0;
  useEffect(() => {
    if (!polling) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await poll.current();
      if (!stopped) timer = setTimeout(() => void tick(), 2000);
    };
    timer = setTimeout(() => void tick(), 2000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [polling]);
  useEffect(() => {
    if (!decision) return;
    heading.current?.focus({ preventScroll: true });
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) {
        setDecision(null);
        trigger.current?.focus();
      }
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [decision, pending]);
  const current = decision && items.find((item) => item.id === decision.item.id);
  const matches = !!current && JSON.stringify(current) === JSON.stringify(decision?.item);
  const confirm = async () => {
    if (
      !decision ||
      !matches ||
      pending ||
      operation.current ||
      (decision.action === "release" && !releaseReady)
    )
      return;
    const epoch = owner.current,
      abort = new AbortController(),
      selected = decision;
    operation.current = abort;
    setPending(true);
    setMessage(null);
    try {
      const item = await changeDownload(api, cellId, selected.item, selected.action, abort.signal);
      if (epoch !== owner.current) return;
      setItems((rows) => rows.map((row) => (row.id === item.id ? item : row)));
      setMessage(
        item.state === "released"
          ? `Saved ${item.name} to ${item.receipt.path}.`
          : item.state === "discarded"
            ? `Discarded ${item.name}.`
            : "The earlier transfer did not save this file. Review it again to release it.",
      );
    } catch {
      if (epoch === owner.current)
        setMessage(
          "The change was not confirmed. Refresh the download status before trying again.",
        );
    } finally {
      if (epoch === owner.current) {
        operation.current = null;
        setPending(false);
        setDecision(null);
        trigger.current?.focus();
        await refresh.current();
      }
    }
  };
  const choose = (item: QuarantineItem, action: Decision["action"], element: HTMLButtonElement) => {
    trigger.current = element;
    setDecision({ item: structuredClone(item), action });
  };
  return (
    <section className="browser-downloads" aria-label="Browser downloads">
      <details open={waiting > 0}>
        <summary>
          Browser downloads{" "}
          <span>
            {waiting
              ? `${waiting} waiting`
              : visible.length
                ? count(visible.length, "file", "files")
                : ""}
          </span>
        </summary>
        <p className="download-intro">
          Review downloaded files before saving them to this computer.
        </p>
        {!visible.length && <p>No browser downloads yet.</p>}
        <ul>
          {visible.slice(0, limit).map((item) => (
            <li key={item.id}>
              <strong>{item.name}</strong>
              <span className="download-meta">
                {size(item.bytes)} · {item.source} · {item.kind}
              </span>
              <span className={`download-state download-${item.state}`}>{stateLabel(item)}</span>
              {item.state === "held" && item.recovery && (
                <span className="download-meta">
                  The earlier transfer did not save this file. A new review is required.
                </span>
              )}
              <div className="download-actions">
                {(item.state === "held" || item.state === "releasing") && (
                  <button
                    type="button"
                    disabled={!releaseReady || pending}
                    onClick={(event) => choose(item, "release", event.currentTarget)}
                  >
                    {item.state === "releasing" ? "Check delivery" : "Review & release"}
                  </button>
                )}
                {(item.state === "held" || item.state === "failed") && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={(event) => choose(item, "discard", event.currentTarget)}
                  >
                    Discard
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {visible.length > limit && (
          <button type="button" onClick={() => setLimit((count) => count + 12)}>
            Show more downloads
          </button>
        )}
        {!releaseReady && waiting > 0 && <p>Resume the computer to release a file.</p>}
        <button type="button" disabled={pending} onClick={() => void refresh.current()}>
          Refresh downloads
        </button>
      </details>
      {message && (
        <p role="status" className="download-message">
          {message}
        </p>
      )}
      {decision &&
        createPortal(
          <div className="approval-overlay download-overlay">
            <section
              className="approval-card"
              role="dialog"
              aria-modal="false"
              aria-labelledby="download-decision-title"
            >
              <div className="approval-content">
                <p className="safety-eyebrow">Browser download · Your decision</p>
                <h2 id="download-decision-title" tabIndex={-1} ref={heading}>
                  {decision.action === "discard"
                    ? "Discard this download?"
                    : decision.item.state === "releasing"
                      ? "Check earlier delivery"
                      : "Release to this computer?"}
                </h2>
                <dl>
                  {[
                    ["File", decision.item.name],
                    ["Size", `${size(decision.item.bytes)} (${decision.item.bytes} bytes)`],
                    ["Source", decision.item.source],
                    ["Type", decision.item.kind],
                    ["SHA-256", decision.item.sha256],
                    ...(decision.action === "release"
                      ? [["Destination", "This computer’s Downloads folder"]]
                      : []),
                  ].map(([label, text]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{text}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <div className="approval-footer">
                <p role="status">
                  {!matches
                    ? "This download changed. Cancel and refresh its status."
                    : pending
                      ? "Checking the file and confirming the operation…"
                      : decision.action === "discard"
                        ? "This removes the held copy. You will need to download it again to recover it."
                        : decision.item.state === "releasing"
                          ? "Check whether the earlier transfer reached the computer."
                          : "Save this verified file to the computer’s Downloads folder."}
                </p>
                <div className="safety-actions download-decision-actions">
                  <button
                    type="button"
                    disabled={
                      !matches || pending || (decision.action === "release" && !releaseReady)
                    }
                    onClick={() => void confirm()}
                  >
                    {decision.action === "discard"
                      ? "Discard download"
                      : decision.item.state === "releasing"
                        ? "Check delivery"
                        : "Release once"}
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      setDecision(null);
                      trigger.current?.focus();
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </section>
          </div>,
          document.body,
        )}
    </section>
  );
}
