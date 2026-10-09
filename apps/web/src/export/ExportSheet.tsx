import type { ScreenName } from "@localdot/protocol";
import { chapters, observeAt, type SessionModel } from "@localdot/stage";
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ApiClient } from "../lib/api.ts";
import { ReplayImage } from "../replay/ReplayImage.tsx";
import { timeLabel } from "../replay/replay-view.ts";
import { Button } from "../ui/Button.tsx";
import { Collapse, Disclosure } from "../ui/Disclosure.tsx";
import { Field } from "../ui/Field.tsx";
import { Group, GroupNote } from "../ui/Group.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { useMediaQuery } from "../ui/media.ts";
import { Progress } from "../ui/Progress.tsx";
import { RadioCards } from "../ui/RadioCards.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { Switch } from "../ui/Switch.tsx";
import { TextField } from "../ui/TextField.tsx";
import type { ExportContext } from "./export-context.ts";
import {
  type ExportEstimate,
  estimateExport,
  storedCalibration,
  waitText,
} from "./export-estimate.ts";
import {
  EXPORT_FRAME_RATES,
  EXPORT_QUALITIES,
  type ExportQuality,
  fileSize,
  PRIVACY_NOTE,
  planExport,
  speedText,
  videoLength,
} from "./export-plan.ts";
import {
  type ExportChoices,
  type ExportEnvironment,
  type ExportOptions,
  exportRequest,
  fitOptions,
  frameRateAllowed,
  keepChoices,
  maxFrameRate,
  optionsFor,
  type PresetChoice,
  parseSpeed,
  presetOptions,
  SIZE_CHOICES,
  type SizeChoice,
  sizeLabel,
  sizeOf,
  stepSpeed,
  storedChoices,
  withOption,
} from "./export-settings.ts";
import { type HostExports, useHostExports } from "./host-exports.ts";
import { busy, type ExportJob, type ExportJobState, useExportJob } from "./job.ts";
import { DOWNLOAD_LIMIT, exportSupport, LONG_EXPORT } from "./sink.ts";
import { useExportEnvironment } from "./useExportEnvironment.ts";
import "./export.css";

type RangeKey = "whole" | "chapter" | "selection";

const TITLE = "Export video";
const NO_STEP = "The playhead isn't on a step";
const NO_SELECTION = "Press I and O on the timeline to mark a stretch";
const NO_SELECTION_TOUCH = "On a keyboard, press I and O on the timeline to mark a stretch";
const NOT_CUSTOM = "Set under More options";
const SPEED_PRESETS = ["1", "2", "3"] as const;
const QUALITY_LABEL: Record<ExportQuality, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};
const PRESET_NOTE = { quality: "sharpest", fast: "smallest" } as const;
// The elapsed time and the estimate of what is left move on this beat while a video is saved.
const TICK_MS = 500;
const PAGE_NOTE = "This page makes the video, so keep it open until it's saved.";
const HOST_NOTE = "It keeps going if you close this page or switch apps.";
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

function optionsText(options: ExportOptions, env: ExportEnvironment): string {
  const size = sizeOf(options.size, env);
  return `${size.w} × ${size.h} · ${options.fps} fps`;
}

interface Outcome extends ExportEstimate {
  durationS: number;
  // Before this browser's own calibration, which the finished export corrects.
  fitted: ExportEstimate;
}

export function ExportSheet({
  api,
  job,
  host,
  context,
  open,
  onClose,
  anchor,
}: {
  api: ApiClient;
  job: ExportJob;
  host: HostExports;
  context: ExportContext;
  open: boolean;
  onClose(): void;
  anchor: RefObject<HTMLElement | null>;
}) {
  const touch = useMediaQuery("(pointer: coarse)");
  const live = useExportJob(job);
  // Closing, the sheet keeps showing what it showed, while the job may move on under it.
  const shown = useRef(live);
  if (open) shown.current = live;
  const state = shown.current;
  const hostView = useHostExports(host);
  // The host makes the video when it can; this page makes it only when the host can't.
  const where =
    hostView.host?.state === "ready"
      ? "host"
      : hostView.host?.state === "checking"
        ? "checking"
        : "page";
  const env = useExportEnvironment(
    context,
    where === "host" ? (hostView.host?.maxPixels ?? null) : null,
  );
  const [range, setRange] = useState<RangeKey>(context.selection ? "selection" : "whole");
  const [choices, setChoices] = useState<ExportChoices>(storedChoices);
  const [calibration] = useState(storedCalibration);

  const support = exportSupport();
  const chosen = context[range] ?? context.whole;
  const options = optionsFor(choices, env);
  const request = exportRequest(context.sessionId, chosen, choices, env);

  const outcome = (rowOptions: ExportOptions): Outcome | null => {
    try {
      const rowRequest = { ...request, ...rowOptions, size: sizeOf(rowOptions.size, env) };
      const plan = planExport(rowRequest, context.model, context.activity, context.gaps);
      return {
        ...estimateExport(plan, rowRequest, calibration),
        durationS: plan.durationS,
        fitted: estimateExport(plan, rowRequest),
      };
    } catch {
      return null;
    }
  };
  const presets = {
    quality: presetOptions("quality", env, choices.speed),
    fast: presetOptions("fast", env, choices.speed),
    custom: fitOptions(choices.custom, env, choices.speed),
  } satisfies Record<PresetChoice, ExportOptions>;
  const outcomes = {
    quality: outcome(presets.quality),
    fast: outcome(presets.fast),
    custom: outcome(presets.custom),
  };
  const current = outcome(options);

  const update = (next: ExportChoices) => {
    setChoices(next);
    keepChoices(next);
    if (state.note) job.reset();
  };
  const choose = (patch: Partial<ExportChoices>) => update({ ...choices, ...patch });
  const option = (patch: Partial<ExportOptions>) => update(withOption(choices, env, patch));

  const canMake = env.encodable[options.format][options.size];
  const maker = where === "page" ? "This browser" : "This computer";
  const blocked =
    where === "checking"
      ? "Checking what this computer can make"
      : where === "page" && !support.ok
        ? support.reason
        : current === null
          ? "Nothing was recorded in this range"
          : canMake === undefined
            ? "Checking what this browser can make"
            : canMake === false
              ? `${maker} can't make ${sizeLabel(options.size)} video`
              : where === "page" &&
                  support.ok &&
                  support.save === "download" &&
                  current.bytes > DOWNLOAD_LIMIT
                ? LONG_EXPORT
                : undefined;
  const summary =
    state.phase === "options" && state.note
      ? state.note
      : (blocked ??
        `${videoLength(current?.durationS ?? 0)} video · about ${fileSize(current?.bytes ?? 0)} · ready in ${waitText(current?.ms ?? 0)}`);

  const working = state.phase !== "options";
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scroller = bodyRef.current?.closest(".ui-sheet-body");
    if (working && scroller) scroller.scrollTop = 0;
  }, [working]);
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
  const cap = maxFrameRate(env, choices.speed);

  const presetRow = (preset: PresetChoice, label: string) => {
    const result = outcomes[preset];
    const unavailable = preset === "custom" && choices.preset !== "custom";
    return {
      value: preset,
      label,
      description:
        preset === "custom"
          ? `${optionsText(presets.custom, env)} · ${QUALITY_LABEL[presets.custom.quality].toLowerCase()} quality`
          : `${optionsText(presets[preset], env)} · ${PRESET_NOTE[preset]}`,
      disabledReason: unavailable ? NOT_CUSTOM : undefined,
      aside: (
        <span className="export-estimate" data-hidden={unavailable ? "" : undefined}>
          <span className="export-estimate-size">{result ? fileSize(result.bytes) : "–"}</span>
          <span className="export-estimate-time">{result ? waitText(result.ms) : "–"}</span>
        </span>
      ),
    };
  };

  const body = (
    <div ref={bodyRef} className="export-body">
      <div className="export-views">
        <div className="export-options" inert={working} data-shown={working ? undefined : ""}>
          <div className="export-recording">
            <div className="export-preview">
              <ReplayImage api={api} sessionId={context.sessionId} frameId={frame} full />
              <span
                className="export-preview-caption"
                data-shown={choices.captions && step ? "" : undefined}
                aria-hidden="true"
              >
                {step}
              </span>
            </div>
            <div className="export-range">
              <span className="export-range-label num">
                {timeLabel(chosen.fromMs)} – {timeLabel(chosen.toMs)}
              </span>
              <span className="export-range-meta num">
                {current ? `${videoLength(current.durationS)} at ${speedText(choices.speed)}` : "–"}
              </span>
              <span
                className="export-range-track"
                aria-hidden="true"
                style={
                  { "--_from": share(chosen.fromMs), "--_to": share(chosen.toMs) } as CSSProperties
                }
              >
                <span className="export-range-chosen" />
                <span className="export-range-edge" />
                <span className="export-range-edge" data-end="" />
              </span>
            </div>
          </div>
          <RadioCards
            aria-label="Preset"
            className="export-presets"
            value={choices.preset}
            onValueChange={(value) => {
              const preset = value as PresetChoice;
              update({ ...choices, preset });
            }}
            options={[
              presetRow("quality", "Quality"),
              presetRow("fast", "Fast"),
              presetRow("custom", "Custom"),
            ]}
          />
          <Group>
            <Field label="Range" inline className="ui-group-row export-row">
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
                onValueChange={(value) => {
                  setRange(value as RangeKey);
                  if (state.note) job.reset();
                }}
              />
            </Field>
            <SpeedRow speed={choices.speed} onSpeed={(speed) => choose({ speed })} />
          </Group>
          <Disclosure
            summary="More options"
            meta={`${sizeLabel(options.size)} · ${options.fps} fps · ${options.format === "webm" ? "WebM" : "MP4"}`}
            className="export-more"
          >
            <Group className="export-advanced">
              <Field label="Resolution" inline className="ui-group-row export-row">
                <SegmentedControl
                  size={24}
                  items={SIZE_CHOICES.map((size) => ({
                    value: size,
                    label: sizeLabel(size),
                    disabledReason:
                      env.encodable[options.format][size] === false
                        ? `${maker} can't make ${sizeLabel(size)} video`
                        : undefined,
                  }))}
                  value={options.size}
                  onValueChange={(size) => option({ size: size as SizeChoice })}
                />
              </Field>
              <Field label="Frame rate" inline className="ui-group-row export-row">
                <SegmentedControl
                  size={24}
                  items={EXPORT_FRAME_RATES.map((rate) => ({
                    value: String(rate),
                    label: String(rate),
                    disabledReason: frameRateAllowed(rate, env, choices.speed)
                      ? undefined
                      : `The recording has no more than ${cap} fps at this speed`,
                  }))}
                  value={String(options.fps)}
                  onValueChange={(rate) => option({ fps: Number(rate) as ExportOptions["fps"] })}
                />
              </Field>
              <Field label="Quality" inline className="ui-group-row export-row">
                <SegmentedControl
                  size={24}
                  items={EXPORT_QUALITIES.map((quality) => ({
                    value: quality,
                    label: QUALITY_LABEL[quality],
                  }))}
                  value={options.quality}
                  onValueChange={(quality) => option({ quality: quality as ExportQuality })}
                />
              </Field>
              <Field label="Format" inline className="ui-group-row export-row">
                <SegmentedControl
                  size={24}
                  items={[
                    { value: "mp4", label: "MP4" },
                    {
                      value: "webm",
                      label: "WebM",
                      disabledReason:
                        env.encodable.webm[options.size] === false
                          ? `${maker} can't make WebM video`
                          : undefined,
                    },
                  ]}
                  value={options.format}
                  onValueChange={(format) => option({ format: format as ExportOptions["format"] })}
                />
              </Field>
              <Switch
                className="ui-group-row"
                label="Captions"
                description="The step under way, at the foot of the picture"
                checked={choices.captions}
                onCheckedChange={(captions) => choose({ captions })}
              />
              <Switch
                className="ui-group-row"
                label="Skip idle"
                description="Leaves out waits where nothing happens"
                checked={choices.skipIdle}
                onCheckedChange={(skipIdle) => choose({ skipIdle })}
              />
              <Switch
                className="ui-group-row"
                label="Pointer and clicks"
                description="dot's pointer, clicks and typing over the picture"
                checked={choices.overlays}
                onCheckedChange={(overlays) => choose({ overlays })}
              />
            </Group>
          </Disclosure>
          <GroupNote className="export-privacy">
            {where === "page" ? `${PAGE_NOTE} ${PRIVACY_NOTE}` : PRIVACY_NOTE}
          </GroupNote>
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
        label={
          where !== "page" ? "Export" : support.ok && support.save === "picker" ? "Save…" : "Save"
        }
        onSave={() => {
          if (current)
            void job.start(context, request, {
              durationS: current.durationS,
              fitted: current.fitted,
            });
        }}
        job={job}
        onClose={onClose}
      />
    </div>
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={TITLE}
      modal
      returnFocus={anchor}
      footer={footer}
      className="export-sheet"
    >
      {body}
    </Sheet>
  );
}

// 1×, 2× or 3×, or any speed from ¼× to 16× typed or stepped on a row that opens under it.
function SpeedRow({ speed, onSpeed }: { speed: number; onSpeed(speed: number): void }) {
  const step = useMediaQuery("(pointer: coarse)") ? 44 : 28;
  const [custom, setCustom] = useState(() => !SPEED_PRESETS.includes(String(speed) as "1"));
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const typed = parseSpeed(draft);
    setDraft(null);
    if (typed !== null) onSpeed(typed);
  };
  return (
    <>
      <Field label="Speed" inline className="ui-group-row export-row">
        <SegmentedControl
          size={24}
          items={[
            ...SPEED_PRESETS.map((value) => ({ value, label: `${value}×` })),
            { value: "custom", label: "Custom" },
          ]}
          value={custom ? "custom" : String(speed)}
          onValueChange={(value) => {
            setCustom(value === "custom");
            if (value !== "custom") onSpeed(Number(value));
          }}
        />
      </Field>
      <Collapse open={custom}>
        <Field label="Custom speed" inline className="ui-group-row export-row">
          <span className="export-stepper">
            <IconButton
              icon="minus"
              size={step}
              variant="filled"
              label="Slower"
              disabledReason={stepSpeed(speed, -1) === speed ? "This is the slowest" : undefined}
              onClick={() => onSpeed(stepSpeed(speed, -1))}
            />
            <TextField
              size="sm"
              className="export-speed-field num"
              inputMode="decimal"
              autoComplete="off"
              suffix="×"
              value={draft ?? String(Number(speed.toFixed(2)))}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === "Enter") commit();
                if (event.key === "Escape" && draft !== null) {
                  event.stopPropagation();
                  setDraft(null);
                }
              }}
            />
            <IconButton
              icon="plus"
              size={step}
              variant="filled"
              label="Faster"
              disabledReason={stepSpeed(speed, 1) === speed ? "This is the fastest" : undefined}
              onClick={() => onSpeed(stepSpeed(speed, 1))}
            />
          </span>
        </Field>
      </Collapse>
    </>
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
              {fileSize(file.bytes)} · {videoLength(file.durationS)} video · made in{" "}
              {videoLength(file.ms / 1000)}
            </p>
          </>
        )}
        {state.note && (
          <p className="export-file-meta" role="alert">
            {state.note}
          </p>
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
        {picking ? "Choose where to save it" : "Making your video"}
      </p>
      <Progress
        label="Export progress"
        value={picking || !state.total ? undefined : state.done}
        max={state.total || 1}
        valueText={`${percent}%`}
      />
      <p className="export-progress-line num">
        {picking
          ? "Waiting for a place to save it"
          : !state.total
            ? "Getting the recording ready"
            : `${percent}% · ${remaining === null ? "working out the time left" : `about ${timeLabel(remaining)} left`}`}
      </p>
      {!picking && (
        <>
          <p className="export-progress-note">{state.where === "host" ? HOST_NOTE : PAGE_NOTE}</p>
          <Disclosure summary="Details" className="export-details">
            <p className="export-details-text num">
              {state.total
                ? `${state.done.toLocaleString()} of ${state.total.toLocaleString()} frames · `
                : ""}
              {timeLabel(elapsed)} so far
            </p>
          </Disclosure>
        </>
      )}
    </div>
  );
}

function ExportActions({
  state,
  blocked,
  label,
  onSave,
  job,
  onClose,
}: {
  state: ExportJobState;
  blocked: string | undefined;
  // Export when the host makes it; Save… when this browser asks where to save it first.
  label: string;
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
        {label}
      </Button>
    </div>
  );
}
