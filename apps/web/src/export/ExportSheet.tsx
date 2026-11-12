import type { DotPlacement } from "@localdot/protocol";
import {
  type ReactNode,
  type RefObject,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Glyph } from "../dot/Glyph.tsx";
import { t, tr } from "../i18n/index.ts";
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
import { ExportPreview } from "./ExportPreview.tsx";
import type { ExportContext } from "./export-context.ts";
import {
  type Calibration,
  type ExportEstimate,
  estimateExport,
  storedCalibration,
  waitText,
} from "./export-estimate.ts";
import type { ExportPlan } from "./export-plan.ts";
import {
  bandLineAt,
  EXPORT_FRAME_RATES,
  EXPORT_QUALITIES,
  type ExportQuality,
  type ExportRequest,
  fileSize,
  planExport,
  videoLength,
} from "./export-plan.ts";
import {
  choosePreset,
  type ExportChoices,
  type ExportEnvironment,
  type ExportOptions,
  encodable,
  exportRequest,
  fitOptions,
  frameRateAllowed,
  keepChoices,
  maxFrameRate,
  optionsFor,
  PRIVACY_NOTE,
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
import { EDGE_LABEL, Trim, type TrimHold } from "./Trim.tsx";
import { fitTrim, frameAt, type TrimEdge, type TrimRange, trimTimeLabel } from "./trim.ts";
import { useExportEnvironment } from "./useExportEnvironment.ts";
import "./export.css";

const TITLE = t`Export video`;
const NO_STEP = t`The playhead isn't on a step`;
const NO_SELECTION = t`Press I and O on the timeline to mark a stretch`;
const NO_SELECTION_TOUCH = t`On a keyboard, press I and O on the timeline to mark a stretch`;
const NOT_CUSTOM = t`Set under More options`;
const SPEED_PRESETS = ["1", "2", "3"] as const;
const QUALITY_LABEL: Record<ExportQuality, string> = {
  low: tr("Low"),
  medium: tr("Medium"),
  high: tr("High"),
};
const QUALITY_NOTE: Record<ExportQuality, string> = {
  low: tr("low quality"),
  medium: tr("medium quality"),
  high: tr("high quality"),
};
const WITH_DOT = t`with dot`;
const PRESET_NOTE = {
  quality: tr("sharpest"),
  fast: tr("smallest"),
  showcase: WITH_DOT,
} as const;
const PLACES = [
  { value: "under", label: tr("Under the picture") },
  { value: "over", label: tr("On the picture") },
] as const;
// The elapsed time and the estimate of what is left move on this beat while a video is saved.
const TICK_MS = 500;
const PAGE_NOTE = t`This page makes the video, so keep it open until it's saved.`;
const HOST_NOTE = t`It keeps going if you close this page or switch apps.`;
const RESULT_TITLE = {
  ready: tr("Your video is ready"),
  downloaded: tr("Downloaded"),
  saved: tr("Video saved"),
} as const;

const cantMake = (where: "host" | "checking" | "page", what: string) =>
  where === "page"
    ? t`This browser can't make ${what} video`
    : t`This computer can't make ${what} video`;

function optionsText(options: ExportOptions, env: ExportEnvironment): string {
  const size = sizeOf(options.size, env, options.dot);
  return `${size.w} × ${size.h} · ${options.fps} fps`;
}

interface Outcome extends ExportEstimate {
  plan: ExportPlan;
  durationS: number;
  // Before this browser's own calibration, which the finished export corrects.
  fitted: ExportEstimate;
}

function outcomeOf(
  context: ExportContext,
  env: ExportEnvironment,
  calibration: Calibration,
  options: ExportOptions,
  base: ExportRequest,
): Outcome | null {
  try {
    const request = {
      ...base,
      ...options,
      dot: options.dot === "off" ? undefined : options.dot,
      size: sizeOf(options.size, env, options.dot),
    };
    const plan = planExport(request, context.model, context.activity, context.gaps);
    return {
      ...estimateExport(plan, request, calibration),
      plan,
      durationS: plan.durationS,
      fitted: estimateExport(plan, request),
    };
  } catch {
    return null;
  }
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
  useEffect(() => {
    if (open) host.refresh();
  }, [open, host]);
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
  const [range, setRange] = useState<TrimRange>(() =>
    fitTrim(context.selection ?? context.whole, context.whole),
  );
  // The end of the range the preview shows, once one has moved; the playhead's moment until then.
  const [shownEdge, setShownEdge] = useState<TrimEdge | null>(null);
  const [hold, setHold] = useState<TrimHold | null>(null);
  const [choices, setChoices] = useState<ExportChoices>(storedChoices);
  const [calibration] = useState(storedCalibration);

  const support = exportSupport();
  // The estimates follow a moving handle as fast as they can be worked out, never holding it back.
  const chosen = useDeferredValue(range);
  const options = optionsFor(choices, env);
  const { presets, outcomes, current } = useMemo(() => {
    const request = exportRequest(context.sessionId, chosen, choices, env);
    const outcome = (rowOptions: ExportOptions, base = request) =>
      outcomeOf(context, env, calibration, rowOptions, base);
    // Showcase is made at 1× with idle skipped, so its row says what choosing it would make.
    const showcase = choices.preset === "showcase" ? choices : choosePreset(choices, "showcase");
    const presets = {
      quality: presetOptions("quality", env, choices.speed),
      fast: presetOptions("fast", env, choices.speed),
      showcase: presetOptions("showcase", env, showcase.speed),
      custom: fitOptions(choices.custom, env, choices.speed),
    } satisfies Record<PresetChoice, ExportOptions>;
    return {
      presets,
      outcomes: {
        quality: outcome(presets.quality),
        fast: outcome(presets.fast),
        showcase: outcome(
          presets.showcase,
          exportRequest(context.sessionId, chosen, showcase, env),
        ),
        custom: outcome(presets.custom),
      },
      current: outcome(optionsFor(choices, env)),
    };
  }, [context, chosen, choices, env, calibration]);

  const update = (next: ExportChoices) => {
    setChoices(next);
    keepChoices(next);
    if (state.note) job.reset();
  };
  const choose = (patch: Partial<ExportChoices>) => update({ ...choices, ...patch });
  const option = (patch: Partial<ExportOptions>) => update(withOption(choices, env, patch));
  const trim = (next: TrimRange, edge: TrimEdge) => {
    setRange(next);
    setShownEdge(edge);
    if (state.note) job.reset();
  };
  const placeDot = (place: DotPlacement) =>
    update({ ...withOption(choices, env, { dot: place }), place });

  const canMake = encodable(env, options.format, options.size, options.dot);
  const blocked =
    where === "checking"
      ? t`Checking what this computer can make`
      : where === "page" && !support.ok
        ? support.reason
        : current === null
          ? t`Nothing was recorded in this range`
          : canMake === undefined
            ? t`Checking what this browser can make`
            : canMake === false
              ? cantMake(where, sizeLabel(options.size))
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
        t`${videoLength(current?.durationS ?? 0)} video · about ${fileSize(current?.bytes ?? 0)} · ready in ${waitText(current?.ms ?? 0)}`);

  const working = state.phase !== "options";
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scroller = bodyRef.current?.closest(".ui-sheet-body");
    if (working && scroller) scroller.scrollTop = 0;
  }, [working]);
  const screen = context.source.screen ?? "desktop";
  const edgeAt = (edge: TrimEdge) => (edge === "from" ? range.fromMs : range.toMs);
  const shownOf = hold?.edge ?? shownEdge;
  const shownAt = Math.max(
    range.fromMs,
    Math.min(range.toMs, shownOf ? edgeAt(shownOf) : context.atMs),
  );
  const frame = frameAt(context.model, shownAt, range, screen);
  const caption = bandLineAt(context.model, shownAt);
  const said = options.dot === "off" ? "" : caption;
  // The handle's time stays in the chip while it fades out.
  const held = useRef<TrimEdge>("from");
  if (hold) held.current = hold.edge;
  const cap = maxFrameRate(env, choices.speed);
  const previewRequest = exportRequest(context.sessionId, chosen, choices, env);

  const presetRow = (preset: PresetChoice, label: string) => {
    const result = outcomes[preset];
    const unavailable = preset === "custom" && choices.preset !== "custom";
    return {
      value: preset,
      label,
      description:
        preset === "custom"
          ? `${optionsText(presets.custom, env)} · ${QUALITY_NOTE[presets.custom.quality]}${presets.custom.dot === "off" ? "" : ` · ${WITH_DOT}`}`
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
            <ExportPreview
              key={JSON.stringify(previewRequest)}
              context={context}
              request={previewRequest}
              plan={current?.plan ?? null}
              active={open && !working && !hold}
              held={!!hold}
            >
              <div className="export-preview-picture">
                <ReplayImage
                  api={api}
                  sessionId={context.sessionId}
                  frameId={frame}
                  full={!hold?.dragging}
                />
                <span className="export-preview-time num" aria-hidden="true">
                  <span className="export-preview-time-label">{EDGE_LABEL[held.current]}</span>
                  {trimTimeLabel(edgeAt(held.current))}
                </span>
                <span
                  className="export-preview-caption"
                  data-shown={options.captions && caption ? "" : undefined}
                  data-place={options.dot === "over" ? "head" : undefined}
                  aria-hidden="true"
                >
                  {caption}
                </span>
                <span className="export-preview-bubble" aria-hidden="true">
                  <Glyph />
                  {said && <span className="export-preview-said">{said}</span>}
                </span>
              </div>
              <span className="export-preview-band" aria-hidden="true">
                <span className="export-preview-band-inner">
                  <Glyph />
                  <span className="export-preview-said">{said}</span>
                </span>
              </span>
            </ExportPreview>
            <Trim
              api={api}
              sessionId={context.sessionId}
              model={context.model}
              screen={screen}
              whole={context.whole}
              shortcuts={{
                whole: context.whole,
                chapter: context.chapter,
                selection: context.selection,
              }}
              unavailable={{
                chapter: NO_STEP,
                selection: touch ? NO_SELECTION_TOUCH : NO_SELECTION,
              }}
              range={range}
              onRange={trim}
              snap={choices.snap}
              onSnap={(snap) => choose({ snap })}
              onHold={setHold}
            />
          </div>
          <RadioCards
            aria-label={t`Preset`}
            className="export-presets"
            value={choices.preset}
            onValueChange={(value) => update(choosePreset(choices, value as PresetChoice))}
            options={[
              presetRow("quality", t`Quality`),
              presetRow("fast", t`Fast`),
              presetRow("showcase", t`Showcase`),
              presetRow("custom", t`Custom`),
            ]}
          />
          <Group>
            <SpeedRow speed={choices.speed} onSpeed={(speed) => choose({ speed })} />
            <Switch
              className="ui-group-row"
              label={t`Show dot`}
              description={t`dot and what it's doing, as in the app`}
              checked={options.dot !== "off"}
              onCheckedChange={(on) => option({ dot: on ? choices.place : "off" })}
            />
            <Collapse open={options.dot !== "off"}>
              <Field label={t`Position`} inline className="ui-group-row export-row">
                <SegmentedControl
                  size={24}
                  items={PLACES}
                  value={options.dot === "off" ? choices.place : options.dot}
                  onValueChange={(place) => placeDot(place as DotPlacement)}
                />
              </Field>
            </Collapse>
          </Group>
          <Disclosure
            summary={t`More options`}
            meta={`${sizeLabel(options.size)} · ${options.fps} fps · ${options.format === "webm" ? "WebM" : "MP4"}`}
            className="export-more"
          >
            <Group className="export-advanced">
              <Field label={t`Resolution`} inline className="ui-group-row export-row">
                <SegmentedControl
                  size={24}
                  items={SIZE_CHOICES.map((size) => ({
                    value: size,
                    label: sizeLabel(size),
                    disabledReason:
                      encodable(env, options.format, size, options.dot) === false
                        ? cantMake(where, sizeLabel(size))
                        : undefined,
                  }))}
                  value={options.size}
                  onValueChange={(size) => option({ size: size as SizeChoice })}
                />
              </Field>
              <Field label={t`Frame rate`} inline className="ui-group-row export-row">
                <SegmentedControl
                  size={24}
                  items={EXPORT_FRAME_RATES.map((rate) => ({
                    value: String(rate),
                    label: String(rate),
                    disabledReason: frameRateAllowed(rate, env, choices.speed)
                      ? undefined
                      : t`The recording has no more than ${cap} fps at this speed`,
                  }))}
                  value={String(options.fps)}
                  onValueChange={(rate) => option({ fps: Number(rate) as ExportOptions["fps"] })}
                />
              </Field>
              <Field label={t`Quality`} inline className="ui-group-row export-row">
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
              <Field label={t`Format`} inline className="ui-group-row export-row">
                <SegmentedControl
                  size={24}
                  items={[
                    { value: "mp4", label: "MP4" },
                    {
                      value: "webm",
                      label: "WebM",
                      disabledReason:
                        encodable(env, "webm", options.size, options.dot) === false
                          ? cantMake(where, "WebM")
                          : undefined,
                    },
                  ]}
                  value={options.format}
                  onValueChange={(format) => option({ format: format as ExportOptions["format"] })}
                />
              </Field>
              <Switch
                className="ui-group-row"
                label={t`Show the current step`}
                description={t`A small caption on the video`}
                checked={options.captions}
                onCheckedChange={(captions) => option({ captions })}
              />
              <Switch
                className="ui-group-row"
                label={t`Skip idle`}
                description={t`Leaves out waits where nothing happens`}
                checked={choices.skipIdle}
                onCheckedChange={(skipIdle) => choose({ skipIdle })}
              />
              <Switch
                className="ui-group-row"
                label={t`Pointer and clicks`}
                description={t`dot's pointer, clicks and typing over the picture`}
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
          where !== "page"
            ? t`Export`
            : support.ok && support.save === "picker"
              ? t`Save…`
              : t`Save`
        }
        onSave={() => {
          const final = exportRequest(context.sessionId, range, choices, env);
          const made = outcomeOf(context, env, calibration, options, final);
          if (made)
            void job.start(context, final, { durationS: made.durationS, fitted: made.fitted });
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
      <Field label={t`Speed`} inline className="ui-group-row export-row">
        <SegmentedControl
          size={24}
          items={[
            ...SPEED_PRESETS.map((value) => ({ value, label: `${value}×` })),
            { value: "custom", label: t`Custom` },
          ]}
          value={custom ? "custom" : String(speed)}
          onValueChange={(value) => {
            setCustom(value === "custom");
            if (value !== "custom") onSpeed(Number(value));
          }}
        />
      </Field>
      <Collapse open={custom}>
        <Field label={t`Custom speed`} inline className="ui-group-row export-row">
          <span className="export-stepper">
            <IconButton
              icon="minus"
              size={step}
              variant="filled"
              label={t`Slower`}
              disabledReason={stepSpeed(speed, -1) === speed ? t`This is the slowest` : undefined}
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
              label={t`Faster`}
              disabledReason={stepSpeed(speed, 1) === speed ? t`This is the fastest` : undefined}
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
              {t`${fileSize(file.bytes)} · ${videoLength(file.durationS)} video · made in ${videoLength(file.ms / 1000)}`}
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
        {picking ? t`Choose where to save it` : t`Making your video`}
      </p>
      <Progress
        label={t`Export progress`}
        value={picking || !state.total ? undefined : state.done}
        max={state.total || 1}
        valueText={`${percent}%`}
      />
      <p className="export-progress-line num">
        {picking
          ? t`Waiting for a place to save it`
          : state.waiting
            ? t`Waiting to start`
            : !state.total
              ? t`Getting the recording ready`
              : `${percent}% · ${remaining === null ? t`working out the time left` : t`about ${timeLabel(remaining)} left`}`}
      </p>
      {!picking && (
        <>
          <p className="export-progress-note">{state.where === "host" ? HOST_NOTE : PAGE_NOTE}</p>
          <Disclosure summary={t`Details`} className="export-details">
            <p className="export-details-text num">
              {state.total
                ? t`${state.done.toLocaleString()} of ${state.total.toLocaleString()} frames · ${timeLabel(elapsed)} so far`
                : t`${timeLabel(elapsed)} so far`}
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
          disabledReason={
            state.phase === "picking" ? t`Choose a place to save it first` : undefined
          }
          onClick={() => job.cancel()}
        >
          {t`Cancel`}
        </Button>
        <Button onClick={onClose}>{t`Keep working`}</Button>
      </div>
    );
  if (state.phase === "ready")
    return (
      <div className="export-actions">
        <Button variant="primary" icon="download" onClick={() => job.save()}>
          {t`Save video`}
        </Button>
      </div>
    );
  if (state.phase === "downloaded" || state.phase === "saved")
    return (
      <div className="export-actions">
        {state.phase === "downloaded" && (
          <Button variant="quiet" icon="download" onClick={() => job.save()}>
            {t`Save again`}
          </Button>
        )}
        <Button
          onClick={() => {
            job.reset();
            onClose();
          }}
        >
          {t`Done`}
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
