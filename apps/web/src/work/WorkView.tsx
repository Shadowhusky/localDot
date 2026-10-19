import { useEffect, useRef, useState } from "react";
import { downloadResult } from "../agent/file-transfer.ts";
import type { ApiClient } from "../lib/api.ts";
import { Button } from "../ui/Button.tsx";
import { ErrorBoundary } from "../ui/ErrorBoundary.tsx";
import { ScrollArea } from "../ui/ScrollArea.tsx";
import { Select } from "../ui/Select.tsx";
import type { WorkCard } from "./work-view.ts";

const MODES = [
  { value: "auto", label: "Auto" },
  { value: "screen", label: "Screen" },
  { value: "work", label: "Work" },
];
// At most four text paints per second; a new surface must settle before it replaces the screen.
const PAINT_MS = 250;
const SWITCH_MS = 700;
interface WorkViewProps {
  api: ApiClient;
  candidate: WorkCard | null;
  enabled: boolean;
  sessionId: string;
  replay?: boolean;
}
// A presentation failure must never unmount the computer stream or its controls.
export function WorkView(props: WorkViewProps) {
  return (
    <ErrorBoundary quiet key={props.sessionId}>
      <WorkSurfaceView {...props} />
    </ErrorBoundary>
  );
}
function WorkSurfaceView({ api, candidate, enabled, sessionId, replay = false }: WorkViewProps) {
  const previews = useRef(new Map<string, { url?: string; failed?: boolean }>());
  useEffect(() => {
    const cache = previews.current;
    return () => {
      for (const entry of cache.values()) if (entry.url) URL.revokeObjectURL(entry.url);
      cache.clear();
    };
  }, []);
  const [mode, setMode] = useState("auto");
  const [shown, setShown] = useState<WorkCard | null>(null);
  const [pinned, setPinned] = useState<WorkCard | null>(null);
  const latest = useRef(candidate);
  latest.current = candidate;
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const changed = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  const key = candidate?.key;
  const switchPending = !!candidate && shown?.key !== candidate.key;
  useEffect(() => {
    if (!enabled || !visible || mode !== "auto" || replay || !switchPending) return;
    const timer = setTimeout(() => setShown(latest.current), SWITCH_MS);
    return () => clearTimeout(timer);
  }, [enabled, visible, mode, replay, switchPending]);
  const dirty = !!shown && shown.key === key && shown !== candidate;
  useEffect(() => {
    if (!enabled || !visible || mode !== "auto" || replay || !shown || !dirty) return;
    const timer = setTimeout(() => setShown(latest.current), PAINT_MS);
    return () => clearTimeout(timer);
  }, [enabled, visible, mode, replay, shown, dirty]);
  // Screen changes and handovers take precedence immediately, including while a timer is pending.
  const card =
    mode === "work"
      ? replay
        ? candidate
        : pinned
      : mode === "auto"
        ? replay
          ? candidate
          : candidate
            ? shown
            : null
        : null;
  if (!enabled || !visible) return null;
  const pin = () => {
    if (!replay && mode === "auto" && card) {
      setPinned(card);
      setMode("work");
    }
  };
  return (
    <section
      className="work-view"
      data-work={card ? "" : undefined}
      data-replay={replay || undefined}
      aria-label="Work display"
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {card && (
        <div className="work-surface">
          <header className="work-heading">
            <span>
              {card.kind} ·{" "}
              {mode === "auto" && candidate?.key !== card.key ? "Previous step" : card.status}
            </span>
            <h2>{card.title}</h2>
          </header>
          <ScrollArea
            key={card.key}
            className="work-content"
            tabIndex={0}
            aria-label="Work output"
            onWheel={pin}
            onPointerDown={pin}
            onKeyDown={pin}
          >
            <div>
              {card.image && (
                <WorkImage
                  api={api}
                  sessionId={sessionId}
                  image={card.image}
                  cache={previews.current}
                />
              )}
              <pre>{card.text || "Waiting for output…"}</pre>
              {card.shortened && (
                <p className="work-note">Recent output. Full details are in Steps.</p>
              )}
            </div>
          </ScrollArea>
        </div>
      )}
      <div className="work-controls">
        <Select
          size="sm"
          aria-label="Display view"
          value={mode}
          items={MODES}
          onValueChange={(value) => {
            setPinned(value === "work" ? (card ?? candidate) : null);
            setMode(value);
          }}
        />
        {mode === "work" && (
          <Button size="sm" variant="quiet" onClick={() => setMode("auto")}>
            Follow work
          </Button>
        )}
      </div>
    </section>
  );
}

// Only the daemon's saved, bounded JPEG thumbnails are eligible. No HTML, remote URLs, videos or
// office conversion jobs run automatically. One request; failures do not retry or affect the task.
function WorkImage({
  api,
  sessionId,
  image,
  cache,
}: {
  api: ApiClient;
  sessionId: string;
  image: NonNullable<WorkCard["image"]>;
  cache: Map<string, { url?: string; failed?: boolean }>;
}) {
  const [state, setState] = useState<{ key: string; url?: string; failed?: boolean }>();
  const key = `${sessionId}/${image.name}`;
  useEffect(() => {
    if (!/^step-image-[0-9A-HJKMNP-TV-Z]{26}\.jpg$/.test(image.name)) {
      setState({ key, failed: true });
      return;
    }
    const cached = cache.get(key);
    if (cached) {
      setState({ key, ...cached });
      return;
    }
    let disposed = false;
    const remember = (entry: { url?: string; failed?: boolean }) => {
      cache.set(key, entry);
      while (cache.size > 2) {
        const oldest = cache.keys().next().value;
        if (!oldest) break;
        const old = cache.get(oldest);
        if (old?.url) URL.revokeObjectURL(old.url);
        cache.delete(oldest);
      }
      setState({ key, ...entry });
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let url: string | undefined;
    downloadResult(api, sessionId, image.name, controller.signal, 2 * 1024 * 1024)
      .then((blob) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob.slice(0, blob.size, "image/jpeg"));
        remember({ url });
      })
      .catch(() => {
        if (!disposed) remember({ failed: true });
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      disposed = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [api, sessionId, image.name, key, cache]);
  return state?.key === key && state.url ? (
    <img
      className="work-image"
      src={state.url}
      alt={image.alt}
      decoding="async"
      onError={() => setState({ key, failed: true })}
    />
  ) : (
    <p className="work-note">
      {state?.key === key && state.failed
        ? "Preview unavailable. The file is still in Steps."
        : "Loading preview…"}
    </p>
  );
}
