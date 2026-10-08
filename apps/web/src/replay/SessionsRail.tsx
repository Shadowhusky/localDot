import { type SessionCard, SessionIndexPage } from "@localdot/protocol";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { ReplayImage } from "./ReplayImage.tsx";
import { timeLabel } from "./replay-view.ts";

function startedLabel(value: string): string {
  const started = new Date(value);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const time = started.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (started.toDateString() === today.toDateString()) return `Today ${time}`;
  if (started.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${started.toLocaleDateString()} ${time}`;
}
function DeleteSession({
  api,
  session,
  onClose,
  onDeleted,
}: {
  api: ApiClient;
  session: SessionCard;
  onClose(): void;
  onDeleted(id: string): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(false);
  const locked = useRef(false);
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement;
    dialog.current?.showModal?.();
    return () => {
      alive.current = false;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  const remove = async () => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.del(`/api/sessions/${session.id}`);
      if (alive.current) onDeleted(session.id);
    } catch (failure) {
      if (alive.current)
        setError(
          failure instanceof ApiError && failure.status === 409
            ? "This session is still live. Stop it before deleting."
            : "The session could not be deleted. Try again.",
        );
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return createPortal(
    <dialog
      ref={dialog}
      className="replay-delete-dialog"
      aria-labelledby="replay-delete-title"
      aria-describedby="replay-delete-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id="replay-delete-title">Delete this session?</h2>
      <div className="replay-delete-content">
        <p id="replay-delete-description">
          Its video, screenshots and log are removed from this Mac.
        </p>
        <p>{session.title ?? "Untitled session"}</p>
        {error && <p role="alert">{error}</p>}
      </div>
      <footer>
        <button type="button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button type="button" disabled={busy} onClick={() => void remove()}>
          {busy ? "Deleting…" : "Delete session"}
        </button>
      </footer>
    </dialog>,
    document.body,
  );
}

export function SessionsRail({
  api,
  selectedId,
  onSelect,
  onDeleted,
}: {
  api: ApiClient;
  selectedId: string | null;
  onSelect(id: string): void;
  onDeleted(id: string): void;
}) {
  const [sessions, setSessions] = useState<SessionCard[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [deleting, setDeleting] = useState<SessionCard | null>(null);
  const [revision, setRevision] = useState(0);
  const loadMore = useRef<() => void>(() => {});
  useEffect(() => {
    const controller = new AbortController();
    if (revision > 0) setSessions([]);
    let busy = false;
    let cursor: string | null = null;
    const load = async (initial: boolean) => {
      if (busy || (!initial && cursor === null)) return;
      busy = true;
      setLoading(true);
      setError(false);
      try {
        const page = SessionIndexPage.parse(
          await api.get(
            `/api/session-index${initial ? "" : `?before=${encodeURIComponent(cursor ?? "")}`}`,
            { signal: controller.signal },
          ),
        );
        if (controller.signal.aborted) return;
        cursor = page.next;
        setSessions((previous) =>
          initial
            ? page.sessions
            : [
                ...previous,
                ...page.sessions.filter(
                  (item) => !previous.some((existing) => existing.id === item.id),
                ),
              ],
        );
        setNext(page.next);
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        busy = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    loadMore.current = () => {
      void load(false);
    };
    void load(true);
    return () => controller.abort();
  }, [api, revision]);
  return (
    <aside
      className="rail replay-sessions"
      aria-label="Recorded sessions"
      onScroll={(event) => {
        const pane = event.currentTarget;
        if (pane.scrollHeight - pane.scrollTop - pane.clientHeight < 160) loadMore.current();
      }}
    >
      <div className="rail-h">
        <h2>Sessions</h2>
        <span>{sessions.length}</span>
      </div>
      {!loading && !sessions.length && !error && <p>No sessions yet.</p>}
      {sessions.map((session) => (
        <article
          key={session.id}
          className={`replay-session-card${selectedId === session.id ? " selected" : ""}`}
        >
          <button
            type="button"
            className="replay-session-open"
            aria-current={selectedId === session.id ? "true" : undefined}
            onClick={() => onSelect(session.id)}
          >
            <ReplayImage api={api} sessionId={session.id} frameId={session.coverFrameId} />
            <strong>{session.title ?? "Untitled session"}</strong>
            <time dateTime={session.startedAt}>{startedLabel(session.startedAt)}</time>
            <span>
              {session.durationMs === null ? "In progress" : timeLabel(session.durationMs)} ·{" "}
              {
                {
                  done: "Done",
                  stopped: "Stopped",
                  error: "Failed",
                  live: "Live",
                  interrupted: "Interrupted",
                }[session.verdict]
              }
            </span>
            <span>
              {session.recordings?.browser.bytes &&
              !["none", "failed", "expired"].includes(session.recordings.browser.state)
                ? session.recording.bytes > 0 &&
                  !["none", "failed", "expired"].includes(session.recording.state)
                  ? "Desktop + browser video"
                  : "Browser video"
                : session.recording.state === "expired" ||
                    session.recordings?.browser.state === "expired"
                  ? "Video removed"
                  : session.recording.bytes > 0 && session.recording.state !== "failed"
                    ? "Video"
                    : "Screenshots only"}
            </span>
          </button>
          <button
            type="button"
            className="replay-session-delete"
            aria-label={`Delete ${session.title ?? "untitled session"}`}
            onClick={() => setDeleting(session)}
          >
            Delete
          </button>
        </article>
      ))}
      {error && (
        <p role="alert">
          History could not be loaded.{" "}
          <button type="button" onClick={() => setRevision((value) => value + 1)}>
            Retry
          </button>
        </p>
      )}
      {loading && <p role="status">Loading sessions…</p>}
      {next && (
        <button type="button" disabled={loading} onClick={() => loadMore.current()}>
          Load more sessions
        </button>
      )}
      {deleting && (
        <DeleteSession
          key={deleting.id}
          api={api}
          session={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={(id) => {
            setDeleting(null);
            setSessions((previous) => previous.filter((session) => session.id !== id));
            onDeleted(id);
            setRevision((value) => value + 1);
          }}
        />
      )}
    </aside>
  );
}
