import { microsToMs } from "@localdot/protocol";
import { chapters, planAt, stepAt } from "@localdot/stage";
import { useEffect, useRef, useState } from "react";
import { ExportSheet } from "../export/ExportSheet.tsx";
import { type ExportContext, exportContext } from "../export/export-context.ts";
import { useExportProbe } from "../export/useExportProbe.ts";
import type { ApiClient } from "../lib/api.ts";
import { timelineRows } from "../session/key-uses.ts";
import { type StepRowView, sessionHud, stepRows } from "../session/session-view.ts";
import { PlanRail } from "../shell/PlanRail.tsx";
import { Stage, type StageHandle } from "../stage/Stage.tsx";
import { CompareView } from "./CompareView.tsx";
import { GapCard } from "./GapCard.tsx";
import { ReplayControls } from "./ReplayControls.tsx";
import { replayKey, timeLabel } from "./replay-view.ts";
import { Scrubber } from "./Scrubber.tsx";
import { SessionsRail } from "./SessionsRail.tsx";
import { useReplay } from "./useReplay.ts";
import "./replay.css";

export function ReplayView({
  api,
  sessionId,
  onSelect,
  onGoLive,
  onDeleted,
  visible = true,
}: {
  api: ApiClient;
  sessionId: string;
  onSelect(id: string): void;
  onGoLive(): void;
  onDeleted(id: string): void;
  visible?: boolean;
}) {
  const stage = useRef<StageHandle>(null);
  const replay = useReplay(api, sessionId, stage, { onGoLive });
  const [exporting, setExporting] = useState<{
    context: ExportContext;
    anchor: HTMLButtonElement;
  } | null>(null);
  useExportProbe(api, sessionId, replay);
  const commands = useRef(replay.run);
  commands.current = replay.run;
  useEffect(() => {
    if (!visible || exporting !== null) return;
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
  }, [visible, exporting]);
  useEffect(() => {
    if (replay.playing || !replay.map) return;
    const address = new URL(window.location.href);
    if (address.searchParams.get("replay") !== sessionId) return;
    address.searchParams.set("t", String(Math.round(replay.tMs)));
    window.history.replaceState(null, "", address);
  }, [replay.tMs, replay.playing, replay.map, sessionId]);
  const hud = sessionHud(replay.model, replay.tMs);
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
  const recording = replay.info?.manifest.state;
  const gapKind =
    gap?.reason ??
    (recording === "none" || recording === "failed" || recording === "expired"
      ? recording
      : undefined);
  const activeStep = stepAt(replay.model, replay.tMs);
  return (
    <div className="house replay-house">
      <SessionsRail api={api} selectedId={sessionId} onSelect={onSelect} onDeleted={onDeleted} />
      <main className="replay-main" aria-label="Session replay">
        <header className="replay-heading">
          <div>
            <span className="replay-tag">Replay</span>
            <h1>{replay.card?.title ?? "Recorded session"}</h1>
          </div>
          <fieldset className="replay-screen-picker" aria-label="Recording screen">
            {(["desktop", "browser"] as const).map((screen) => (
              <button
                key={screen}
                type="button"
                aria-pressed={replay.screen === screen}
                disabled={exporting !== null}
                onClick={() => replay.setScreen(screen)}
              >
                {screen === "desktop" ? "Desktop" : "Browser"}
              </button>
            ))}
          </fieldset>
          {(replay.info?.live || replay.card?.verdict === "live") && (
            <button type="button" onClick={onGoLive}>
              Jump to live
            </button>
          )}
        </header>
        <div className={`stage lit replay-stage${hud.control ? " control" : ""}`}>
          <Stage
            key={sessionId}
            ref={stage}
            mode="replay"
            api={api}
            cell={null}
            reconnects={0}
            listed={[]}
            control={hud.control}
          />
          {hud.control && <div className="rim" aria-hidden="true" />}
          <div className="replay-hud">
            <span>Replay</span>
            <strong>{hud.label}</strong>
            <span>
              {timeLabel(replay.tMs)} / {timeLabel(endedAt)}
            </span>
          </div>
          {gapKind && <GapCard kind={gapKind} />}
          {replay.status === "error" && !gapKind && (
            <p className="replay-error" role="alert">
              Replay could not load all media. Recorded steps remain available.
            </p>
          )}
          {replay.compare && (
            <CompareView
              key={activeStep?.id ?? "compare"}
              api={api}
              sessionId={sessionId}
              frames={replay.compare}
              onClose={() => replay.run({ kind: "exit" })}
            />
          )}
        </div>
        <p className="replay-caption">{hud.caption}</p>
        <Scrubber api={api} sessionId={sessionId} replay={replay} />
        <ReplayControls
          replay={replay}
          onExport={(anchor) => {
            replay.run({ kind: "pause" });
            setExporting({ context: exportContext(api, sessionId, replay), anchor });
          }}
        />
      </main>
      <PlanRail
        rows={timelineRows(chapterRows, replay.model.keyUses)}
        api={api}
        sessionId={sessionId}
        scale={replay.model.screen?.scale ?? 1}
        title={replay.model.title}
        asOfMs={replay.tMs}
        onSelect={replay.selectStep}
        planSnapshot={planAt(replay.model, replay.tMs)}
      />
      {exporting && (
        <ExportSheet
          context={exporting.context}
          anchor={exporting.anchor}
          onClose={() => setExporting(null)}
        />
      )}
    </div>
  );
}
