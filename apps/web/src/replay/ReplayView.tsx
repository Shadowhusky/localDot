import { microsToMs } from "@localdot/protocol";
import { chapters, planAt, stepAt } from "@localdot/stage";
import { useEffect, useRef, useState } from "react";
import { ExportButton } from "../export/ExportButton.tsx";
import { ExportPopover } from "../export/ExportPopover.tsx";
import { type ExportContext, exportContext } from "../export/export-context.ts";
import type { ExportJob } from "../export/job.ts";
import { exportSupport } from "../export/sink.ts";
import { useExportProbe } from "../export/useExportProbe.ts";
import type { ApiClient } from "../lib/api.ts";
import { timelineRows } from "../session/key-uses.ts";
import { type StepRowView, stepRows } from "../session/session-view.ts";
import { taskHud } from "../session/status.ts";
import { ActivityRail } from "../shell/ActivityRail.tsx";
import { Stage, type StageHandle } from "../stage/Stage.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { useMediaQuery } from "../ui/media.ts";
import { triggerProps } from "../ui/Popover.tsx";
import { ScrollArea } from "../ui/ScrollArea.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { CompareView } from "./CompareView.tsx";
import { GapCard, type GapKind } from "./GapCard.tsx";
import { LOADING, ReplayControls } from "./ReplayControls.tsx";
import { recordedLabel, replayKey, taskTitle } from "./replay-view.ts";
import { Scrubber } from "./Scrubber.tsx";
import { TaskList, TasksSearch, useTaskIndex } from "./TasksLibrary.tsx";
import { useReplay } from "./useReplay.ts";
import "./replay.css";

// The task list keeps a rail of its own only where the picture keeps its size beside it; elsewhere
// it opens as a sheet from the bar.
const LIBRARY_RAIL = "(width >= 1880px)";
// A recording with no video says so on the picture for this long, then as a chip in the transport.
const NOTICE_MS = 3000;
const SCREENS = [
  { value: "desktop", label: "Desktop" },
  { value: "browser", label: "Browser" },
] as const;
const NO_VIDEO = new Set(["none", "failed", "expired"]);
// WebKit throws on the hundred-and-first address change in ten seconds, which would take the whole
// page down mid-scrub, so the paused time reaches the address at most this often.
const ADDRESS_EVERY_MS = 300;

export const RECORDED_TASK = "Recorded task";

export interface RecordedTitle {
  sessionId: string;
  title: string;
  note: string;
}

export function ReplayView({
  api,
  sessionId,
  onSelect,
  onGoLive,
  onDeleted,
  onTitle,
  exportJob: job,
  visible = true,
}: {
  api: ApiClient;
  sessionId: string;
  onSelect(id: string): void;
  onGoLive(): void;
  onDeleted(id: string): void;
  // What the top bar names while this recording plays; null once Replay closes.
  onTitle?(title: RecordedTitle | null): void;
  exportJob: ExportJob;
  visible?: boolean;
}) {
  const stage = useRef<StageHandle>(null);
  const replay = useReplay(api, sessionId, stage, { onGoLive });
  const tasks = useTaskIndex(api);
  const [search, setSearch] = useState("");
  const railed = useMediaQuery(LIBRARY_RAIL);
  const [library, setLibrary] = useState(false);
  const libraryTrigger = useRef<HTMLButtonElement>(null);
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

  const card = replay.card;
  // A task picked from the library is named from its row until its own card loads.
  const named = card ?? tasks.cards.find((entry) => entry.id === sessionId) ?? null;
  useEffect(() => {
    if (named)
      titled.current?.({
        sessionId,
        title: taskTitle(named),
        note: recordedLabel(named, new Date()),
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
  const support = exportSupport();
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
  const live = replay.info?.live || card?.verdict === "live";
  const select = (id: string) => {
    setLibrary(false);
    if (id !== sessionId) onSelect(id);
  };
  const list = (
    <TaskList
      api={api}
      index={tasks}
      search={search}
      selectedId={sessionId}
      onSelect={select}
      onDeleted={onDeleted}
    />
  );

  return (
    <div className="replay" data-library={railed ? "rail" : "sheet"}>
      {railed && (
        <aside className="rail replay-library" aria-label="Tasks">
          <div className="rail-h">
            <h2>Tasks</h2>
            {tasks.cards.length > 0 && (
              <span className="num">
                {tasks.cards.length}
                {tasks.more ? "+" : ""}
              </span>
            )}
          </div>
          <ScrollArea className="replay-library-scroll" fade="bottom">
            <div className="replay-library-search">
              <TasksSearch value={search} onChange={setSearch} />
            </div>
            {list}
          </ScrollArea>
        </aside>
      )}
      <main className="replay-main" aria-label="Replay">
        <h1 className="ui-visually-hidden">{title}</h1>
        <div className="replay-bar">
          <Button variant="quiet" icon="chevron-left" className="replay-back" onClick={onGoLive}>
            {live ? "Jump to live" : "Back to Watch"}
          </Button>
          <div className="replay-bar-end">
            {twoScreens && (
              <SegmentedControl
                size={24}
                aria-label="Recording screen"
                items={SCREENS}
                value={replay.screen}
                onValueChange={(screen) => replay.setScreen(screen as "desktop" | "browser")}
              />
            )}
            {!railed && (
              <Button
                ref={libraryTrigger}
                variant="secondary"
                className="replay-library-trigger"
                aria-label={`All tasks, showing ${title}`}
                {...triggerProps("dialog", library)}
                onClick={() => setLibrary(true)}
              >
                <span className="replay-library-trigger-text" data-phone="">
                  {title}
                </span>
                <span className="replay-library-trigger-text" data-phone="hidden">
                  All tasks
                </span>
                <Icon name="chevron-down" size={14} />
              </Button>
            )}
          </div>
        </div>
        <div className="replay-frame">
          <div className={`stage lit replay-stage${hud.control ? " control" : ""}`}>
            <Stage
              key={sessionId}
              ref={stage}
              mode="replay"
              api={api}
              cell={null}
              reconnects={0}
              listed={[]}
            />
            <GapCard kind={gapKind} />
            {replay.status === "error" && !gapKind && (
              <p className="replay-error" role="alert">
                Some of the recording couldn't load. The steps are still here.
              </p>
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
          </div>
          <div className="replay-rim" data-on={hud.control ? "" : undefined} aria-hidden="true" />
        </div>
        <Scrubber api={api} sessionId={sessionId} replay={replay} />
        <ReplayControls
          replay={replay}
          label={hud.label}
          noVideo={!!whole && noticeOver}
          exportControl={
            <ExportButton
              ref={exportTrigger}
              job={job}
              open={exportOpen}
              disabledReason={
                support.ok ? (replay.info && replay.map ? undefined : LOADING) : support.reason
              }
              onOpen={() => {
                replay.run({ kind: "pause" });
                const context = job.snapshot().context ?? exportContext(api, sessionId, replay);
                setExporting((was) => ({ context, open: true, key: (was?.key ?? 0) + 1 }));
              }}
            />
          }
        />
      </main>
      <ActivityRail
        rows={timelineRows(chapterRows, replay.model.keyUses)}
        api={api}
        sessionId={sessionId}
        scale={replay.model.screen?.scale ?? 1}
        asOfMs={replay.tMs}
        onSelect={replay.selectStep}
        planSnapshot={planAt(replay.model, replay.tMs)}
      />
      {!railed && (
        <Sheet
          open={library}
          onClose={() => setLibrary(false)}
          title="Tasks"
          modal
          returnFocus={libraryTrigger}
        >
          <div className="replay-library-search">
            <TasksSearch value={search} onChange={setSearch} />
          </div>
          {list}
        </Sheet>
      )}
      {exporting && (
        <ExportPopover
          key={exporting.key}
          api={api}
          job={job}
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
