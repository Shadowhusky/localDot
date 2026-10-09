import {
  DEFAULT_AUTONOMY,
  LLM_PROVIDERS,
  SessionIndexPage,
  ULID_PATTERN,
} from "@localdot/protocol";
import { providerById } from "@localdot/providers";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AskForm } from "./agent/AskForm.tsx";
import { Composer } from "./agent/Composer.tsx";
import { SafetyControls } from "./agent/SafetyControls.tsx";
import { StopControl } from "./agent/StopControl.tsx";
import { TakeoverPanel } from "./agent/TakeoverPanel.tsx";
import { TaskRecovery } from "./agent/TaskRecovery.tsx";
import { useAgentSession } from "./agent/useAgentSession.ts";
import { FINISH_FIRST, useConversation } from "./agent/useConversation.ts";
import { useKnowledge } from "./agent/useKnowledge.ts";
import { useManualChannel } from "./agent/useManualChannel.ts";
import { useSafety } from "./agent/useSafety.ts";
import { useStopHotkey } from "./agent/useStopHotkey.ts";
import { useTaskControls } from "./agent/useTaskControls.ts";
import { type HudActionKind, hudFor } from "./cells/hud-state.ts";
import { useBrowserScreen } from "./cells/useBrowserScreen.ts";
import { useCell } from "./cells/useCell.ts";
import { presetOf } from "./copy/autonomy.ts";
import { dotFeed } from "./dot/dot-feed.ts";
import { PresenceLayer } from "./dot/PresenceLayer.tsx";
import { presencePlace } from "./dot/presence-rules.ts";
import { useShowDot } from "./dot/show-dot.ts";
import { createExportJob } from "./export/job.ts";
import type { KeyFormPreset, KeyIntake } from "./keys/KeyForm.tsx";
import { KeysSheet } from "./keys/KeysSheet.tsx";
import type { KeyRecord } from "./keys/keys-api.ts";
import { keyStatus, useKeys } from "./keys/useKeys.ts";
import { type ApiClient, ApiError, createApi } from "./lib/api.ts";
import {
  exchangeInstallCode,
  type InstallLink,
  linkArrived,
  takeInstallLink,
} from "./lib/install-link.ts";
import { forgetToken, keepToken, storedToken } from "./lib/token.ts";
import { useAppearance } from "./onboarding/appearance.ts";
import { FinishSetup } from "./onboarding/FinishSetup.tsx";
import { setupSteps } from "./onboarding/setup.ts";
import { RECORDED_TASK, type RecordedTitle, ReplayView } from "./replay/ReplayView.tsx";
import { timelineRows } from "./session/key-uses.ts";
import { stepRows } from "./session/session-view.ts";
import { type HudAction, statusFor, taskFacts, taskHud } from "./session/status.ts";
import { useLiveSession } from "./session/useLiveSession.ts";
import { useNowMs } from "./session/useNowMs.ts";
import { matchingKeys } from "./settings/choices.ts";
import { type SettingsSection, SettingsSheet } from "./settings/SettingsSheet.tsx";
import { needsPrice, pickerKeys } from "./settings/settings-form.ts";
import { useAccounts } from "./settings/useAccounts.ts";
import { useRules } from "./settings/useRules.ts";
import { useSettings } from "./settings/useSettings.ts";
import { ActivityRail } from "./shell/ActivityRail.tsx";
import { ChatThread, type NewConversation, NewConversationButton } from "./shell/ChatThread.tsx";
import { Curtain } from "./shell/Curtain.tsx";
import { useCurtain } from "./shell/curtain.ts";
import { HudIsland } from "./shell/HudIsland.tsx";
import { islandShape, pauseSlot, takeSlot } from "./shell/island.ts";
import { useKeyboardUp, useLayout } from "./shell/layout.ts";
import { MoreMenu } from "./shell/MoreMenu.tsx";
import { NarratorBand } from "./shell/NarratorBand.tsx";
import { RailPanel } from "./shell/RailPanel.tsx";
import { SignIn, type SignInState } from "./shell/SignIn.tsx";
import { StageFrame } from "./shell/StageFrame.tsx";
import { TopBar } from "./shell/TopBar.tsx";
import type { PointerMode } from "./stage/ManualSurface.tsx";
import { Stage, type StageHandle } from "./stage/Stage.tsx";
import { Announcer } from "./ui/Announcer.tsx";
import { Presence } from "./ui/Presence.tsx";
import type { SegmentItem } from "./ui/SegmentedControl.tsx";
import "./app.css";

export interface AppProps {
  fetchImpl?: typeof fetch;
}

type Rejected = "stored" | "link" | "code" | null;
// What the rail shows: the chat, Activity laid over it, or the controls dot handed over.
type RailView = "chat" | "activity" | "takeover";

const RETRY_CHECK_MS = 2000;
const FROM_WATCH = { fromWatch: true };

export function App({ fetchImpl }: AppProps) {
  const [token, setToken] = useState(() => storedToken());
  const [candidate, setCandidate] = useState<InstallLink | null>(null);
  const [rejected, setRejected] = useState<Rejected>(null);
  // A link in the address is read in an effect, after the first paint; until then that paint is the
  // check it will start, not a sign-in prompt.
  const [arriving, setArriving] = useState(linkArrived);
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
    setArriving(false);
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
  if (candidate || arriving) return <SignIn state="checking" />;
  return <SignIn state={SIGN_IN[rejected ?? "none"]} />;
}

const SIGN_IN: Record<Exclude<Rejected, null> | "none", SignInState> = {
  none: "first",
  stored: "signed-out",
  link: "expired",
  code: "expired",
};

function Theatre({ api }: { api: ApiClient }) {
  const appearance = useAppearance();
  const showDot = useShowDot();
  const [replayId, setReplayId] = useState<string | null>(() => {
    const selected = new URLSearchParams(window.location.search).get("replay");
    return selected && ULID_PATTERN.test(selected) ? selected : null;
  });
  const [newestReplayId, setNewestReplayId] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<RecordedTitle | null>(null);
  const shownRecording = replayId && recorded?.sessionId === replayId ? recorded : null;
  // An export keeps going when Replay closes or moves to another task.
  const [exportJob] = useState(createExportJob);
  useEffect(() => () => exportJob.dispose(), [exportJob]);
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
  // Keys shows on its own sheet, or slid over Settings while Settings is open.
  const [keysIn, setKeysIn] = useState<"sheet" | "settings" | null>(null);
  const keysOpen = keysIn !== null;
  const settings = useSettings(api, [], !keysOpen);
  const settingsOpen = useRef(settings.open);
  settingsOpen.current = settings.open;
  const openKeys = useCallback(() => setKeysIn(settingsOpen.current ? "settings" : "sheet"), []);
  useEffect(() => {
    if (!settings.open) setKeysIn((now) => (now === "settings" ? null : now));
  }, [settings.open]);
  const rules = useRules(api, settings.open);
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
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("models");
  const keysOrigin = useRef<HTMLElement | null>(null);
  const [keyPreset, setKeyPreset] = useState<KeyFormPreset | undefined>();
  const keyRequest = useRef(0);
  const keyCapture = useRef<{
    request: number;
    capture: ReturnType<typeof settings.captureKey>;
  } | null>(null);
  const keysDiscard = useRef<((then: () => void) => void) | null>(null);
  const showSettings = (trigger: HTMLElement, section: SettingsSection = "models") => {
    const open = () => {
      settingsOrigin.current = trigger;
      setSettingsSection(section);
      if (keysIn === "sheet") {
        keysOrigin.current = null;
        setKeysIn(null);
      }
      settings.show();
    };
    // One sheet at a time: Keys on its own gives way to Settings, after asking if a key is typed.
    if (keysIn === "sheet" && keysDiscard.current) keysDiscard.current(open);
    else open();
  };
  const receiveKey = useCallback<KeyIntake["receive"]>(
    (source, provider) => {
      keysOrigin.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      keyCapture.current = null;
      flushSync(() => {
        setKeyPreset(undefined);
        openKeys();
      });
      return keysIntake.current?.receive(source, provider) ?? false;
    },
    [openKeys],
  );
  const wasOpen = useRef(false);
  const closeKeys = useCallback(() => setKeysIn(null), []);
  useEffect(() => {
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
  const conversation = useConversation(api);
  const session = useLiveSession(
    api,
    cell,
    stage,
    status === "known" && conversation.known ? (conversation.sessions.at(-1) ?? null) : undefined,
    conversation.choice,
  );
  const seen = useRef<string | null>(null);
  const { reload: rereadConversation } = conversation;
  useEffect(() => {
    const now = `${session.sessionId}:${session.ended}`;
    if (seen.current !== null && seen.current !== now) rereadConversation();
    seen.current = now;
  }, [session.sessionId, session.ended, rereadConversation]);
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
  const layout = useLayout();
  const [railView, setRailView] = useState<RailView>("chat");
  const controls = useTaskControls({
    api,
    cell,
    cellPending: pending,
    agent,
    feed: session.agentFeed,
    suspended: keysOpen || settings.open,
    manualVisible: true,
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
  const [typing, setTyping] = useState(false);
  const [pasteRefused, setPasteRefused] = useState<string | null>(null);
  const settingsKnowledge = useKnowledge(api, null, settings.open);
  const settingsAccounts = useAccounts(
    api,
    cell?.state === "ready" && !cell.paused ? cell.id : null,
    settings.open,
  );
  const { rereadMemory } = settingsKnowledge;
  // A memory change's "Read memory again" opens Settings on what dot knows, read afresh.
  const [readMemory, setReadMemory] = useState(false);
  useEffect(() => {
    if (!readMemory || !settings.open) return;
    setReadMemory(false);
    rereadMemory();
  }, [readMemory, settings.open, rereadMemory]);
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
  const manualLive =
    !!takeover &&
    controls.canInput &&
    physicalStageCell?.state === "ready" &&
    !physicalStageCell.paused;
  const manual = useManualChannel(
    api,
    manualLive ? agent.sessionId : null,
    manualLive ? (takeover?.requestId ?? null) : null,
    agent.reconcile,
  );
  // The rail opens on the hand-over's controls when dot hands the computer over; once it is handed
  // back, the rail goes back to the chat.
  const takeoverShown = useRef<string | null>(null);
  useEffect(() => {
    const requestId = takeover?.requestId;
    if (!requestId || requestId === takeoverShown.current) return;
    takeoverShown.current = requestId;
    setRailView("takeover");
  }, [takeover?.requestId]);
  const shownView: RailView =
    (railView === "takeover" && !takeover) || (railView === "activity" && layout === "wide")
      ? "chat"
      : railView;
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
  // A finished task waits only for a follow-up; one still at work keeps its conversation. Until
  // the daemon says which, the choice is offered and the daemon has the last word.
  const taskStatus = agent.snapshot?.status;
  const conversationReason =
    !session.ended && taskStatus && taskStatus !== "idle" && taskStatus !== "ended"
      ? FINISH_FIRST
      : conversation.busy
        ? "Just a moment…"
        : undefined;
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
  // The sheets offer Shut down, which the island leaves out; on a phone, where a sheet covers the
  // island, the task's Stop too.
  const sheetStop = appStatus.actions.find(
    (action) => action.kind === "stop" || (layout === "phone" && action.kind === "stop-task"),
  );
  const sheetStopControl = sheetStop && {
    label: sheetStop.kind === "stop" ? "Shut down" : sheetStop.busy ? "Stopping…" : "Stop",
    enabled: sheetStop.enabled,
    run: sheetStop.kind === "stop" ? guardComputerStop : taskStop,
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the model is folded in place, so its version is what changes
  const rows = useMemo(
    () => (session.sessionId ? timelineRows(stepRows(session.model), session.model.keyUses) : []),
    [session.sessionId, session.model, session.version],
  );
  const keyUses = session.model.keyUses;
  const uses = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const use of keyUses)
      if (use.decision === "allow") counts[use.secretId] = (counts[use.secretId] ?? 0) + 1;
    return counts;
  }, [keyUses]);
  // One panel, on its own sheet or slid over Settings when Settings is open.
  const keysPanel = {
    keys,
    intakeRef: keysIntake,
    preset: keyPreset,
    uses,
    onSaved: (key: KeyRecord, request: number) => {
      const context = keyCapture.current;
      if (context?.request === request) void settings.keySaved(context.capture, key);
    },
    stop: sheetStopControl,
    taskControls: <StopControl controls={controls} />,
  };
  useEffect(() => {
    document.title = appStatus.title;
  }, [appStatus.title]);
  const newConversation: NewConversation = {
    run: () => {
      void conversation.startNew();
      setRailView("chat");
    },
    reason: conversationReason,
  };
  const curtain = useCurtain(appStatus.computer, !!replayId);
  const computerAction = appStatus.actions.find(
    (action): action is HudAction & { kind: HudActionKind } => action.kind !== "stop-task",
  );
  const onComputer = {
    start: guardStart,
    stop: guardComputerStop,
    resume: guardResume,
    retry,
  };
  const keyboard = useKeyboardUp();
  const place = presencePlace({
    showDot: showDot.value,
    curtain: curtain.up,
    checking: curtain.up && curtain.phase === "checking",
    stageHidden: !!replayId,
    keyboard,
  });
  const setupKnown = !!settings.saved;
  const chosenKey =
    mainChoice?.provider === "chatgpt"
      ? settings.chatgpt.canStart
        ? "Signed in"
        : null
      : mainProvider && mainChoice?.key && keys.keys.some((key) => key.id === mainChoice.key)
        ? mainChoice.key
        : null;
  const savedAutonomy = settings.saved?.autonomy;
  const setup = setupSteps({
    provider: mainChoice?.provider === "chatgpt" ? "chatgpt" : (mainProvider ?? null),
    key: chosenKey,
    modelReady: mainReady,
    model: mainChoice
      ? `${mainProvider?.name ?? "ChatGPT"} · ${modelName(mainChoice.provider, mainChoice.model) ?? mainChoice.model}`
      : null,
    permissions:
      savedAutonomy && JSON.stringify(savedAutonomy) !== JSON.stringify(DEFAULT_AUTONOMY)
        ? (presetOf(savedAutonomy)?.label ?? "Your own choices")
        : null,
    computer: !!cell || listed.length > 0,
  });
  const keysState = useMemo(() => keyStatus(keys.health), [keys.health]);
  const showKeys = (trigger: HTMLElement | null) => {
    keysOrigin.current = trigger;
    keyCapture.current = null;
    setKeyPreset(undefined);
    openKeys();
  };
  const wide = layout === "wide";
  const views: SegmentItem[] = [
    {
      value: "chat",
      label: "Chat",
      attention: shownView !== "chat" && !!agent.model.pendingAsk,
    },
    ...(wide ? [] : [{ value: "activity", label: "Activity" }]),
    ...(takeover && !agent.model.ended
      ? [{ value: "takeover", label: "Your turn", attention: shownView !== "takeover" }]
      : []),
  ];
  const activity = (
    <ActivityRail
      cellId={cell?.id}
      releaseReady={
        cell?.state === "ready" && !cell.paused && !cell.fenced && !cell.replacementPending
      }
      models={agent.snapshot?.models}
      modelName={modelName}
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
          onReread: (trigger) => {
            controls.recheck();
            setReadMemory(true);
            showSettings(trigger, "knowledge");
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
  );
  const handover = takeover && !agent.model.ended && (
    <div
      className="takeover-scroll ui-scroll-area"
      data-shown={shownView === "takeover" || undefined}
    >
      <TakeoverPanel
        key={takeover.requestId}
        takeover={takeover}
        controls={{ ...controls, canInput: manualLive }}
        visible={!replayId && shownView === "takeover" && !keysOpen && !settings.open}
        manualStatus={agent.snapshot?.manualControl}
        receiveKey={receiveKey}
        screen={manualGeometry}
        pointerMode={pointerMode}
        onPointerMode={setPointerMode}
        send={manual.send}
        drained={manual.drained}
        typing={typing}
        onKeyboard={(on) => stage.current?.keyboard(on)}
        refused={pasteRefused}
      />
    </div>
  );
  // The curtain speaks while it is up; under it the band is quiet.
  const narration =
    !curtain.up && (appStatus.caption.speaker === "dot" || appStatus.computer !== "live")
      ? appStatus.caption.text
      : "";
  return (
    <div className="app" data-layout={layout} data-replaying={replayId ? "" : undefined}>
      <TopBar
        title={
          replayId
            ? (shownRecording?.title ?? RECORDED_TASK)
            : (session.model.title ??
              (curtain.up && !agent.sessionId && conversation.sessions.length === 0
                ? undefined
                : "New conversation"))
        }
        note={shownRecording?.note}
        mode={replayId ? "replay" : "watch"}
        replayEnabled={!!(replayId || newestReplayId)}
        onMode={(mode) => selectReplay(mode === "watch" ? null : (replayId ?? newestReplayId))}
        keys={keysState}
        keysOpen={keysOpen}
        onKeys={() => showKeys(keysButton.current)}
        keysRef={keysButton}
        settingsOpen={settings.open}
        onSettings={showSettings}
        settingsRef={settingsButton}
      />
      <div className="watch" hidden={!!replayId} inert={!!replayId}>
        <main className="stage-col" aria-label="Computer">
          <StageFrame
            light={appStatus.control ? "dot" : manualLive ? "you" : "none"}
            live={stageHud.live}
            frozen={!!stageHud.paused}
            curtain={
              <Presence show={curtain.up}>
                <Curtain
                  phase={curtain.phase}
                  first={!cell && listed.length === 0}
                  waking={pending === "start" || pending === "create"}
                  caption={computer.caption}
                  notice={error}
                  action={computerAction}
                  onAction={() => computerAction && onComputer[computerAction.kind]()}
                  showDot={showDot.value}
                />
              </Presence>
            }
            island={
              <HudIsland
                status={appStatus}
                shape={islandShape(appStatus, curtain.up)}
                badge={place === "badge"}
                pause={pauseSlot({
                  pause: safety.pause,
                  canPause: safety.canPause,
                  canResume: safety.canResume,
                  handedOver: !!takeover,
                  budgetHeld: agent.snapshot?.budgetHold === "task",
                })}
                take={takeSlot(appStatus)}
                onPause={() => void safety.requestPause()}
                onContinue={() => void safety.resume()}
                onStopTask={taskStop}
                onTake={() => setRailView("takeover")}
                onComputer={onComputer}
              />
            }
            notices={
              <>
                <StopControl controls={controls} />
                <SafetyControls
                  safety={safety}
                  agent={agent}
                  cell={cell}
                  visible={!keysOpen && !settings.open}
                  replaying={!!replayId}
                />
              </>
            }
            band={
              <NarratorBand
                line={narration}
                speaker={appStatus.caption.speaker}
                showDot={showDot.value}
              />
            }
          >
            {!replayId && selectedScreen && (
              <div className="screen-label" role="status">
                {selectedScreen.screen === "browser" ? "Web browser" : "Desktop"}
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
              reconnects={reconnects + browserScreen.reconnects}
              listed={listed}
              manual={
                takeover && manualGeometry && !agent.model.ended
                  ? {
                      enabled: manualLive,
                      screen: manualGeometry,
                      pointer: pointerMode,
                      send: manual.send,
                      onTyping: setTyping,
                      onRefused: setPasteRefused,
                    }
                  : undefined
              }
            />
          </StageFrame>
        </main>
        {wide && (
          <RailPanel label="Activity" className="rail-activity">
            {activity}
          </RailPanel>
        )}
        <RailPanel
          label="Conversation"
          className="rail-chat"
          views={views}
          view={shownView}
          onView={(view) => setRailView(view as RailView)}
          end={
            layout === "phone" ? (
              <MoreMenu
                items={[
                  ...(agent.sessionId
                    ? [
                        {
                          label: "New conversation",
                          icon: "compose" as const,
                          disabledReason: newConversation.reason,
                          run: newConversation.run,
                        },
                      ]
                    : []),
                  {
                    label: "Replay",
                    icon: "history",
                    disabledReason: replayId || newestReplayId ? undefined : "No recordings yet",
                    run: () => selectReplay(replayId ?? newestReplayId),
                  },
                  { label: "Settings", icon: "settings", run: (trigger) => showSettings(trigger) },
                  { label: "Keys", icon: "key-round", run: (trigger) => showKeys(trigger) },
                ]}
              />
            ) : (
              agent.sessionId && <NewConversationButton {...newConversation} />
            )
          }
        >
          <ChatThread
            visible={shownView === "chat"}
            agent={agent}
            api={api}
            rows={rows}
            computerReady={cell?.state === "ready" && !cell.paused}
            live={task && !session.ended ? { ...task, nowMs: now } : null}
            onReplay={
              agent.sessionId && (agent.model.ended || task?.phase === "finished")
                ? () => selectReplay(agent.sessionId)
                : undefined
            }
            onReplayTask={selectReplay}
            sessions={conversation.sessions}
            more={conversation.more}
            start={
              setupKnown && !mainReady ? (
                <FinishSetup
                  steps={setup.steps}
                  done={setup.done}
                  onChooseModel={(event) => showSettings(event.currentTarget)}
                  onContinue={(event) => showSettings(event.currentTarget)}
                />
              ) : undefined
            }
            covered={shownView !== "chat"}
            cover={
              <>
                {!wide && (
                  <div
                    className="rail-cover-activity"
                    data-shown={shownView === "activity" || undefined}
                  >
                    {activity}
                  </div>
                )}
                {handover}
              </>
            }
            recovery={<TaskRecovery agent={agent} controls={controls} onSettings={showSettings} />}
            answer={
              question && !agent.model.ended ? (
                <AskForm
                  key={question.askId}
                  question={question}
                  controls={controls}
                  visible={shownView === "chat" && !keysOpen && !settings.open}
                  receiveKey={receiveKey}
                />
              ) : undefined
            }
            composer={
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
              />
            }
          />
        </RailPanel>
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
          onTitle={setRecorded}
          continueTask={{
            current: conversation.sessions.at(-1) ?? null,
            reason: conversationReason,
            run: (id) =>
              void conversation.continueFrom(id).then((done) => {
                if (done) selectReplay(null);
              }),
          }}
          exportJob={exportJob}
          visible={!keysOpen && !settings.open && !safety.approval}
        />
      )}
      <SettingsSheet
        focusSection={settingsSection}
        appearance={appearance}
        showDot={showDot}
        taskControls={<StopControl controls={controls} />}
        stop={sheetStopControl}
        open={settings.open}
        keysPage={keysIn === "settings" ? { ...keysPanel, onBack: closeKeys } : undefined}
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
        catalogAt={settings.index?.catalog?.fetchedAt}
        dirty={settings.dirty}
        busy={settings.busy}
        loading={settings.phase === "loading" || !settings.draft}
        error={settings.error}
        validation={settings.validation}
        onClose={() => {
          settings.close();
          setKeysIn(null);
        }}
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
          setKeysIn("settings");
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
        savedAutonomy={settings.saved?.autonomy ?? DEFAULT_AUTONOMY}
        onAutonomy={settings.changeAutonomy}
        knowledge={settingsKnowledge}
        accounts={settingsAccounts}
        rules={rules}
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
      />
      <KeysSheet
        {...keysPanel}
        open={keysIn === "sheet"}
        onClose={closeKeys}
        discardRef={keysDiscard}
      />
      {showDot.value && (
        <PresenceLayer
          place={place}
          feed={dotFeed(appStatus, session.sessionId ? session.model : null, now)}
          line={appStatus.caption.speaker === "dot" ? narration : ""}
        />
      )}
      <Announcer />
    </div>
  );
}
