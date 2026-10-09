import { microsToMs, type SessionCard, type SessionVerdict } from "@localdot/protocol";
import { chapters, planAt, stepAt } from "@localdot/stage";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { isLoopbackPage } from "../deliverables/api.ts";
import { RecordingFiles } from "../deliverables/RecordingFiles.tsx";
import { exportRequest, withinRecording } from "../deliverables/replay-link.ts";
import { DotLoader } from "../dot/DotLoader.tsx";
import { type DotFeed, recordedPresence } from "../dot/dot-feed.ts";
import { PresenceSlot } from "../dot/PresenceSlot.tsx";
import { setReplayPresence } from "../dot/replay-presence.ts";
import { ExportButton } from "../export/ExportButton.tsx";
import { ExportSheet } from "../export/ExportSheet.tsx";
import { ExportsList } from "../export/ExportsList.tsx";
import { type ExportContext, exportContext } from "../export/export-context.ts";
import { type HostExports, hostCanMake, useHostExports } from "../export/host-exports.ts";
import type { ExportJob } from "../export/job.ts";
import { exportSupport } from "../export/sink.ts";
import { useExportProbe } from "../export/useExportProbe.ts";
import type { ApiClient } from "../lib/api.ts";
import { timelineRows } from "../session/key-uses.ts";
import { type StepRowView, stepRows } from "../session/session-view.ts";
import { taskHud } from "../session/status.ts";
import { ActivityRail } from "../shell/ActivityRail.tsx";
import { HANDHELD } from "../shell/layout.ts";
import { NarratorBand } from "../shell/NarratorBand.tsx";
import { RailPanel } from "../shell/RailPanel.tsx";
import { StageFrame } from "../shell/StageFrame.tsx";
import { Stage, type StageHandle } from "../stage/Stage.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { useMediaQuery } from "../ui/media.ts";
import { Presence } from "../ui/Presence.tsx";
import { ScrollArea } from "../ui/ScrollArea.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { CompareView } from "./CompareView.tsx";
import { GapCard, type GapKind } from "./GapCard.tsx";
import { LOADING, ReplayControls } from "./ReplayControls.tsx";
import { ReplayImage } from "./ReplayImage.tsx";
import { useRecordingSummary } from "./recording-summary.ts";
import {
  type LibraryFilter,
  libraryTotal,
  previewMeta,
  recordedLabel,
  replayKey,
  taskTitle,
  timeLabel,
} from "./replay-view.ts";
import { useTaskSearch } from "./search-api.ts";
import {
  type ContinueTask,
  continuable,
  DeleteTask,
  shownCards,
  type TaskIndex,
  TaskList,
  TasksSearch,
  useTaskIndex,
} from "./TasksLibrary.tsx";
import { useReplay } from "./useReplay.ts";
import "./replay.css";

// Below a laptop the library has no room for its preview, so a row opens its recording at once.
// Wide enough for the chosen recording beside the list.
export const PREVIEW_ROOM = "(width >= 1100px)";
// A recording with no video says so on the picture for this long, then as a chip in the transport.
const CONTINUE_LABEL = "Continue working";
const NOTICE_MS = 3000;
// The transport fades this long into playback without the pointer moving over the picture.
const TRANSPORT_STILL_MS = 2000;
const SCREENS = [
  { value: "desktop", label: "Desktop" },
  { value: "browser", label: "Browser" },
] as const;
const FILTERS = [
  { value: "all", label: "All" },
  { value: "finished", label: "Finished" },
  { value: "stopped", label: "Stopped" },
] as const;
const RAIL_VIEWS = [
  { value: "recordings", label: "Recordings" },
  { value: "steps", label: "Steps" },
] as const;
const NO_VIDEO = new Set(["none", "failed", "expired"]);
// WebKit throws on the hundred-and-first address change in ten seconds, which would take the whole
// page down mid-scrub, so the paused time reaches the address at most this often.
const ADDRESS_EVERY_MS = 300;
const RESTING: DotFeed = {
  state: "resting",
  control: false,
  attention: false,
  focus: null,
  dispatched: null,
  done: false,
};

export const RECORDED_TASK = "Recorded task";

export interface RecordedTitle {
  sessionId: string;
  title: string;
  note: string;
  verdict: SessionVerdict;
}

export interface ReplayViewProps {
  api: ApiClient;
  // The recording to play, or null for the library of recordings.
  sessionId: string | null;
  // Opens a recording in the player.
  onSelect(id: string): void;
  // Back from the player to the library.
  onLibrary(): void;
  onGoLive(): void;
  onDeleted(id: string): void;
  // What the top bar names while a recording plays; null once it closes.
  onTitle?(title: RecordedTitle | null): void;
  // Takes a task's conversation up again, in Watch.
  continueTask?: ContinueTask;
  exportJob: ExportJob;
  hostExports: HostExports;
  visible?: boolean;
  // Settings → Appearance → Show dot.
  showDot?: boolean;
}

// Replay (design-v2 §11 H): the library of recordings in the stage's column with the chosen one
// beside it, or one recording playing on the stage with its steps beside it.
export function ReplayView({
  api,
  sessionId,
  onSelect,
  onLibrary,
  onGoLive,
  onDeleted,
  onTitle,
  continueTask,
  exportJob,
  hostExports,
  visible = true,
  showDot = true,
}: ReplayViewProps) {
  const tasks = useTaskIndex(api);
  const [chosen, setChosen] = useState<string | null>(sessionId);
  if (sessionId && chosen !== sessionId) setChosen(sessionId);
  useEffect(() => () => setReplayPresence(null), []);
  const cards = tasks.cards;
  // Continue on the conversation already open, or on a task still running, goes back to Watch.
  const proceed: ContinueTask | undefined = continueTask && {
    current: continueTask.current,
    reason: continueTask.reason,
    run: (id) => {
      const live = cards.find((card) => card.id === id)?.verdict === "live";
      if (live || id === continueTask.current) onGoLive();
      else continueTask.run(id);
    },
  };
  const titled = useRef(onTitle);
  titled.current = onTitle;
  useEffect(() => {
    if (sessionId === null) titled.current?.(null);
  }, [sessionId]);
  return sessionId === null ? (
    <Library
      api={api}
      tasks={tasks}
      hostExports={hostExports}
      chosen={chosen}
      onChoose={setChosen}
      onOpen={onSelect}
      onGoLive={onGoLive}
      onDeleted={onDeleted}
      continueTask={proceed}
      visible={visible}
      showDot={showDot}
    />
  ) : (
    <Player
      api={api}
      sessionId={sessionId}
      tasks={tasks}
      onSelect={onSelect}
      onLibrary={onLibrary}
      onGoLive={onGoLive}
      onDeleted={onDeleted}
      onTitle={onTitle}
      continueTask={proceed}
      exportJob={exportJob}
      hostExports={hostExports}
      visible={visible}
      showDot={showDot}
    />
  );
}

// A phone's pushed screen: back on the left, the screen's name in the middle.
function NavBar({ back, onBack, title }: { back: string; onBack(): void; title: string }) {
  return (
    <nav className="replay-nav" aria-label={title}>
      <Button variant="quiet" className="replay-nav-back" onClick={onBack}>
        <span className="replay-nav-back-label">
          <Icon name="chevron-left" size={22} />
          {back}
        </span>
      </Button>
      <h1 className="replay-nav-title">{title}</h1>
    </nav>
  );
}

function useEscape(enabled: boolean, run: () => void) {
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    if (!enabled) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("dialog, [aria-modal='true'], input, textarea, [role='listbox']")
      )
        return;
      latest.current();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [enabled]);
}

function Library({
  api,
  tasks,
  hostExports,
  chosen,
  onChoose,
  onOpen,
  onGoLive,
  onDeleted,
  continueTask,
  visible,
  showDot,
}: {
  api: ApiClient;
  tasks: TaskIndex;
  hostExports: HostExports;
  chosen: string | null;
  onChoose(id: string): void;
  onOpen(id: string): void;
  onGoLive(): void;
  onDeleted(id: string): void;
  continueTask?: ContinueTask;
  visible: boolean;
  showDot: boolean;
}) {
  const phone = useMediaQuery(HANDHELD);
  const roomy = useMediaQuery(PREVIEW_ROOM) && !phone;
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const matches = useTaskSearch(api, search);
  const shown = shownCards(tasks.cards, search, filter, matches);
  const card = shown.find((entry) => entry.id === chosen) ?? shown[0] ?? null;
  useEscape(visible, onGoLive);
  useEffect(() => {
    if (!roomy || !card) setReplayPresence({ feed: RESTING, line: "" });
  }, [roomy, card]);
  return (
    <div className="replay" data-view="library">
      <main className="replay-library" aria-label="Replay">
        {phone ? (
          <NavBar back="Watch" onBack={onGoLive} title="Replay" />
        ) : (
          <h1 className="ui-visually-hidden">Replay</h1>
        )}
        <div className="replay-library-head">
          <TasksSearch
            size={phone ? "md" : "sm"}
            filled={phone}
            value={search}
            onChange={setSearch}
          />
          {!phone && (
            <SegmentedControl
              aria-label="Show"
              size={28}
              items={FILTERS}
              value={filter}
              onValueChange={(value) => setFilter(value as LibraryFilter)}
            />
          )}
          {!phone && tasks.cards.length > 0 && (
            <span className="replay-library-total num">
              {libraryTotal(tasks.cards, tasks.more)}
            </span>
          )}
        </div>
        <ScrollArea className="replay-library-scroll" fade="bottom">
          {search.trim() === "" && filter === "all" && (
            <ExportsList
              api={api}
              host={hostExports}
              cover={(id) => tasks.cards.find((entry) => entry.id === id)?.coverFrameId ?? null}
            />
          )}
          <TaskList
            api={api}
            index={tasks}
            search={search}
            filter={filter}
            matches={matches}
            selectedId={roomy ? (card?.id ?? null) : null}
            onSelect={roomy ? onChoose : onOpen}
            onDeleted={onDeleted}
            continueTask={continueTask}
            variant={phone ? "phone" : "library"}
          />
        </ScrollArea>
      </main>
      {roomy && (
        <RailPanel label="Chosen recording" className="replay-rail">
          {card ? (
            <RecordingPreview
              key={card.id}
              api={api}
              card={card}
              showDot={showDot}
              onWatch={() => onOpen(card.id)}
              continueTask={continueTask}
              onDeleted={(gone) => {
                tasks.forget(gone.id);
                onDeleted(gone.id);
              }}
            />
          ) : (
            <div className="replay-rail-empty">
              {showDot && <PresenceSlot name="dock" className="replay-rail-dot" />}
              <EmptyState title="Choose a recording">
                Its picture, what dot said and the files it made show here.
              </EmptyState>
            </div>
          )}
        </RailPanel>
      )}
    </div>
  );
}

// The chosen recording in the rail: its picture to play, dot's last line, and what to do with it.
function RecordingPreview({
  api,
  card,
  showDot,
  onWatch,
  continueTask,
  onDeleted,
}: {
  api: ApiClient;
  card: SessionCard;
  showDot: boolean;
  onWatch(): void;
  continueTask?: ContinueTask;
  onDeleted(card: SessionCard): void;
}) {
  const summary = useRecordingSummary(api, card.id);
  const now = useMemo(() => new Date(), []);
  const remove = useRef<HTMLButtonElement>(null);
  const [deleting, setDeleting] = useState<SessionCard | null>(null);
  const line = summary?.line ?? "";
  useEffect(() => setReplayPresence({ feed: RESTING, line }), [line]);
  const title = taskTitle(card);
  return (
    <ScrollArea className="replay-preview" fade="bottom">
      <div className="replay-poster">
        <ReplayImage api={api} sessionId={card.id} frameId={card.coverFrameId} full />
        <span className="replay-poster-play">
          <IconButton
            variant="primary"
            round
            size={52}
            icon="play"
            label="Play this recording"
            onClick={onWatch}
          />
        </span>
      </div>
      <div className="replay-says" data-dot={showDot ? "" : undefined}>
        {showDot && <PresenceSlot name="dock" className="replay-says-dot" />}
        <p className="replay-says-line">
          {showDot ? <span className="ui-visually-hidden">dot: </span> : null}
          {line}
        </p>
      </div>
      <div className="replay-preview-body">
        <h2 className="replay-preview-title">{title}</h2>
        <p className="replay-preview-meta num">
          {previewMeta(card, now, summary?.spend ?? undefined)}
        </p>
        <div className="replay-preview-actions">
          {continueTask && (
            <Button
              variant="primary"
              size="lg"
              icon="continue"
              disabledReason={continuable(card, continueTask) ? continueTask.reason : undefined}
              onClick={() => continueTask.run(card.id)}
            >
              {card.verdict === "live" ? "Watch it live" : CONTINUE_LABEL}
            </Button>
          )}
          <Button size="lg" icon="play" onClick={onWatch}>
            Watch replay
          </Button>
        </div>
        {summary && summary.files.length > 0 && (
          <section className="replay-files" aria-labelledby={`${card.id}-files`}>
            <h3 id={`${card.id}-files`} className="replay-files-title">
              Files
            </h3>
            <RecordingFiles
              api={api}
              sessionId={card.id}
              files={summary.files}
              onMac={isLoopbackPage()}
            />
          </section>
        )}
      </div>
      <div className="replay-preview-foot">
        <Button ref={remove} variant="destructive" icon="trash" onClick={() => setDeleting(card)}>
          Delete recording…
        </Button>
      </div>
      <DeleteTask
        api={api}
        card={deleting}
        anchor={remove}
        onClose={() => setDeleting(null)}
        onDeleted={(gone) => {
          setDeleting(null);
          onDeleted(gone);
        }}
      />
    </ScrollArea>
  );
}

// The island over a recording: what dot was doing at the playhead and when; no controls.
const LOST_LINE = "I couldn't open this recording. Shall I try again?";

function ReplayIsland({
  label,
  time,
  action,
}: {
  label: string;
  time: string;
  action?: ReactNode;
}) {
  return (
    <div className="island-anchor">
      <div className="island" data-shape="replay">
        <span className="island-plate" aria-hidden="true" />
        <div className="island-row">
          <Badge className="island-tag">Replay</Badge>
          <span className="island-label">
            <span className="island-label-text">{label}</span>
          </span>
          <span className="island-elapsed num">{time}</span>
          {action && (
            <>
              <span className="island-divider" aria-hidden="true" />
              {action}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// The transport stays while paused, or while the pointer moves over the picture or focus is in it.
function useTransportShown(playing: boolean, area: RefObject<HTMLElement | null>): boolean {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const element = area.current;
    if (!playing || !element) {
      setShown(true);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
      setShown(true);
      clearTimeout(timer);
      timer = setTimeout(() => setShown(false), TRANSPORT_STILL_MS);
    };
    wake();
    const events = ["pointermove", "pointerdown", "focusin"] as const;
    for (const name of events) element.addEventListener(name, wake);
    return () => {
      clearTimeout(timer);
      for (const name of events) element.removeEventListener(name, wake);
    };
  }, [playing, area]);
  return shown;
}

function Player({
  api,
  sessionId,
  tasks,
  onSelect,
  onLibrary,
  onGoLive,
  onDeleted,
  onTitle,
  continueTask,
  exportJob: job,
  hostExports,
  visible,
  showDot,
}: {
  api: ApiClient;
  sessionId: string;
  tasks: TaskIndex;
  onSelect(id: string): void;
  onLibrary(): void;
  onGoLive(): void;
  onDeleted(id: string): void;
  onTitle?(title: RecordedTitle | null): void;
  continueTask?: ContinueTask;
  exportJob: ExportJob;
  hostExports: HostExports;
  visible: boolean;
  showDot: boolean;
}) {
  const stage = useRef<StageHandle>(null);
  const hostView = useHostExports(hostExports);
  const onHost = hostCanMake(hostView);
  const hostAnswered = !!hostView.host && hostView.host.state !== "checking";
  const area = useRef<HTMLElement>(null);
  const replay = useReplay(api, sessionId, stage, { onGoLive, onExit: onLibrary });
  const phone = useMediaQuery(HANDHELD);
  const [railView, setRailView] = useState<"recordings" | "steps">("steps");
  const exportTrigger = useRef<HTMLButtonElement>(null);
  // The popover is keyed by each opening, so its choices start fresh, and it stays mounted while it
  // closes.
  const [exporting, setExporting] = useState<{
    context: ExportContext;
    open: boolean;
    key: number;
  } | null>(null);
  const exportOpen = exporting?.open ?? false;
  const [notice, setNotice] = useState({ key: "", over: false });
  useExportProbe(api, sessionId, replay);
  const commands = useRef(replay.run);
  commands.current = replay.run;
  const titled = useRef(onTitle);
  titled.current = onTitle;
  const transportShown = useTransportShown(replay.playing, area);

  useEffect(() => {
    if (!visible || exportOpen) return;
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof Element && target.closest("dialog, [aria-modal='true']")) return;
      const targetIsField =
        target instanceof Element &&
        !!target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']");
      const command = replayKey({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        targetIsField,
      });
      if (!command) return;
      if (event.key === " " && target instanceof Element && target.closest("button, a")) return;
      event.preventDefault();
      commands.current(command);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [visible, exportOpen]);

  const addressWritten = useRef({ sessionId: "", at: Number.NEGATIVE_INFINITY });
  useEffect(() => {
    if (replay.playing || !replay.map) return;
    const write = () => {
      const address = new URL(window.location.href);
      if (address.searchParams.get("replay") !== sessionId) return;
      address.searchParams.set("t", String(Math.round(replay.tMs)));
      addressWritten.current = { sessionId, at: performance.now() };
      try {
        window.history.replaceState(window.history.state, "", address);
      } catch {}
    };
    const last = addressWritten.current;
    const wait = last.sessionId === sessionId ? last.at + ADDRESS_EVERY_MS - performance.now() : 0;
    if (wait <= 0) {
      write();
      return;
    }
    const timer = setTimeout(write, wait);
    return () => clearTimeout(timer);
  }, [replay.tMs, replay.playing, replay.map, sessionId]);

  // The task's recording opens once; a live one that reopens as it grows keeps its picture.
  const [opened, setOpened] = useState<string | null>(null);
  if (replay.status !== "loading" && opened !== sessionId) setOpened(sessionId);
  const opening = opened !== sessionId;

  const card = replay.card;
  // A task picked from the library is named from its row until its own card loads.
  const named = card ?? tasks.cards.find((entry) => entry.id === sessionId) ?? null;
  const now = useMemo(() => new Date(), []);
  const note = named ? recordedLabel(named, now) : "";
  useEffect(() => {
    if (named)
      titled.current?.({
        sessionId,
        title: taskTitle(named),
        note: recordedLabel(named, new Date()),
        verdict: named.verdict,
      });
  }, [named, sessionId]);
  useEffect(() => () => titled.current?.(null), []);

  const recording = replay.info?.manifest.state;
  const whole = recording && NO_VIDEO.has(recording) ? (recording as GapKind) : undefined;
  const noticeKey = `${sessionId}/${replay.screen}`;
  const noticeOver = notice.key === noticeKey && notice.over;
  useEffect(() => {
    if (!whole) return;
    const timer = setTimeout(() => setNotice({ key: noticeKey, over: true }), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [whole, noticeKey]);

  const hud = taskHud(replay.model, replay.tMs);
  // A recording that never loaded has no moment to show: the island and dot say so instead.
  const lost = replay.status === "error" && !replay.map && !replay.model.steps.length;
  const recorded = recordedPresence(replay.model, replay.tMs, hud);
  const line = opening ? "" : lost ? LOST_LINE : recorded.line;
  const feed: DotFeed = lost ? { ...recorded.feed, state: "error" } : recorded.feed;
  useEffect(() => setReplayPresence({ feed, line }));
  const support = exportSupport();
  // A link from a result asks for its part of the recording: Export opens on it once the recording
  // has loaded, where the Export button would open, and the address forgets the request.
  const asked = useRef(exportRequest(window.location.search));
  // biome-ignore lint/correctness/useExhaustiveDependencies: the recording having loaded is the trigger.
  useEffect(() => {
    const range = asked.current;
    if (!range || !replay.info || !replay.map) return;
    const here = exportSupport().ok;
    // Without this browser's encoder, the host may not have said yet whether it can make it.
    if (!here && !onHost && !hostAnswered) return;
    asked.current = null;
    const address = new URL(window.location.href);
    address.searchParams.delete("export");
    try {
      window.history.replaceState(window.history.state, "", address);
    } catch {}
    if (!here && !onHost) return;
    replay.run({ kind: "pause" });
    const running = job.snapshot().context;
    const base = running ?? exportContext(api, sessionId, replay);
    const selection = running ? null : withinRecording(base.whole, range);
    const context = selection ? { ...base, selection } : base;
    setExporting((was) => ({ context, open: true, key: (was?.key ?? 0) + 1 }));
  }, [replay.info, replay.map, onHost, hostAnswered]);
  const endedAt = replay.map?.endMs ?? 0;
  const baseRows = stepRows(replay.model);
  const chapterRows: StepRowView[] = chapters(replay.model, endedAt).map((chapter) => {
    const existing = baseRows.find((row) => row.id === chapter.id);
    return (
      existing ?? {
        id: chapter.id,
        label: chapter.label,
        startT: chapter.startT,
        status: chapter.status === "blocked" ? "failed" : chapter.status,
        durationMs: chapter.endT - chapter.startT,
        frameId: replay.model.frames.get(chapter.id),
        ...(chapter.intent ? { intent: chapter.intent } : {}),
      }
    );
  });
  const gap = replay.info?.manifest.gaps.find(
    (entry) =>
      replay.tMs >= microsToMs(entry.from) &&
      (entry.to === null || replay.tMs < microsToMs(entry.to)),
  );
  const gapKind = gap?.reason ?? (noticeOver ? undefined : whole);
  const activeStep = stepAt(replay.model, replay.tMs);
  const title = named ? taskTitle(named) : RECORDED_TASK;
  const browser = card?.recordings?.browser;
  const twoScreens =
    replay.screen === "browser" || (!!browser && browser.bytes > 0 && !NO_VIDEO.has(browser.state));
  const steps = (
    <ActivityRail
      empty={lost ? "Steps show here once the recording loads." : undefined}
      rows={timelineRows(chapterRows, replay.model.keyUses)}
      api={api}
      sessionId={sessionId}
      scale={replay.model.screen?.scale ?? 1}
      asOfMs={replay.tMs}
      onSelect={replay.selectStep}
      planSnapshot={planAt(replay.model, replay.tMs)}
    />
  );

  return (
    <div className="replay" data-view="player">
      {phone && <NavBar back="Replay" onBack={onLibrary} title={note || title} />}
      <main ref={area} className="stage-col replay-main" aria-label="Replay">
        <h1 className="ui-visually-hidden">{title}</h1>
        <StageFrame
          light={hud.control ? "dot" : "none"}
          live
          frozen={false}
          island={
            phone ? undefined : (
              <ReplayIsland
                label={opening ? "Opening…" : lost ? "Couldn't load" : hud.label}
                time={opening || lost ? "" : timeLabel(replay.tMs)}
                action={
                  continueTask && (
                    <Button
                      className="island-action"
                      variant="primary"
                      round
                      size="md"
                      icon="continue"
                      disabledReason={
                        named && continuable(named, continueTask) ? continueTask.reason : undefined
                      }
                      onClick={() => continueTask.run(sessionId)}
                    >
                      {named?.verdict === "live" ? "Watch it live" : CONTINUE_LABEL}
                    </Button>
                  )
                }
              />
            )
          }
          band={
            <NarratorBand line={line} speaker="dot" showDot={showDot} forUser={recorded.forUser} />
          }
        >
          <Stage
            key={sessionId}
            ref={stage}
            mode="replay"
            api={api}
            cell={null}
            reconnects={0}
            listed={[]}
          />
          <Presence show={opening}>
            <DotLoader className="replay-opening" label="Opening this recording" />
          </Presence>
          <GapCard kind={gapKind} />
          {replay.status === "error" && !gapKind && (
            <div className="replay-error" role="alert" data-place={lost ? "centre" : undefined}>
              <div className="replay-error-text">
                <p className="replay-gap-title">
                  {lost ? "This recording couldn't load" : "Part of this recording couldn't load"}
                </p>
                <p className="replay-gap-body">
                  {lost
                    ? "It may still be saving. Try again in a moment."
                    : "Its steps are still here."}
                </p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setOpened(null);
                  replay.retry();
                }}
              >
                Try again
              </Button>
            </div>
          )}
          {replay.compare && (
            <CompareView
              key={activeStep?.id ?? "compare"}
              api={api}
              sessionId={sessionId}
              frames={replay.compare}
              label={chapterRows.find((row) => row.id === activeStep?.id)?.label}
              onClose={() => replay.run({ kind: "exit" })}
            />
          )}
          <div
            className="replay-transport-slot"
            data-shown={transportShown && !lost ? "" : undefined}
            inert={lost}
          >
            <ReplayControls
              api={api}
              replay={replay}
              compact={phone}
              noVideo={!!whole && noticeOver}
              screens={
                twoScreens && (
                  <SegmentedControl
                    size={24}
                    aria-label="Recording screen"
                    items={SCREENS}
                    value={replay.screen}
                    onValueChange={(screen) => replay.setScreen(screen as "desktop" | "browser")}
                  />
                )
              }
              exportControl={
                <ExportButton
                  ref={exportTrigger}
                  job={job}
                  open={exportOpen}
                  disabledReason={
                    onHost || support.ok
                      ? replay.info && replay.map
                        ? undefined
                        : LOADING
                      : support.reason
                  }
                  onOpen={() => {
                    replay.run({ kind: "pause" });
                    const context = job.snapshot().context ?? exportContext(api, sessionId, replay);
                    setExporting((was) => ({ context, open: true, key: (was?.key ?? 0) + 1 }));
                  }}
                />
              }
            />
          </div>
        </StageFrame>
      </main>
      {phone ? (
        <>
          <section className="replay-steps" aria-label="Steps">
            {steps}
          </section>
          {continueTask && (
            <div className="replay-toolbar">
              <Button
                variant="primary"
                size="xl"
                round
                icon="continue"
                disabledReason={
                  named && continuable(named, continueTask) ? continueTask.reason : undefined
                }
                onClick={() => continueTask.run(sessionId)}
              >
                {named?.verdict === "live" ? "Watch it live" : CONTINUE_LABEL}
              </Button>
            </div>
          )}
        </>
      ) : (
        <RailPanel
          label="Recording"
          className="replay-rail"
          views={RAIL_VIEWS}
          view={railView}
          onView={(view) => setRailView(view as "recordings" | "steps")}
        >
          {railView === "steps" ? (
            steps
          ) : (
            <ScrollArea className="replay-rail-scroll" fade="bottom">
              <TaskList
                api={api}
                index={tasks}
                search=""
                selectedId={sessionId}
                onSelect={(id) => {
                  if (id !== sessionId) onSelect(id);
                }}
                onDeleted={onDeleted}
                variant="rail"
              />
            </ScrollArea>
          )}
        </RailPanel>
      )}
      {exporting && (
        <ExportSheet
          key={exporting.key}
          api={api}
          job={job}
          host={hostExports}
          context={exporting.context}
          open={exporting.open}
          anchor={exportTrigger}
          onClose={() => {
            job.dismiss();
            setExporting((was) => was && { ...was, open: false });
          }}
        />
      )}
    </div>
  );
}
