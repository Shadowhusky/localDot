import { LLM_PROVIDERS, SessionIndexPage, ULID_PATTERN } from "@localdot/protocol";
import { providerById } from "@localdot/providers";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AskForm } from "./agent/AskForm.tsx";
import { Composer } from "./agent/Composer.tsx";
import { KnowledgeView } from "./agent/KnowledgeView.tsx";
import { SafetyControls } from "./agent/SafetyControls.tsx";
import { StopControl } from "./agent/StopControl.tsx";
import { type PointerMode, TakeoverPanel } from "./agent/TakeoverPanel.tsx";
import { TaskRecovery } from "./agent/TaskRecovery.tsx";
import { useAgentSession } from "./agent/useAgentSession.ts";
import { useKnowledge } from "./agent/useKnowledge.ts";
import { useSafety } from "./agent/useSafety.ts";
import { useStopHotkey } from "./agent/useStopHotkey.ts";
import { useTaskControls } from "./agent/useTaskControls.ts";
import { hudFor } from "./cells/hud-state.ts";
import { useBrowserScreen } from "./cells/useBrowserScreen.ts";
import { useCell } from "./cells/useCell.ts";
import type { KeyFormPreset, KeyIntake } from "./keys/KeyForm.tsx";
import { KeysSheet } from "./keys/KeysSheet.tsx";
import { keyStatus, useKeys } from "./keys/useKeys.ts";
import { type ApiClient, ApiError, createApi } from "./lib/api.ts";
import { exchangeInstallCode, type InstallLink, takeInstallLink } from "./lib/install-link.ts";
import { forgetToken, keepToken, storedToken } from "./lib/token.ts";
import { useAppearance } from "./onboarding/appearance.ts";
import { WelcomeSetup } from "./onboarding/WelcomeSetup.tsx";
import { ReplayView } from "./replay/ReplayView.tsx";
import { timelineRows } from "./session/key-uses.ts";
import { stepRows } from "./session/session-view.ts";
import { statusFor, taskFacts, taskHud } from "./session/status.ts";
import { useLiveSession } from "./session/useLiveSession.ts";
import { useNowMs } from "./session/useNowMs.ts";
import { matchingKeys } from "./settings/choices.ts";
import { SettingsSheet } from "./settings/SettingsSheet.tsx";
import { needsPrice, pickerKeys } from "./settings/settings-form.ts";
import { useSettings } from "./settings/useSettings.ts";
import { ActivityRail } from "./shell/ActivityRail.tsx";
import { ConversationRail } from "./shell/ConversationRail.tsx";
import { Hud } from "./shell/Hud.tsx";
import { PaneTabs, type TheatrePane } from "./shell/PaneTabs.tsx";
import { StageColumn } from "./shell/StageColumn.tsx";
import { TopBar } from "./shell/TopBar.tsx";
import { Stage, type StageHandle } from "./stage/Stage.tsx";
import "./app.css";

export interface AppProps {
  fetchImpl?: typeof fetch;
}

type Rejected = "stored" | "link" | "code" | null;

const RETRY_CHECK_MS = 2000;
const FROM_WATCH = { fromWatch: true };

export function App({ fetchImpl }: AppProps) {
  const [token, setToken] = useState(() => storedToken());
  const [candidate, setCandidate] = useState<InstallLink | null>(null);
  const [rejected, setRejected] = useState<Rejected>(null);
  const tokenOwner = useRef(token);
  const linkOwner = useRef<InstallLink | null>(null);
  const exchange = useRef<{ code: string; promise: Promise<string> } | null>(null);

  // Opening the daemon's link in a tab that already shows this page changes only the fragment,
  // which the browser does not reload for.
  useEffect(() => {
    const onHashChange = () => {
      const given = takeInstallLink();
      if (given) {
        // Fence old replies synchronously, before React commits the new candidate.
        linkOwner.current = given;
        setCandidate(given);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    onHashChange();
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (!candidate) return;
    if (candidate.kind === "invalid") {
      setRejected("code");
      setCandidate(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => !cancelled && linkOwner.current === candidate;
    const accept = (accepted: string) => {
      if (!current()) return;
      keepToken(accepted);
      tokenOwner.current = accepted;
      setToken(accepted);
      setRejected(null);
      setCandidate(null);
    };
    if (candidate.kind === "code") {
      // StrictMode replays effects; both runs must observe the same one-use exchange.
      if (exchange.current?.code !== candidate.value) {
        exchange.current = {
          code: candidate.value,
          promise: exchangeInstallCode(candidate.value, fetchImpl),
        };
      }
      void exchange.current.promise
        .then(async (accepted) => {
          if (!current()) return;
          await createApi(accepted, { fetchImpl }).get("/api/whoami");
          accept(accepted);
        })
        .catch(() => {
          if (!current()) return;
          setRejected("code");
          setCandidate(null);
        });
      return () => {
        cancelled = true;
      };
    }
    const check = () => {
      createApi(candidate.value, { fetchImpl })
        .get("/api/whoami")
        .then(
          () => {
            accept(candidate.value);
          },
          (err: unknown) => {
            if (!current()) return;
            if (err instanceof ApiError && err.status === 401) {
              setRejected("link");
              setCandidate(null);
              return;
            }
            // No answer: the daemon may be restarting.
            timer = setTimeout(check, RETRY_CHECK_MS);
          },
        );
    };
    check();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [candidate, fetchImpl]);

  const api = useMemo<ApiClient | null>(
    () =>
      token
        ? createApi(token, {
            fetchImpl,
            // A 401 that arrives after a newer token took over leaves that token alone.
            onUnauthorized: () => {
              if (tokenOwner.current !== token) return;
              tokenOwner.current = null;
              forgetToken(token);
              setRejected("stored");
              setToken((current) => (current === token ? null : current));
            },
          })
        : null,
    [token, fetchImpl],
  );

  if (api) return <Theatre key={token} api={api} />;
  if (candidate) {
    return (
      <p className="notice" role="status">
        Checking the link…
      </p>
    );
  }
  return <NoToken rejected={rejected} />;
}

function Theatre({ api }: { api: ApiClient }) {
  const appearance = useAppearance();
  const [replayId, setReplayId] = useState<string | null>(() => {
    const selected = new URLSearchParams(window.location.search).get("replay");
    return selected && ULID_PATTERN.test(selected) ? selected : null;
  });
  const [newestReplayId, setNewestReplayId] = useState<string | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const historyOwner = useRef(0);
  const replayIdRef = useRef(replayId);
  replayIdRef.current = replayId;
  // Entering Replay from Watch adds one marked entry and leaving steps back over it, so browser
  // Back returns to Watch without stacking entries. A deletion only replaces the current entry.
  const selectReplay = (id: string | null, entry: "navigate" | "replace" = "navigate") => {
    const address = new URL(window.location.href);
    if (id) address.searchParams.set("replay", id);
    else address.searchParams.delete("replay");
    if (id !== replayIdRef.current) address.searchParams.delete("t");
    const leaving = id === null && replayIdRef.current !== null;
    if (entry === "navigate" && id !== null && replayIdRef.current === null)
      window.history.pushState(FROM_WATCH, "", address);
    else if (entry === "navigate" && leaving && window.history.state?.fromWatch)
      window.history.back();
    else window.history.replaceState(leaving ? null : window.history.state, "", address);
    setReplayId(id);
  };
  useEffect(() => {
    const restore = () => {
      const selected = new URLSearchParams(window.location.search).get("replay");
      setReplayId(selected && ULID_PATTERN.test(selected) ? selected : null);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  const {
    cell,
    status,
    pending,
    error,
    listed,
    reconnects,
    start,
    stop,
    resume,
    retry,
    selectReady,
  } = useCell(api);
  const keys = useKeys(api);
  const [keysOpen, setKeysOpen] = useState(false);
  const settings = useSettings(api, [], !keysOpen);
  const providerIndex = settings.index;
  const accountModels = settings.chatgpt.models;
  const modelName = useCallback(
    (provider: string, id: string) =>
      (provider === "chatgpt"
        ? accountModels
        : providerIndex?.providers.find((row) => row.id === provider)?.models
      )?.find((model) => model.id === id)?.name,
    [providerIndex, accountModels],
  );
  const mainChoice = settings.saved?.main;
  const mainProvider =
    mainChoice?.provider !== "chatgpt" && mainChoice
      ? providerById(mainChoice.provider)
      : undefined;
  const mainReady =
    settings.mainReady &&
    (mainChoice?.provider === "chatgpt"
      ? settings.chatgpt.canStart &&
        settings.chatgpt.models.some((model) => model.id === mainChoice.model)
      : !!mainProvider &&
        (mainProvider.local === true ||
          (keys.metadataReady === true &&
            keys.health?.online === true &&
            matchingKeys(mainProvider, keys.keys).some((key) => key.id === mainChoice?.key))));
  const keysButton = useRef<HTMLButtonElement>(null);
  const keysIntake = useRef<KeyIntake>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const settingsOrigin = useRef<HTMLElement | null>(null);
  const [settingsSection, setSettingsSection] = useState<"models" | "autonomy">("models");
  const keysOrigin = useRef<HTMLElement | null>(null);
  const [keyPreset, setKeyPreset] = useState<KeyFormPreset | undefined>();
  const keyRequest = useRef(0);
  const keyCapture = useRef<{
    request: number;
    capture: ReturnType<typeof settings.captureKey>;
  } | null>(null);
  const showSettings = (trigger: HTMLElement, section: "models" | "autonomy" = "models") => {
    settingsOrigin.current = trigger;
    setSettingsSection(section);
    settings.show();
  };
  const receiveKey = useCallback<KeyIntake["receive"]>((source, provider) => {
    keysOrigin.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    keyCapture.current = null;
    flushSync(() => {
      setKeyPreset(undefined);
      setKeysOpen(true);
    });
    return keysIntake.current?.receive(source, provider) ?? false;
  }, []);
  const wasOpen = useRef(false);
  const closeKeys = useCallback(() => setKeysOpen(false), []);
  useEffect(() => {
    // Restore only after the render has removed inert from the Theatre.
    if (wasOpen.current && !keysOpen) {
      if (keysOrigin.current?.isConnected && !keysOrigin.current.closest("[inert], [hidden]"))
        keysOrigin.current.focus();
      else if (!settings.open) keysButton.current?.focus();
    }
    wasOpen.current = keysOpen;
  }, [keysOpen, settings.open]);
  const wasSettingsOpen = useRef(false);
  useEffect(() => {
    if (wasSettingsOpen.current && !settings.open && !keysOpen) {
      if (
        settingsOrigin.current?.isConnected &&
        !settingsOrigin.current.closest("[inert], [hidden]")
      )
        settingsOrigin.current.focus();
      else settingsButton.current?.focus();
    }
    wasSettingsOpen.current = settings.open;
  }, [settings.open, keysOpen]);
  const hud = hudFor({ cell, status, pending });
  const stage = useRef<StageHandle>(null);
  const session = useLiveSession(api, cell, stage);
  useEffect(() => {
    if (session.sessionId && !session.ended) {
      setNewestReplayId(session.sessionId);
      return;
    }
    const controller = new AbortController();
    void api
      .get("/api/session-index?limit=1", { signal: controller.signal })
      .then((data) => {
        const page = SessionIndexPage.parse(data);
        if (!controller.signal.aborted && historyRevision === historyOwner.current)
          setNewestReplayId(page.sessions[0]?.id ?? null);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [api, session.sessionId, session.ended, historyRevision]);
  const agent = useAgentSession(api, cell, session);
  const selectedScreen = agent.model.screen ?? agent.snapshot?.screen;
  const browserScreen = useBrowserScreen(api, cell, selectedScreen);
  const physicalStageCell = selectedScreen?.screen === "browser" ? browserScreen.cell : cell;
  const manualGeometry = selectedScreen?.geometry ?? session.model.screen;
  const [pane, setPane] = useState<TheatrePane>("computer");
  const [narrow, setNarrow] = useState(
    () => window.matchMedia?.("(width < 1180px)").matches ?? false,
  );
  useEffect(() => {
    if (!window.matchMedia) return;
    const media = window.matchMedia("(width < 1180px)");
    const changed = () => setNarrow(media.matches);
    changed();
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  const controls = useTaskControls({
    api,
    cell,
    cellPending: pending,
    agent,
    feed: session.agentFeed,
    suspended: keysOpen || settings.open,
    manualVisible: !narrow || pane === "computer",
    refreshCell: retry,
  });
  const safety = useSafety({
    api,
    cell,
    agent,
    feed: session.agentFeed,
    blocked: controls.stopping || controls.fenced,
    replaceBlocked: controls.stopping,
    visible: !keysOpen && !settings.open,
    selectReady,
  });
  useStopHotkey(() => void controls.stop(), controls.canStop && !controls.stopping);
  const [pointerMode, setPointerMode] = useState<PointerMode>("click");
  const knowledge = useKnowledge(
    api,
    agent.sessionId,
    !!agent.sessionId && (!narrow || pane === "activity") && !keysOpen && !settings.open,
  );
  useEffect(() => {
    if (agent.model.pendingTakeover) setPointerMode("click");
  }, [agent.model.pendingTakeover]);
  const question =
    !controls.fenced &&
    !agent.model.ended &&
    agent.model.pendingAsk &&
    (!agent.fresh || agent.snapshot?.pendingAsk === agent.model.pendingAsk)
      ? agent.model.questions.get(agent.model.pendingAsk)
      : undefined;
  const takeover =
    !controls.fenced &&
    !agent.model.ended &&
    agent.model.pendingTakeover &&
    (!agent.fresh || agent.snapshot?.pendingTakeover === agent.model.pendingTakeover)
      ? agent.model.takeovers.get(agent.model.pendingTakeover)
      : undefined;
  const takeoverShown = useRef<string | null>(null);
  useEffect(() => {
    const requestId = takeover?.requestId;
    if (!requestId || requestId === takeoverShown.current) return;
    takeoverShown.current = requestId;
    if (narrow) setPane("computer");
  }, [takeover?.requestId, narrow]);
  const guardStart = () => {
    if (
      !controls.stopping &&
      !controls.busy &&
      controls.stopStatus.phase !== "unconfirmed" &&
      (controls.stopStatus.phase !== "stopped" || hud.action.kind === "start") &&
      !agent.model.pendingTakeover
    )
      start();
  };
  const guardResume = () => {
    if (
      !controls.stopping &&
      !controls.busy &&
      controls.stopStatus.phase !== "unconfirmed" &&
      cell?.state === "ready" &&
      cell.paused &&
      !agent.model.pendingTakeover
    )
      resume();
  };
  const guardComputerStop = () => {
    if (!controls.stopping && !controls.busy) stop();
  };
  const taskStop = () => {
    void controls.stop();
  };
  const stageCell =
    physicalStageCell && controls.stopStatus.phase === "paused"
      ? { ...physicalStageCell, paused: true as const }
      : physicalStageCell && controls.stopStatus.phase === "stopped"
        ? { ...physicalStageCell, state: "stopped" as const }
        : physicalStageCell;
  // The displayed screen owns video visibility. Parent lifecycle controls still
  // use the desktop HUD, even when only the separate browser has a live viewer.
  const stageHud = hudFor({ cell: stageCell, status, pending });
  const containedHud =
    controls.stopStatus.phase === "paused" || controls.stopStatus.phase === "stopped"
      ? hudFor({ cell: stageCell, status, pending })
      : hud;
  const facts = taskFacts(agent.model);
  const now = useNowMs(
    session.model,
    session.version,
    (t) => !!session.sessionId && taskHud(session.model, t, facts).phase === "running",
  );
  const task = session.sessionId ? taskHud(session.model, now, facts) : null;
  const computer = error ? { ...containedHud, caption: error } : containedHud;
  const appStatus = statusFor({
    computer: {
      ...computer,
      action: {
        ...computer.action,
        enabled:
          computer.action.enabled &&
          !controls.stopping &&
          !controls.busy &&
          controls.stopStatus.phase !== "unconfirmed" &&
          (computer.action.kind !== "resume" ||
            (cell?.state === "ready" && cell.paused === true && !agent.model.pendingTakeover)) &&
          (computer.action.kind !== "start" ||
            controls.stopStatus.phase !== "stopped" ||
            hud.action.kind === "start"),
      },
    },
    task:
      controls.stopStatus.phase === "paused" || controls.stopStatus.phase === "stopped"
        ? null
        : task,
    stop: controls.stopping
      ? "stopping"
      : controls.stopStatus.phase === "unconfirmed"
        ? "unconfirmed"
        : null,
    canStop: controls.canStop,
    mayControl:
      !controls.fenced &&
      agent.fresh &&
      !agent.model.pendingTakeover &&
      !agent.snapshot?.pendingTakeover,
  });
  const sheetStop = appStatus.actions.find(
    (action) => action.kind === "stop-task" || action.kind === "stop",
  );
  const sheetStopControl = sheetStop && {
    label: sheetStop.kind === "stop" ? "Stop computer" : sheetStop.busy ? "Stopping…" : "Stop",
    enabled: sheetStop.enabled,
    run: sheetStop.kind === "stop" ? guardComputerStop : taskStop,
  };
  const rows = session.sessionId
    ? timelineRows(stepRows(session.model), session.model.keyUses)
    : [];
  useEffect(() => {
    document.title = appStatus.title;
  }, [appStatus.title]);
  return (
    <div className={replayId ? "app replaying" : appStatus.control ? "app control" : "app"}>
      <div className="theatre-content" inert={keysOpen || settings.open}>
        <TopBar
          title={session.model.title ?? "Your computer"}
          live={stageHud.live}
          mode={replayId ? "replay" : "watch"}
          replayEnabled={!!(replayId || newestReplayId)}
          onMode={(mode) => selectReplay(mode === "watch" ? null : (replayId ?? newestReplayId))}
          keys={keyStatus(keys.health)}
          keysOpen={keysOpen}
          onKeys={() => {
            keysOrigin.current = keysButton.current;
            keyCapture.current = null;
            setKeyPreset(undefined);
            setKeysOpen(true);
          }}
          keysRef={keysButton}
          settings={{ open: settings.open, run: showSettings, ref: settingsButton }}
        />
        <div className="task-controls-area">
          <div className="task-bar" hidden={!!replayId}>
            <Hud
              status={appStatus}
              onStart={guardStart}
              onStop={guardComputerStop}
              onResume={guardResume}
              onStopSession={taskStop}
              onRetry={retry}
            />
            {task && !session.ended && (
              <span className="task-connection">
                {agent.error
                  ? "Activity unavailable"
                  : agent.connection === "lost"
                    ? "Connection lost"
                    : agent.connection === "connecting"
                      ? "Connecting…"
                      : task.phase === "finished"
                        ? "Ready for follow-up"
                        : task.row === "takeover"
                          ? "Your turn"
                          : task.phase === "waiting"
                            ? "Waiting for you"
                            : "Task activity"}
              </span>
            )}
          </div>
          <StopControl controls={controls} />
          <SafetyControls
            safety={safety}
            agent={agent}
            cell={cell}
            visible={!keysOpen && !settings.open}
            replaying={!!replayId}
          />
        </div>
        <div className="watch-content" hidden={!!replayId} inert={!!replayId}>
          <PaneTabs
            selected={pane}
            onSelect={setPane}
            attention={
              agent.model.pendingTakeover
                ? "computer"
                : agent.model.pendingAsk
                  ? "conversation"
                  : undefined
            }
          />
          <div className="house">
            <div
              className="pane pane-conversation"
              id="pane-conversation"
              role="tabpanel"
              aria-label="Conversation"
              data-selected={pane === "conversation"}
              inert={narrow && pane !== "conversation"}
              onFocusCapture={() => {
                if (!narrow) setPane("conversation");
              }}
            >
              <ConversationRail
                visible={!narrow || pane === "conversation"}
                agent={agent}
                composer={
                  <>
                    <TaskRecovery agent={agent} controls={controls} onSettings={showSettings} />
                    {question && !agent.model.ended && (
                      <AskForm
                        key={question.askId}
                        question={question}
                        controls={controls}
                        visible={
                          (!narrow || pane === "conversation") && !keysOpen && !settings.open
                        }
                        receiveKey={receiveKey}
                      />
                    )}
                    <Composer
                      api={api}
                      cell={cell}
                      known={status === "known"}
                      pending={pending !== null}
                      controlBlocked={
                        controls.fenced ||
                        controls.stopping ||
                        !!cell?.fenced ||
                        !!cell?.replacementPending ||
                        !!safety.approval
                      }
                      agent={agent}
                      keysOpen={keysOpen || settings.open}
                      receiveKey={receiveKey}
                      configured={mainReady}
                      onSettings={showSettings}
                      onTaskStarted={session.check}
                      modelSummary={
                        settings.saved?.main
                          ? `Saved main: ${providerById(settings.saved.main.provider)?.name ?? settings.saved.main.provider} · ${settings.saved.main.model}`
                          : "Choose a main model in Settings before starting a task."
                      }
                    />
                  </>
                }
              />
            </div>
            <div
              className={
                takeover && !agent.model.ended
                  ? "pane pane-computer manual-pane"
                  : "pane pane-computer"
              }
              id="pane-computer"
              role="tabpanel"
              aria-label="Computer"
              data-selected={pane === "computer"}
              inert={narrow && pane !== "computer"}
              onFocusCapture={() => {
                if (!narrow) setPane("computer");
              }}
            >
              <StageColumn
                after={
                  takeover && !agent.model.ended ? (
                    <TakeoverPanel
                      key={takeover.requestId}
                      takeover={takeover}
                      controls={{
                        ...controls,
                        canInput:
                          controls.canInput &&
                          physicalStageCell?.state === "ready" &&
                          !physicalStageCell.paused,
                      }}
                      visible={
                        !replayId && (!narrow || pane === "computer") && !keysOpen && !settings.open
                      }
                      manualStatus={agent.snapshot?.manualControl}
                      receiveKey={receiveKey}
                      screen={manualGeometry}
                      pointerMode={pointerMode}
                      onPointerMode={setPointerMode}
                    />
                  ) : undefined
                }
                live={stageHud.live}
                frozen={!!stageHud.paused}
                control={appStatus.control}
                caption={appStatus.caption.text}
              >
                {!replayId && status === "known" && !cell && listed.length === 0 && (
                  <WelcomeSetup
                    modelReady={mainReady}
                    loading={settings.phase === "loading" || !settings.saved}
                    modelLabel={
                      mainChoice
                        ? `${mainProvider?.name ?? mainChoice.provider} · ${mainChoice.model}`
                        : undefined
                    }
                    autonomy={settings.saved?.autonomy}
                    appearance={appearance}
                    starting={pending !== null}
                    canStart={appStatus.actions.some(
                      (action) => action.kind === "start" && action.enabled,
                    )}
                    onSettings={showSettings}
                    onStart={guardStart}
                  />
                )}
                {!replayId && selectedScreen && (
                  <div className="screen-label" role="status">
                    {selectedScreen.screen === "browser" ? "Signed-in browser" : "Desktop"}
                    {selectedScreen.screen === "browser" && !browserScreen.cell && (
                      <span> · {browserScreen.error ?? "Connecting…"}</span>
                    )}
                  </div>
                )}
                <Stage
                  ref={stage}
                  mode={replayId ? "replay" : "live"}
                  cell={stageCell}
                  parentId={cell?.id}
                  selection={selectedScreen}
                  api={api}
                  control={appStatus.control}
                  reconnects={reconnects + browserScreen.reconnects}
                  listed={listed}
                  manual={
                    takeover && manualGeometry && !agent.model.ended
                      ? {
                          requestId: takeover.requestId,
                          enabled:
                            controls.canInput && stageCell?.state === "ready" && !stageCell.paused,
                          screen: manualGeometry,
                          button: pointerMode === "right" ? "right" : "left",
                          count: pointerMode === "double" ? 2 : 1,
                          input: controls.input,
                        }
                      : undefined
                  }
                />
              </StageColumn>
            </div>
            <div
              className="pane pane-activity"
              id="pane-activity"
              role="tabpanel"
              aria-label="Activity"
              data-selected={pane === "activity"}
              inert={narrow && pane !== "activity"}
              onFocusCapture={() => {
                if (!narrow) setPane("activity");
              }}
            >
              <ActivityRail
                cellId={cell?.id}
                releaseReady={
                  cell?.state === "ready" &&
                  !cell.paused &&
                  !cell.fenced &&
                  !cell.replacementPending
                }
                models={agent.snapshot?.models}
                modelName={modelName}
                knowledge={<KnowledgeView knowledge={knowledge} />}
                memoryAction={(change) => {
                  const status =
                    controls.status?.kind === "memory" && controls.status.target === change.changeId
                      ? controls.status
                      : null;
                  return {
                    status:
                      change.changeId && controls.memoryUndone.has(change.changeId)
                        ? "undone"
                        : status?.phase === "sending" || status?.phase === "checking"
                          ? "pending"
                          : status?.phase === "uncertain"
                            ? "uncertain"
                            : status?.phase === "refused"
                              ? status.code === 409
                                ? "conflict"
                                : "failed"
                              : "ready",
                    onUndo: controls.canUndoMemory ? (id) => void controls.undo(id) : undefined,
                    onReread: () => {
                      controls.recheck();
                      knowledge.rereadMemory();
                    },
                  };
                }}
                agent={agent.model}
                rows={rows}
                keyUses={session.model.keyUses}
                sessionId={session.sessionId}
                scale={cell?.scale ?? 2}
                api={api}
              />
            </div>
          </div>
        </div>
        {replayId && (
          <ReplayView
            api={api}
            sessionId={replayId}
            onSelect={selectReplay}
            onGoLive={() => selectReplay(null)}
            onDeleted={(id) => {
              if (id === newestReplayId) setNewestReplayId(null);
              historyOwner.current++;
              setHistoryRevision(historyOwner.current);
              if (id === replayId) selectReplay(null, "replace");
            }}
            visible={!keysOpen && !settings.open && !safety.approval}
          />
        )}
      </div>
      <SettingsSheet
        focusSection={settingsSection}
        appearance={appearance}
        taskControls={<StopControl controls={controls} />}
        open={settings.open}
        suspended={keysOpen}
        choices={settings.draft?.choices ?? {}}
        chatgpt={settings.chatgpt}
        subscriptionModels={settings.subscriptionModels}
        providers={settings.index?.providers ?? []}
        keys={settings.index ? pickerKeys(settings.index) : []}
        keyLayer={settings.index?.keyLayer ?? "unknown"}
        catalog={
          settings.phase === "refreshing"
            ? "refreshing"
            : settings.phase === "loading"
              ? "loading"
              : settings.phase === "error"
                ? "offline"
                : !settings.index?.catalog
                  ? "empty"
                  : Date.now() - Date.parse(settings.index.catalog.fetchedAt) > 86_400_000
                    ? "stale"
                    : "ready"
        }
        dirty={settings.dirty}
        busy={settings.busy}
        loading={settings.phase === "loading" || !settings.draft}
        error={settings.error}
        validation={settings.validation}
        onClose={settings.close}
        onChange={settings.change}
        onKeys={(role, providerId, trigger) => {
          const provider = providerById(providerId);
          if (
            !provider ||
            provider.local ||
            provider.availableIn ||
            provider.notOffered ||
            !settings.open ||
            settings.busy ||
            !LLM_PROVIDERS.some((kind) => kind === provider.keyd)
          )
            return;
          const request = ++keyRequest.current;
          keyCapture.current = { request, capture: settings.captureKey(role, providerId) };
          keysOrigin.current = trigger;
          setKeyPreset({
            requestId: request,
            provider: provider.keyd as (typeof LLM_PROVIDERS)[number],
            ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
          });
          setKeysOpen(true);
        }}
        onRefresh={() => void settings.refresh()}
        onReload={settings.reload}
        save={{ enabled: settings.saveEnabled && settings.dirty, run: () => void settings.save() }}
        manualPrices={Object.fromEntries(
          (["main", "fast", "local"] as const)
            .filter(
              (role) =>
                needsPrice(settings.draft?.choices[role], settings.index) &&
                (role === "main" || settings.draft?.choices.main?.provider !== "chatgpt"),
            )
            .map((role) => [role, settings.draft?.prices[role] ?? { input: "", output: "" }]),
        )}
        onPrice={settings.changePrice}
        autonomy={settings.draft?.autonomy}
        onAutonomy={settings.changeAutonomy}
        budget={
          settings.draft
            ? {
                value: settings.draft.budget,
                useDefault: settings.draft.defaultBudget,
                defaultUSD: settings.index?.defaultTaskBudgetUSD ?? null,
                change: settings.budget,
              }
            : undefined
        }
        stop={sheetStopControl}
      />
      <KeysSheet
        taskControls={<StopControl controls={controls} />}
        intakeRef={keysIntake}
        open={keysOpen}
        keys={keys}
        onClose={closeKeys}
        preset={keyPreset}
        onSaved={(key, request) => {
          const context = keyCapture.current;
          if (context?.request === request) void settings.keySaved(context.capture, key);
        }}
        stop={sheetStopControl}
      />
    </div>
  );
}

const REJECTED: Record<Exclude<Rejected, null>, string> = {
  stored: "Your saved sign-in no longer works.",
  link: "This sign-in link was not accepted.",
  code: "This sign-in link could not be used.",
};

function NoToken({ rejected }: { rejected: Rejected }) {
  return (
    <section className="notice" role="alert">
      <h1>Sign in to localDot</h1>
      <p>
        {rejected ? `${REJECTED[rejected]} ` : ""}Run <code>localdot open</code> where localDot is
        installed, then open its sign-in link here as <code>{window.location.origin}/#code=…</code>{" "}
        within one minute. Each link works once.
      </p>
    </section>
  );
}
