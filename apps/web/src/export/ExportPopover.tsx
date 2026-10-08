import type { ScreenName } from "@localdot/protocol";
import { chapters, observeAt, type SessionModel } from "@localdot/stage";
import { canEncodeVideo } from "mediabunny";
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ApiClient } from "../lib/api.ts";
import { ReplayImage } from "../replay/ReplayImage.tsx";
import { replayGeometry } from "../replay/recording-source.ts";
import { timeLabel } from "../replay/replay-view.ts";
import { Button } from "../ui/Button.tsx";
import { Disclosure } from "../ui/Disclosure.tsx";
import { Field } from "../ui/Field.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PHONE, useMediaQuery } from "../ui/media.ts";
import { Popover } from "../ui/Popover.tsx";
import { Progress } from "../ui/Progress.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { Switch } from "../ui/Switch.tsx";
import type { ExportContext } from "./export-context.ts";
import {
  EXPORT_SIZES,
  type ExportSpeed,
  estimateBytes,
  fileSize,
  PRIVACY_NOTE,
  planExport,
  videoLength,
} from "./export-plan.ts";
import { busy, type ExportJob, type ExportJobState, useExportJob } from "./job.ts";
import { DOWNLOAD_LIMIT, exportSupport, LONG_EXPORT } from "./sink.ts";
import "./export.css";

type RangeKey = "whole" | "chapter" | "selection";

const TITLE = "Export MP4";
const SPEEDS = [1, 2, 4, 8] as const satisfies readonly ExportSpeed[];
const SPEED_ITEMS = SPEEDS.map((speed) => ({ value: String(speed), label: `${speed}×` }));
const NO_STEP = "The playhead isn't on a step";
const NO_SELECTION = "Press I and O on the timeline to mark a stretch";
const NO_SELECTION_TOUCH = "On a keyboard, press I and O on the timeline to mark a stretch";
// The elapsed time and the estimate of what is left move on this beat while a video is saved.
const TICK_MS = 500;
const RESULT_TITLE = {
  ready: "Your video is ready",
  downloaded: "Downloaded",
  saved: "Video saved",
} as const;

// The picture the export opens on: the moment at the playhead when it is in range, else the range's
// first, else the first after it.
function previewFrame(
  model: SessionModel,
  atMs: number,
  range: { fromMs: number; toMs: number },
  screen: ScreenName,
): string | null {
  const at = Math.max(range.fromMs, Math.min(range.toMs, atMs));
  const shown = observeAt(model, at, screen);
  if (shown) return shown.frameId;
  return (
    model.observes.find(
      (entry) => entry.t >= range.fromMs && (entry.screen ?? "desktop") === screen,
    )?.frameId ?? null
  );
}

function stepLabel(model: SessionModel, atMs: number, endMs: number): string | null {
  return (
    chapters(model, endMs).find((chapter) => chapter.startT <= atMs && atMs < chapter.endT)
      ?.label ?? null
  );
}

export function ExportPopover({
  api,
  job,
  context,
  open,
  onClose,
  anchor,
}: {
  api: ApiClient;
  job: ExportJob;
  context: ExportContext;
  open: boolean;
  onClose(): void;
  anchor: RefObject<HTMLElement | null>;
}) {
  const phone = useMediaQuery(PHONE);
  const touch = useMediaQuery("(pointer: coarse)");
  const live = useExportJob(job);
  // Closing, the panel keeps showing what it showed, while the job may move on under it.
  const shown = useRef(live);
  if (open) shown.current = live;
  const state = shown.current;
  const [range, setRange] = useState<RangeKey>(context.selection ? "selection" : "whole");
  const [speed, setSpeed] = useState<ExportSpeed>(1);
  const [sizeIndex, setSizeIndex] = useState(
    replayGeometry(context.model, context.source)?.scale === 2 ? 1 : 0,
  );
  const [skipIdle, setSkipIdle] = useState(true);
  const [captions, setCaptions] = useState(true);
  const [sizes, setSizes] = useState<(boolean | null)[]>(() => EXPORT_SIZES.map(() => null));

  useEffect(() => {
    let current = true;
    void Promise.all(
      EXPORT_SIZES.map((size) =>
        canEncodeVideo("avc", { width: size.w, height: size.h }).catch(() => false),
      ),
    ).then((found) => {
      if (!current) return;
      setSizes(found);
      // The size picked for this screen may be one this browser cannot make.
      setSizeIndex((index) =>
        found[index] || !found.includes(true) ? index : found.indexOf(true),
      );
    });
    return () => {
      current = false;
    };
  }, []);

  const support = exportSupport();
  const chosen = context[range] ?? context.whole;
  const size = EXPORT_SIZES[sizeIndex] ?? EXPORT_SIZES[0];
  const request = useMemo(
    () => ({
      sessionId: context.sessionId,
      fromMs: chosen.fromMs,
      toMs: chosen.toMs,
      speed,
      skipIdle,
      captions,
      size: { w: size.w, h: size.h },
    }),
    [context.sessionId, chosen.fromMs, chosen.toMs, speed, skipIdle, captions, size],
  );
  const durationS = useMemo(() => {
    try {
      return planExport(request, context.model, context.activity, context.gaps).durationS;
    } catch {
      return null;
    }
  }, [request, context]);
  const estimate = durationS === null ? 0 : estimateBytes(size, durationS);
  const blocked = !support.ok
    ? support.reason
    : durationS === null
      ? "Nothing was recorded in this range"
      : sizes[sizeIndex] === null
        ? "Checking what this browser can make…"
        : sizes[sizeIndex] === false
          ? `This browser can't make ${size.label} video`
          : support.save === "download" && estimate > DOWNLOAD_LIMIT
            ? LONG_EXPORT
            : undefined;
  const summary =
    state.phase === "options" && state.note
      ? state.note
      : (blocked ?? `${videoLength(durationS ?? 0)} video · up to ${fileSize(estimate)}`);

  // A changed choice clears what the last attempt came to.
  const choose =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      if (state.note) job.reset();
    };

  const working = state.phase !== "options";
  const frame = previewFrame(
    context.model,
    context.atMs,
    chosen,
    context.source.screen ?? "desktop",
  );
  const step = stepLabel(
    context.model,
    Math.max(chosen.fromMs, Math.min(chosen.toMs, context.atMs)),
    context.whole.toMs,
  );
  const span = context.whole.toMs - context.whole.fromMs;
  const share = (time: number) => (span > 0 ? (time - context.whole.fromMs) / span : 0);

  const body = (
    <div className="export-body">
      <div className="export-preview">
        <ReplayImage api={api} sessionId={context.sessionId} frameId={frame} full />
        <span
          className="export-preview-caption"
          data-shown={captions && step ? "" : undefined}
          aria-hidden="true"
        >
          {step}
        </span>
      </div>
      <div className="export-range">
        <span
          className="export-range-track"
          aria-hidden="true"
          style={{ "--_from": share(chosen.fromMs), "--_to": share(chosen.toMs) } as CSSProperties}
        >
          <span className="export-range-chosen" />
          <span className="export-range-edge" />
          <span className="export-range-edge" data-end="" />
        </span>
        <span className="export-range-label num">
          {timeLabel(chosen.fromMs)} – {timeLabel(chosen.toMs)}
        </span>
      </div>
      <div className="export-views">
        <div className="export-options" inert={working} data-shown={working ? undefined : ""}>
          <Field label="Range" className="export-row">
            <SegmentedControl
              size={24}
              items={[
                { value: "whole", label: "Whole" },
                {
                  value: "chapter",
                  label: "This step",
                  disabledReason: context.chapter ? undefined : NO_STEP,
                },
                {
                  value: "selection",
                  label: "Selection",
                  disabledReason: context.selection
                    ? undefined
                    : touch
                      ? NO_SELECTION_TOUCH
                      : NO_SELECTION,
                },
              ]}
              value={range}
              onValueChange={choose((value: string) => setRange(value as RangeKey))}
            />
          </Field>
          <Field label="Speed" className="export-row">
            <SegmentedControl
              size={24}
              items={SPEED_ITEMS}
              value={String(speed)}
              onValueChange={choose((value: string) => setSpeed(Number(value) as ExportSpeed))}
            />
          </Field>
          <Field label="Size" className="export-row">
            <SegmentedControl
              size={24}
              items={EXPORT_SIZES.map((option, index) => ({
                value: String(index),
                label: option.label,
                disabledReason:
                  sizes[index] === false
                    ? `This browser can't make ${option.label} video`
                    : undefined,
              }))}
              value={String(sizeIndex)}
              onValueChange={choose((value: string) => setSizeIndex(Number(value)))}
            />
          </Field>
          <div className="export-switches">
            <Switch
              label="Skip idle"
              checked={skipIdle}
              onCheckedChange={choose((checked: boolean) => setSkipIdle(checked))}
            />
            <Switch
              label="Captions"
              checked={captions}
              onCheckedChange={choose((checked: boolean) => setCaptions(checked))}
            />
          </div>
          <p className="export-privacy">{PRIVACY_NOTE}</p>
        </div>
        <div className="export-status" inert={!working} data-shown={working ? "" : undefined}>
          {working && <ExportStatus state={state} open={open} />}
        </div>
      </div>
    </div>
  );

  const footer = (
    <div className="export-footer">
      <p
        className="export-summary num"
        role={state.phase === "options" && state.note ? "alert" : undefined}
      >
        {state.phase === "options" ? summary : null}
      </p>
      <ExportActions
        state={state}
        blocked={blocked}
        picker={support.ok && support.save === "picker"}
        onSave={() => {
          if (durationS !== null) void job.start(context, request, durationS);
        }}
        job={job}
        onClose={onClose}
      />
    </div>
  );

  return phone ? (
    <Sheet
      open={open}
      onClose={onClose}
      title={TITLE}
      side="bottom"
      returnFocus={anchor}
      footer={footer}
    >
      {body}
    </Sheet>
  ) : (
    <Popover
      open={open}
      onClose={onClose}
      anchor={anchor}
      side="top"
      align="end"
      title={TITLE}
      size="lg"
      className="export-popover"
    >
      {body}
      {footer}
    </Popover>
  );
}

function ExportStatus({ state, open }: { state: ExportJobState; open: boolean }) {
  const [now, setNow] = useState(() => performance.now());
  const exporting = state.phase === "exporting";
  useEffect(() => {
    if (!exporting || !open) return;
    const timer = setInterval(() => setNow(performance.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [exporting, open]);

  if (state.phase === "ready" || state.phase === "downloaded" || state.phase === "saved") {
    const file = state.file;
    return (
      <div className="export-result" role="status">
        <span className="export-result-mark" aria-hidden="true">
          <Icon name={state.phase === "ready" ? "download" : "check"} size={16} />
        </span>
        <p className="export-status-title">{RESULT_TITLE[state.phase]}</p>
        {file && (
          <>
            <p className="export-file">{file.name}</p>
            <p className="export-file-meta num">
              {fileSize(file.bytes)} · {videoLength(file.durationS)}
            </p>
          </>
        )}
      </div>
    );
  }

  const picking = state.phase === "picking";
  const percent = state.total ? Math.floor((state.done / state.total) * 100) : 0;
  const elapsed = state.startedAt === null ? 0 : Math.max(0, now - state.startedAt);
  const remaining =
    state.done >= 15 && elapsed >= 1000 && state.total
      ? elapsed * (state.total / state.done - 1)
      : null;
  return (
    <div className="export-progress">
      <p className="export-status-title">
        {picking ? "Choose where to save it" : "Saving your video"}
      </p>
      <Progress
        label="Export progress"
        value={picking ? undefined : state.done}
        max={state.total || 1}
        valueText={`${percent}%`}
      />
      <p className="export-progress-line num">
        {picking
          ? "Waiting for a place to save it"
          : `${percent}% · ${remaining === null ? "working out the time left" : `about ${timeLabel(remaining)} left`}`}
      </p>
      {!picking && (
        <Disclosure summary="Details" className="export-details">
          <p className="export-details-text num">
            {state.done.toLocaleString()} of {state.total.toLocaleString()} frames ·{" "}
            {timeLabel(elapsed)} so far
          </p>
          <p className="export-details-text">Keep this tab open until it's saved.</p>
        </Disclosure>
      )}
    </div>
  );
}

function ExportActions({
  state,
  blocked,
  picker,
  onSave,
  job,
  onClose,
}: {
  state: ExportJobState;
  blocked: string | undefined;
  // The browser asks where to save before the video is made.
  picker: boolean;
  onSave(): void;
  job: ExportJob;
  onClose(): void;
}): ReactNode {
  if (busy(state.phase))
    return (
      <div className="export-actions">
        <Button
          variant="quiet"
          disabledReason={state.phase === "picking" ? "Choose a place to save it first" : undefined}
          onClick={() => job.cancel()}
        >
          Cancel
        </Button>
        <Button onClick={onClose}>Keep working</Button>
      </div>
    );
  if (state.phase === "ready")
    return (
      <div className="export-actions">
        <Button variant="primary" icon="download" onClick={() => job.save()}>
          Save video
        </Button>
      </div>
    );
  if (state.phase === "downloaded" || state.phase === "saved")
    return (
      <div className="export-actions">
        {state.phase === "downloaded" && (
          <Button variant="quiet" icon="download" onClick={() => job.save()}>
            Save again
          </Button>
        )}
        <Button
          onClick={() => {
            job.reset();
            onClose();
          }}
        >
          Done
        </Button>
      </div>
    );
  return (
    <div className="export-actions">
      <Button variant="primary" disabledReason={blocked} onClick={onSave}>
        {picker ? "Save…" : "Save"}
      </Button>
    </div>
  );
}
