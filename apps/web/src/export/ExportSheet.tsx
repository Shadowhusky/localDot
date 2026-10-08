import { canEncodeVideo } from "mediabunny";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { replayGeometry } from "../replay/recording-source.ts";
import { suggestedExportName, timeLabel } from "../replay/replay-view.ts";
import type { ExportContext } from "./export-context.ts";
import { EXPORT_SIZES, type ExportSpeed, PRIVACY_NOTE, planExport } from "./export-plan.ts";
import type { ExportOut } from "./export-protocol.ts";
import { type ExportHandle, startExport } from "./exporter.ts";
import { exportSupport, pickFileSink } from "./sink.ts";
import "./export.css";

type ExportProgress = Extract<ExportOut, { type: "progress" }>;

export function ExportSheet({
  context,
  anchor,
  onClose,
}: {
  context: ExportContext;
  anchor: HTMLButtonElement;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const handle = useRef<ExportHandle | null>(null);
  const mounted = useRef(true);
  const busy = useRef(false);
  const closingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [range, setRange] = useState<"whole" | "chapter" | "selection">("whole");
  const [speed, setSpeed] = useState<ExportSpeed>(1);
  const [skipIdle, setSkipIdle] = useState(true);
  const [captions, setCaptions] = useState(true);
  const [sizeIndex, setSizeIndex] = useState(
    replayGeometry(context.model, context.source)?.scale === 2 ? 1 : 0,
  );
  const [sizes, setSizes] = useState<(boolean | null)[]>(EXPORT_SIZES.map(() => null));
  const [phase, setPhase] = useState<"options" | "picking" | "exporting" | "saved" | "cancelled">(
    "options",
  );
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [closing, setClosing] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const support = exportSupport();
  const selectedRange = context[range] ?? context.whole;
  const size = EXPORT_SIZES[sizeIndex] ?? EXPORT_SIZES[0];
  const request = {
    sessionId: context.sessionId,
    ...selectedRange,
    speed,
    skipIdle,
    captions,
    size,
  };
  let duration = 0;
  let invalidRange = false;
  try {
    duration = planExport(request, context.model, context.activity, context.gaps).durationS;
  } catch {
    invalidRange = true;
  }
  const active = phase === "picking" || phase === "exporting";
  const elapsed = startedAt === null ? 0 : Math.max(0, now - startedAt);
  const remaining =
    progress && progress.done >= 15 && elapsed >= 500
      ? elapsed * (progress.total / progress.done - 1)
      : null;
  useEffect(() => {
    mounted.current = true;
    const element = dialog.current;
    element?.showModal();
    const place = () => {
      if (!element) return;
      const bounds = anchor.getBoundingClientRect();
      const width = element.getBoundingClientRect().width;
      const height = element.getBoundingClientRect().height;
      element.style.left = `${Math.max(16, Math.min(innerWidth - width - 16, bounds.right - width))}px`;
      element.style.top = `${Math.max(16, Math.min(innerHeight - height - 16, bounds.top - height - 12))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    if (element) observer.observe(element);
    window.addEventListener("resize", place);
    void Promise.all(
      EXPORT_SIZES.map(async (candidate) => {
        try {
          return await canEncodeVideo("avc", { width: candidate.w, height: candidate.h });
        } catch {
          return false;
        }
      }),
    ).then((available) => {
      if (mounted.current) setSizes(available);
    });
    return () => {
      mounted.current = false;
      clearTimeout(closingTimer.current);
      handle.current?.cancel();
      observer.disconnect();
      window.removeEventListener("resize", place);
      element?.close();
      if (anchor.isConnected) anchor.focus();
    };
  }, [anchor]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(timer);
  }, [active]);
  const close = () => {
    if (busy.current) {
      setConfirmCancel(true);
      return;
    }
    if (closing) return;
    setClosing(true);
    closingTimer.current = setTimeout(
      onClose,
      matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 150,
    );
  };
  const cancel = () => {
    setConfirmCancel(false);
    handle.current?.cancel();
  };
  const save = async () => {
    if (busy.current || !support.ok || invalidRange || !sizes[sizeIndex]) return;
    busy.current = true;
    setError(null);
    setPhase("picking");
    try {
      const name = suggestedExportName(new Date());
      const sink = await pickFileSink(
        context.source.screen === "browser" ? name.replace(/\.mp4$/, "-browser.mp4") : name,
      );
      if (!mounted.current) {
        await sink?.abort();
        return;
      }
      if (!sink) {
        setPhase("options");
        return;
      }
      const started = performance.now();
      setStartedAt(started);
      setNow(started);
      setPhase("exporting");
      const exporting = startExport({ request, ...context, sink });
      handle.current = exporting;
      exporting.onProgress((value) => {
        if (mounted.current) setProgress(value);
      });
      const result = await exporting.done;
      if (!mounted.current) return;
      if (result.type === "done") setPhase("saved");
      else if (result.type === "cancelled") setPhase("cancelled");
      else {
        setError(result.message);
        setPhase("options");
      }
    } catch {
      if (mounted.current) {
        setError("The file could not be opened for saving. Choose another location and try again.");
        setPhase("options");
      }
    } finally {
      busy.current = false;
      handle.current = null;
      if (mounted.current) setConfirmCancel(false);
    }
  };
  return createPortal(
    <dialog
      ref={dialog}
      className={`export-sheet${closing ? " closing" : ""}`}
      aria-labelledby="export-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header>
        <div>
          <span className="export-eyebrow">
            {context.source.screen === "browser" ? "Browser recording" : "Desktop recording"}
          </span>
          <h2 id="export-title">Export MP4</h2>
        </div>
        <button type="button" aria-label="Close export" onClick={close}>
          ×
        </button>
      </header>
      <div className="export-body">
        {phase === "options" && (
          <>
            <label>
              Range
              <select
                aria-label="Export range"
                value={range}
                onChange={(event) => setRange(event.target.value as typeof range)}
              >
                <option value="whole">Whole session</option>
                <option value="chapter" disabled={!context.chapter}>
                  Current step
                </option>
                {context.selection && <option value="selection">Selected range</option>}
              </select>
            </label>
            <div className="export-option-row">
              <label>
                Speed
                <select
                  aria-label="Export speed"
                  value={speed}
                  onChange={(event) => setSpeed(Number(event.target.value) as ExportSpeed)}
                >
                  {[1, 2, 4, 8].map((value) => (
                    <option key={value} value={value}>
                      {value}×
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Size
                <select
                  aria-label="Export size"
                  value={sizeIndex}
                  onChange={(event) => setSizeIndex(Number(event.target.value))}
                >
                  {EXPORT_SIZES.map((candidate, index) => (
                    <option key={candidate.w} value={index} disabled={sizes[index] !== true}>
                      {candidate.w} × {candidate.h}
                      {sizes[index] === false
                        ? " — encoder unavailable"
                        : sizes[index] === null
                          ? " — checking…"
                          : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="export-check">
              <input
                type="checkbox"
                checked={skipIdle}
                onChange={(event) => setSkipIdle(event.target.checked)}
              />
              Skip idle stretches
            </label>
            <label className="export-check">
              <input
                type="checkbox"
                checked={captions}
                onChange={(event) => setCaptions(event.target.checked)}
              />
              Include step captions
            </label>
            <p className="export-estimate">{timeLabel(duration * 1000)} video · 30 fps</p>
            <p className="export-privacy">{PRIVACY_NOTE}</p>
            {!support.ok && <p role="status">{support.reason}</p>}
            {invalidRange && <p role="status">There are no recorded moments in this range yet.</p>}
            {sizes[sizeIndex] === false && (
              <p role="status">Your browser cannot encode this size. Choose an available size.</p>
            )}
          </>
        )}
        {phase === "picking" && <p role="status">Choose where to save your video…</p>}
        {phase === "exporting" && (
          <div className="export-progress">
            <h3>Saving your replay</h3>
            <progress
              aria-label="Export progress"
              value={progress?.done ?? 0}
              max={progress?.total ?? 1}
            />
            <p>
              {(progress?.done ?? 0).toLocaleString()} / {(progress?.total ?? 0).toLocaleString()}{" "}
              frames
            </p>
            <p>
              {timeLabel(elapsed)} elapsed ·{" "}
              {remaining === null
                ? "Estimating time remaining…"
                : `${timeLabel(remaining)} remaining`}
            </p>
            <span>Keep this tab open while the video is saved.</span>
          </div>
        )}
        {phase === "saved" && (
          <div className="export-result" role="status">
            <h3>Your video is saved</h3>
            <p>The MP4 includes the screen, pointer and recorded actions.</p>
          </div>
        )}
        {phase === "cancelled" && (
          <div className="export-result" role="status">
            <h3>Export cancelled</h3>
            <p>No partial video was saved.</p>
          </div>
        )}
        {confirmCancel && (
          <div className="export-cancel-confirm" role="alert">
            <p>Cancel this export?</p>
            <button type="button" onClick={() => setConfirmCancel(false)}>
              Keep exporting
            </button>
            <button type="button" disabled={phase === "picking"} onClick={cancel}>
              Cancel export
            </button>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
      <footer>
        {active ? (
          <button
            type="button"
            disabled={phase === "picking"}
            onClick={() => setConfirmCancel(true)}
          >
            Cancel
          </button>
        ) : (
          <button type="button" onClick={close}>
            {phase === "options" ? "Cancel" : "Done"}
          </button>
        )}
        {phase === "options" && (
          <button
            className="export-save"
            type="button"
            disabled={!support.ok || invalidRange || sizes[sizeIndex] !== true}
            onClick={() => void save()}
          >
            Save…
          </button>
        )}
      </footer>
    </dialog>,
    document.body,
  );
}
