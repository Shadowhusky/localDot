import "@app/ui/stack.css";
import "@app/theme.css";
import "@app/app.css";
import type { AgentSessionView } from "@app/agent/useAgentSession.ts";
import { onReviseRequest } from "@app/deliverables/revise-draft.ts";
import { Dot } from "@app/dot/Dot.tsx";
import { recordedPresence } from "@app/dot/dot-feed.ts";
import type { DotState } from "@app/dot/engine/states.ts";
import { timelineRows } from "@app/session/key-uses.ts";
import { stepRows } from "@app/session/session-view.ts";
import { ActivityRail } from "@app/shell/ActivityRail.tsx";
import { ChatThread } from "@app/shell/ChatThread.tsx";
import { useLayout } from "@app/shell/layout.ts";
import { NarratorBand } from "@app/shell/NarratorBand.tsx";
import { RailPanel } from "@app/shell/RailPanel.tsx";
import { StageFrame } from "@app/shell/StageFrame.tsx";
import { useMediaQuery } from "@app/ui/media.ts";
import { showToast, Toaster } from "@app/ui/Toast.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { heroDot } from "../signals.ts";
import { setSite, useSite } from "../state.ts";
import { DEMOS, type DemoEntry, loadDemo } from "./catalog.ts";
import { DemoStart } from "./DemoStart.tsx";
import type { DemoTimeline } from "./demo.ts";
import { ReplayNote } from "./ReplayNote.tsx";
import { type BarMode, SiteBar } from "./SiteBar.tsx";
import { SiteIsland } from "./SiteIsland.tsx";
import { siteApi } from "./site-api.ts";
import { TryNext } from "./TryNext.tsx";
import { usePlayer } from "./usePlayer.ts";
import { YourTurn } from "./YourTurn.tsx";
import "./hero.css";
import { t } from "../i18n.ts";

let showing: DemoTimeline | null = null;
const api = siteApi(() => showing);
// The task whose recording has a game the visitor can take over.
const GAME = DEMOS.find((entry) => entry.play);

// The frame on dot's screen, held over the next task's while that comes in, then faded.
function cover(canvas: HTMLCanvasElement | null, video: HTMLVideoElement | null): void {
  if (!canvas || !video?.videoWidth) return;
  canvas.width = video.videoWidth / 2;
  canvas.height = video.videoHeight / 2;
  canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
  canvas.dataset.shown = "";
}

function uncover(canvas: HTMLCanvasElement | null): void {
  if (canvas) delete canvas.dataset.shown;
}

const VIEWS = [
  { value: "chat", label: t("Chat") },
  { value: "activity", label: t("Activity") },
];

// What only localDot itself can do says so in one line, rather than doing nothing. One tip at a time:
// the next replaces it.
function demoTip(description: string) {
  showToast({ id: "demo", title: t("This is a demo."), description, tone: "neutral" });
}

export function HeroApp({ onGo }: { onGo(place: string): void }) {
  const layout = useLayout();
  const phone = layout === "phone";
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const player = usePlayer();
  const { demo, feed, phase, sessionMs } = player;
  showing = demo;
  const [view, setView] = useState<"chat" | "activity">("chat");
  const [mode, setMode] = useState<BarMode>("watch");
  const [failed, setFailed] = useState<string | null>(null);
  const picked = useRef(false);
  // A task the visitor picked has the window to itself: on a phone it rises over the headline, as
  // the app fills the screen, so the chat has room.
  const [chose, setChose] = useState(false);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const videoRef = useCallback(
    (el: HTMLVideoElement | null) => {
      player.video(el);
      setVideoEl(el);
    },
    [player.video],
  );
  const chosen = useSite();
  const yours = chosen.control === "you";
  const rewinding = chosen.rewind !== null;
  useEffect(
    () => player.hold(yours || chosen.offstage || rewinding || chosen.film),
    [player.hold, yours, chosen.offstage, rewinding, chosen.film],
  );
  useEffect(() => player.rewind(chosen.rewind), [player.rewind, chosen.rewind]);
  const handoff = useRef<HTMLCanvasElement>(null);
  const notices = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      onReviseRequest(() => demoTip(t("In your own localDot, dot revises the file as you ask."))),
    [],
  );
  // Handed back, the game fades into the recording under it.
  const [turn, setTurn] = useState(false);
  useEffect(() => {
    if (yours) {
      setTurn(true);
      return;
    }
    const id = window.setTimeout(() => setTurn(false), 320);
    return () => window.clearTimeout(id);
  }, [yours]);

  const pick = useCallback(
    (entry: DemoEntry) => {
      picked.current = true;
      setMode("watch");
      setView("chat");
      loadDemo(entry.id)
        .then((timeline) => {
          setFailed(null);
          player.start(timeline);
        })
        .catch(() => setFailed(t("That recording didn't load. Try another, or reload the page.")));
    },
    [player.start],
  );
  const choose = useCallback(
    (entry: DemoEntry) => {
      setChose(true);
      pick(entry);
    },
    [pick],
  );

  // The page opens on the app as it starts, still, until the visitor picks a task. From its Watch
  // chapter the story shows a task at work, so a visitor who scrolls that far without picking gets
  // the first; a page reopened a little way down stays still.
  useEffect(() => {
    if (reduced) return;
    const watch = document.querySelector<HTMLElement>('.mark[data-chapter="watch"]');
    const onScroll = () => {
      const first = DEMOS[0];
      if (!picked.current && first && watch && watch.getBoundingClientRect().top < innerHeight)
        pick(first);
    };
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });
    return () => removeEventListener("scroll", onScroll);
  }, [pick, reduced]);

  // Step in brings dot's game to its screen as its words come: the replay travels there from where it
  // was, through the work ahead or back through the game; from another task, or none, dot's game
  // takes the screen over the last frame.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only arriving at Step in moves the replay
  useEffect(() => {
    const play = GAME?.play;
    if (!chosen.game || yours || !GAME || !play) return;
    if (demo?.id === GAME.id && videoEl) {
      const at = videoEl.currentTime;
      if (phase === "done" || at < play.from - 0.3 || at > play.to) player.travel(play.from * 1000);
      return;
    }
    cover(handoff.current, videoEl);
    // The last frame never outstays a recording that is slow to come.
    window.setTimeout(() => uncover(handoff.current), 2500);
    picked.current = true;
    setMode("watch");
    setView("chat");
    loadDemo(GAME.id)
      .then((timeline) => {
        setFailed(null);
        const shown = () => uncover(handoff.current);
        videoEl?.addEventListener("seeked", shown, { once: true });
        window.setTimeout(shown, 1500);
        player.start(timeline, { videoMs: play.from * 1000, still: reduced });
      })
      .catch(() => uncover(handoff.current));
  }, [chosen.game]);

  // While the visitor reads Step in, dot plays on, winding back before its game is won.
  useEffect(() => {
    const play = GAME?.play;
    if (!chosen.game || yours || reduced || !play || demo?.id !== GAME?.id || !videoEl) return;
    const onTime = () => {
      if (!player.travelling && videoEl.currentTime >= play.to) player.travel(play.from * 1000);
    };
    videoEl.addEventListener("timeupdate", onTime);
    return () => videoEl.removeEventListener("timeupdate", onTime);
  }, [chosen.game, yours, reduced, demo, videoEl, player.travel, player.travelling]);

  // The app's Watch replay and proof moments open Replay through the address; here they replay the
  // demo from that moment. Export proof video is the app's own.
  useEffect(() => {
    const onPop = () => {
      const url = new URL(location.href);
      const session = url.searchParams.get("replay");
      if (!session) return;
      const at = Number(url.searchParams.get("t") ?? 0);
      const exporting = url.searchParams.has("export");
      for (const key of ["replay", "t", "export"]) url.searchParams.delete(key);
      history.replaceState(null, "", url);
      if (exporting) demoTip(t("In your own localDot, this saves the replay as a video."));
      else if (demo && session === demo.sessionId) player.replayFrom(Number.isFinite(at) ? at : 0);
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, [demo, player.replayFrom]);

  const version = feed?.version ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the feed folds in place; its version and the clock are what change
  const presence = useMemo(
    () => (feed && demo && phase !== "starting" ? recordedPresence(feed.stage, sessionMs) : null),
    [feed, demo, phase, sessionMs, version],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: as above
  const rows = useMemo(
    () => (feed ? timelineRows(stepRows(feed.stage), feed.stage.keyUses) : []),
    [feed, version],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: as above
  const agent = useMemo<AgentSessionView | undefined>(
    () =>
      feed && demo
        ? ({
            sessionId: demo.sessionId,
            model: feed.agent,
            snapshot: null,
            availability: "ready",
            error: null,
            fresh: false,
            history: true,
            connection: "open",
            reconcile() {},
          } as unknown as AgentSessionView)
        : undefined,
    [feed, demo, version],
  );

  const working = phase === "playing" || phase === "paused";
  const line =
    failed ??
    (phase === "starting"
      ? t("Listening.")
      : (presence?.line ?? t("Hi, I'm dot. Pick a task and I'll show you how I did it.")));
  const segment = demo?.segments.find((s) => sessionMs >= s.from && sessionMs <= s.to);
  // dot keeps its own face here, glancing at the work, rather than the task's moods.
  const dotState: DotState = phase === "starting" ? "listening" : "idle";
  heroDot.state = dotState;
  heroDot.control = !!presence?.feed.control && working && !yours;
  heroDot.focus = working ? (presence?.feed.focus ?? null) : null;
  heroDot.line = line;
  const start = (
    <DemoStart
      current={demo?.id}
      onPick={(entry) => {
        setMode("watch");
        choose(entry);
      }}
    />
  );
  // The picker stays until the task's request is in, so the chat changes once.
  const showStart = !demo || mode === "replay" || rows.length === 0;

  return (
    // Activity is a view of the one rail here, so wide screens give the app's Activity column back.
    <div
      className="app site-app"
      data-layout={layout}
      data-phase={phase}
      data-chosen={chose && !showStart ? "" : undefined}
      data-activity-hidden=""
    >
      <SiteBar title={demo ? t(demo.title) : undefined} mode={mode} onMode={setMode} />
      <div className="watch">
        <main className="stage-col" aria-label={t("dot's computer")}>
          <StageFrame
            light={yours ? "you" : presence?.feed.control && working ? "dot" : "none"}
            live={!!demo}
            frozen={false}
            island={
              <>
                <SiteIsland
                  shown={working || phase === "done" || yours}
                  yours={yours}
                  onHandBack={() => {
                    setSite({ control: "dot" });
                    // Hand back leaves with its button: focus goes to the story's Take control.
                    document
                      .querySelector<HTMLElement>('[data-act="control"]')
                      ?.focus({ preventScroll: true });
                  }}
                  label={
                    yours
                      ? t("You have control")
                      : player.travelling === "ahead"
                        ? t("Skipping to the game")
                        : player.travelling === "back"
                          ? t("Back to the game")
                          : phase === "done"
                            ? t("Done")
                            : line
                  }
                  elapsedMs={Math.max(0, sessionMs)}
                  speed={phase === "done" ? null : (segment?.speed ?? null)}
                  playing={phase === "playing"}
                  onToggle={player.toggle}
                  phone={phone}
                  noticesRef={notices}
                />
                <Toaster anchor={notices} />
              </>
            }
            band={
              <NarratorBand
                line={line}
                speaker="dot"
                showDot
                idle={!working}
                forUser={phase === "done"}
                dot={{
                  label: t("Meet the dots for other jobs"),
                  open: false,
                  onPress: () => onGo("dots"),
                }}
              />
            }
          >
            <video
              ref={videoRef}
              className="site-video"
              muted
              playsInline
              preload="auto"
              poster={demo?.video.poster ?? `/demos/${DEMOS[0]?.id}/poster.webp`}
              src={phone ? (demo?.video.small ?? demo?.video.src) : demo?.video.src}
              aria-label={
                demo ? t("Recording of dot's screen: {title}", { title: t(demo.title) }) : undefined
              }
            />
            <canvas ref={handoff} className="site-handoff" />
            {(yours || turn) && (
              <YourTurn
                video={videoEl}
                breakout={!!GAME && demo?.id === GAME.id}
                travelling={player.travelling !== null}
                leaving={!yours}
              />
            )}
          </StageFrame>
        </main>
        <RailPanel
          label={t("Conversation")}
          className="rail-chat"
          views={showStart ? undefined : VIEWS}
          view={view}
          onView={(next) => setView(next as "chat" | "activity")}
        >
          {view === "activity" && !showStart ? (
            <ActivityRail
              rows={rows}
              sessionId={demo?.id ?? null}
              scale={1}
              api={api}
              agent={feed?.agent}
              nowMs={sessionMs}
              historyLoaded
            />
          ) : (
            <ChatThread
              agent={showStart ? undefined : agent}
              api={api}
              rows={showStart ? undefined : rows}
              live={
                working && !showStart ? { phase: "running", label: line, nowMs: sessionMs } : null
              }
              start={showStart ? start : undefined}
              pinned={phone}
              composer={
                <>
                  {phase === "done" && demo && <TryNext current={demo.id} onPick={choose} />}
                  <ReplayNote model={demo?.model.label} />
                </>
              }
            />
          )}
        </RailPanel>
      </div>
      <DockedDot state={dotState} control={!!presence?.feed.control && working} />
    </div>
  );
}

// Until the 3D dot takes its place, the app's own dot sits in the band's dock.
function DockedDot({ state, control }: { state: DotState; control: boolean }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSlot(document.querySelector<HTMLElement>(".site-app .narrator-dock"));
  }, []);
  if (!slot) return null;
  const size = Math.round(slot.getBoundingClientRect().width) || 88;
  return createPortal(<Dot size={size} state={state} control={control} />, slot);
}
