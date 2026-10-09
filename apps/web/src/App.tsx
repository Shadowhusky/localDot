import {
  DEFAULT_AUTONOMY,
  isJevKey,
  LLM_PROVIDERS,
  type QuestionAnswerRequest,
  SessionIndexPage,
  ULID_PATTERN,
} from "@localdot/protocol";
import { providerById } from "@localdot/providers";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AskForm, type AskUpload } from "./agent/AskForm.tsx";
import { useAskDraft } from "./agent/ask-draft.ts";
import { composerReply } from "./agent/ask-form.ts";
import { Composer, type ReplyOutcome } from "./agent/Composer.tsx";
import { uploadFile } from "./agent/file-transfer.ts";
import { taskStalled } from "./agent/heartbeat.ts";
import { heldByUser } from "./agent/model.ts";
import { SafetyNotes } from "./agent/SafetyNotes.tsx";
import { TaskRecovery } from "./agent/TaskRecovery.tsx";
import { workSteps } from "./agent/thread.ts";
import { useAgentSession } from "./agent/useAgentSession.ts";
import { useControlToast } from "./agent/useControlToast.ts";
import { FINISH_FIRST, useConversation } from "./agent/useConversation.ts";
import { useHandBack } from "./agent/useHandBack.ts";
import { useKnowledge } from "./agent/useKnowledge.ts";
import { useManualChannel } from "./agent/useManualChannel.ts";
import { useSafety } from "./agent/useSafety.ts";
import { useStopHotkey } from "./agent/useStopHotkey.ts";
import { stopNotice, stoppedOff, useStopToast } from "./agent/useStopToast.ts";
import { useTaskControls } from "./agent/useTaskControls.ts";
import { deliverText } from "./agent/write-api.ts";
import { type HudActionKind, hudFor } from "./cells/hud-state.ts";
import { useBrowserScreen } from "./cells/useBrowserScreen.ts";
import { useCell } from "./cells/useCell.ts";
import { useComputerUpdate, useUpdateNotice } from "./cells/useComputerUpdate.ts";
import { useFreshStart } from "./cells/useFreshStart.ts";
import { presetOf } from "./copy/autonomy.ts";
import { decisionWords } from "./copy/decision.ts";
import { dotFeed } from "./dot/dot-feed.ts";
import { PresenceLayer } from "./dot/PresenceLayer.tsx";
import { presencePlace } from "./dot/presence-rules.ts";
import { useShowDot } from "./dot/show-dot.ts";
import { createExportJob } from "./export/job.ts";
import { JEV_KEY } from "./keys/binding.ts";
import type { KeyFormPreset, KeyIntake } from "./keys/KeyForm.tsx";
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
import { listenForSessionLinks } from "./notify/session-link.ts";
import { useAttention } from "./notify/useAttention.ts";
import { useAttentionToasts } from "./notify/useAttentionToasts.ts";
import { useOpenSession } from "./notify/useOpenSession.ts";
import { useAppearance } from "./onboarding/appearance.ts";
import { FinishSetup } from "./onboarding/FinishSetup.tsx";
import { Onboarding } from "./onboarding/Onboarding.tsx";
import { setupSteps } from "./onboarding/setup.ts";
import { useOnboarding } from "./onboarding/useOnboarding.ts";
import { STEP_DOT } from "./onboarding/wizard.ts";
import {
  PREVIEW_ROOM,
  RECORDED_TASK,
  type RecordedTitle,
  ReplayView,
} from "./replay/ReplayView.tsx";
import { type RoutinesControl, useProvideRoutines } from "./routines/context.ts";
import { RoutineSheet, type RoutineTarget } from "./routines/RoutineSheet.tsx";
import { RoutinesPanel } from "./routines/RoutinesPanel.tsx";
import { RowMenu } from "./routines/RowMenu.tsx";
import { useRoutines } from "./routines/useRoutines.ts";
import { timelineRows } from "./session/key-uses.ts";
import { stepRows } from "./session/session-view.ts";
import { footWork, type HudAction, statusFor, taskFacts, taskHud } from "./session/status.ts";
import { useLiveSession } from "./session/useLiveSession.ts";
import { useNowMs } from "./session/useNowMs.ts";
import { useSeenReporting } from "./session/useSeenReporting.ts";
import { matchingKeys } from "./settings/choices.ts";
import { subscription } from "./settings/chooser.ts";
import { useWhatDotKnows } from "./settings/memory/useWhatDotKnows.ts";
import { purposeJudge } from "./settings/PurposeCheck.tsx";
import { type SettingsSection, SettingsSheet } from "./settings/SettingsSheet.tsx";
import { needsPrice, pickerKeys } from "./settings/settings-form.ts";
import { useAccounts } from "./settings/useAccounts.ts";
import { useNotifications } from "./settings/useNotifications.ts";
import { useRules } from "./settings/useRules.ts";
import { useSettings } from "./settings/useSettings.ts";
import { ActivityRail } from "./shell/ActivityRail.tsx";
import { ChatThread, type NewConversation, NewConversationButton } from "./shell/ChatThread.tsx";
import { ControlStrip, ControlTools } from "./shell/ControlStrip.tsx";
import { Curtain } from "./shell/Curtain.tsx";
import { useCurtain } from "./shell/curtain.ts";
import { ApprovalDecision, DecisionSheet } from "./shell/DecisionIsland.tsx";
import { FocusControls } from "./shell/FocusControls.tsx";
import { useFocusMode, useStill } from "./shell/focus.ts";
import { useEdgeStill, useFullScreen, useFullScreenKeys } from "./shell/fullscreen.ts";
import { HudIsland, type StageFields } from "./shell/HudIsland.tsx";
import {
  islandAttention,
  islandDecision,
  islandShape,
  pauseSlot,
  takeReason,
  takeSlot,
} from "./shell/island.ts";
import { useKeyboardFit, useKeyboardUp, useLayout } from "./shell/layout.ts";
import { MoreMenu } from "./shell/MoreMenu.tsx";
import { NarratorBand } from "./shell/NarratorBand.tsx";
import { narrationLine } from "./shell/narration.ts";
import { RailPanel } from "./shell/RailPanel.tsx";
import { SignIn, type SignInState } from "./shell/SignIn.tsx";
import { StageFrame } from "./shell/StageFrame.tsx";
import { TopBar } from "./shell/TopBar.tsx";
import { useTabAttention } from "./shell/tab-attention.ts";
import { useStopAll } from "./shell/useStopAll.ts";
import type { StreamPicture } from "./stage/live-stream.ts";
import type { PointerMode } from "./stage/ManualSurface.tsx";
import { Stage, type StageHandle } from "./stage/Stage.tsx";
import { useStreamPreference } from "./stage/stream-preference.ts";
import type { FieldMark } from "./stage/worker-protocol.ts";
import { Announcer } from "./ui/Announcer.tsx";
import { Button } from "./ui/Button.tsx";
import { ErrorBoundary } from "./ui/ErrorBoundary.tsx";
import { useHeldFor } from "./ui/held.ts";
import { IconButton } from "./ui/IconButton.tsx";
import { isApple } from "./ui/Kbd.tsx";
import { MenuItem, MenuSeparator } from "./ui/Menu.tsx";
import { useMediaQuery } from "./ui/media.ts";
import { Presence } from "./ui/Presence.tsx";
import type { SegmentItem } from "./ui/SegmentedControl.tsx";
import { Sheet } from "./ui/Sheet.tsx";
import { showToast, Toaster } from "./ui/Toast.tsx";
import "./app.css";

export interface AppProps {
  fetchImpl?: typeof fetch;
}

type Rejected = "stored" | "link" | "code" | null;
// What the rail shows: the chat, or Activity or the routines laid over it.
type RailView = "chat" | "activity" | "routines";

const RETRY_CHECK_MS = 2000;
// The island waits at most this long on opening for the task's history.
const OPENING_MAX_MS = 2000;
// How long the task's feed may be out of touch before the island says it is reconnecting.
const LINK_LOST_MS = 1500;
const FROM_WATCH = { fromWatch: true };
const FROM_LIBRARY = { fromLibrary: true };
// Replay's address names the recording that plays, or this for the library of recordings.
const LIBRARY = "library";
const replayAddress = (selected: string | null) =>
  selected && (selected === LIBRARY || ULID_PATTERN.test(selected)) ? selected : null;
const ACTIVITY_DETENTS = ["medium", "large"] as const;
const PHONE_CONTROL_LINE = "Tap to click, drag to scroll. Hand back when you're done.";
const CONFIRMING_LINE = "Checking that your last input reached the computer…";
const SLOW_LINE = "This is taking longer than usual. Stop me if it looks stuck.";

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
  const streamChoice = useStreamPreference();
  const [replayId, setReplayId] = useState<string | null>(() =>
    replayAddress(new URLSearchParams(window.location.search).get("replay")),
  );
  const playing = replayId === LIBRARY ? null : replayId;
  const [newestReplayId, setNewestReplayId] = useState<string | null>(null);
  // The recordings couldn't be listed: Replay opens anyway and says so, with Try again.
  const [replayUnlisted, setReplayUnlisted] = useState(false);
  const [recorded, setRecorded] = useState<RecordedTitle | null>(null);
  const shownRecording = replayId && recorded?.sessionId === replayId ? recorded : null;
  // An export keeps going when Replay closes or moves to another task.
  const [exportJob] = useState(createExportJob);
  useEffect(() => () => exportJob.dispose(), [exportJob]);
  const [historyRevision, setHistoryRevision] = useState(0);
  const historyOwner = useRef(0);
  const replayIdRef = useRef(replayId);
  replayIdRef.current = replayId;
  // Entering Replay from Watch adds one marked entry, and so does opening a recording from the
  // library; leaving steps back over the entry it came by, so browser Back goes up one level without
  // stacking entries. A deletion only replaces the current entry.
  const selectReplay = (id: string | null, entry: "navigate" | "replace" = "navigate") => {
    const was = replayIdRef.current;
    const address = new URL(window.location.href);
    if (id) address.searchParams.set("replay", id);
    else address.searchParams.delete("replay");
    if (id !== was) address.searchParams.delete("t");
    const leaving = id === null && was !== null;
    const up = id === LIBRARY && was !== null && was !== LIBRARY;
    if (entry === "navigate" && id !== null && was === null)
      window.history.pushState(FROM_WATCH, "", address);
    else if (entry === "navigate" && id !== null && id !== LIBRARY && was === LIBRARY)
      window.history.pushState(FROM_LIBRARY, "", address);
    else if (entry === "navigate" && up && window.history.state?.fromLibrary) window.history.back();
    else if (entry === "navigate" && leaving && window.history.state?.fromWatch)
      window.history.back();
    else window.history.replaceState(leaving ? null : window.history.state, "", address);
    setReplayId(id);
  };
  // Back and Forward never reopen a recording deleted since the page opened: its entries show the
  // library instead.
  const deletedRecordings = useRef(new Set<string>());
  useEffect(() => {
    const restore = () => {
      const selected = replayAddress(new URLSearchParams(window.location.search).get("replay"));
      if (selected && deletedRecordings.current.has(selected)) {
        const address = new URL(window.location.href);
        address.searchParams.set("replay", LIBRARY);
        address.searchParams.delete("t");
        window.history.replaceState(window.history.state, "", address);
        setReplayId(LIBRARY);
        return;
      }
      setReplayId(selected);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  const {
    cell,
    status,
    pending,
    streamed,
    error,
    listed,
    reconnects,
    start,
    stop,
    resume,
    retry,
    selectReady,
  } = useCell(api);
  const computerUpdate = useComputerUpdate(api, cell);
  const freshStart = useFreshStart(api, cell, selectReady);
  const keys = useKeys(api);
  const settings = useSettings(api);
  const rules = useRules(api, settings.open);
  const providerIndex = settings.index;
  const accountModels = settings.chatgpt.models;
  const claudeModels = settings.claudeCode.models;
  const modelName = useCallback(
    (provider: string, id: string) =>
      (provider === "chatgpt"
        ? accountModels
        : provider === "claude-code"
          ? claudeModels
          : providerIndex?.providers.find((row) => row.id === provider)?.models
      )?.find((model) => model.id === id)?.name,
    [providerIndex, accountModels, claudeModels],
  );
  const mainChoice = settings.saved?.main;
  const mainApp =
    mainChoice?.provider === "chatgpt" || mainChoice?.provider === "claude-code"
      ? mainChoice.provider
      : undefined;
  const mainProvider = !mainApp && mainChoice ? providerById(mainChoice.provider) : undefined;
  const mainReady =
    settings.mainReady &&
    (mainChoice?.provider === "chatgpt"
      ? settings.chatgpt.canStart &&
        settings.chatgpt.models.some((model) => model.id === mainChoice.model)
      : mainChoice?.provider === "claude-code"
        ? settings.claudeCode.canStart
        : !!mainProvider &&
          (mainProvider.local === true ||
            (keys.metadataReady === true &&
              keys.health?.online === true &&
              matchingKeys(mainProvider, keys.keys).some((key) => key.id === mainChoice?.key))));
  const keysButton = useRef<HTMLButtonElement>(null);
  const keysIntake = useRef<KeyIntake>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const settingsOrigin = useRef<HTMLElement | null>(null);
  const settingsOpen = useRef(settings.open);
  settingsOpen.current = settings.open;
  // Where Settings goes, with a count, so a section asked for again is still gone to.
  const [settingsAt, setSettingsAt] = useState<{ section?: SettingsSection; request: number }>({
    request: 0,
  });
  const [keyPreset, setKeyPreset] = useState<KeyFormPreset | undefined>();
  const keyRequest = useRef(0);
  const keyCapture = useRef<{
    request: number;
    capture: ReturnType<typeof settings.captureKey>;
  } | null>(null);
  const { show: openSettings } = settings;
  const goToSettings = useCallback(
    (trigger: HTMLElement | null, section?: SettingsSection) => {
      if (!settingsOpen.current) settingsOrigin.current = trigger;
      setSettingsAt((now) => ({ section, request: now.request + 1 }));
      openSettings();
    },
    [openSettings],
  );
  const showSettings = (trigger: HTMLElement, section?: SettingsSection) =>
    goToSettings(trigger, section);
  const showKeys = (trigger: HTMLElement | null) => {
    keyCapture.current = null;
    setKeyPreset(undefined);
    goToSettings(trigger, "keys");
  };
  const receiveKey = useCallback<KeyIntake["receive"]>(
    (source, provider) => {
      keyCapture.current = null;
      flushSync(() => {
        setKeyPreset(undefined);
        goToSettings(
          document.activeElement instanceof HTMLElement ? document.activeElement : null,
          "keys",
        );
      });
      return keysIntake.current?.receive(source, provider) ?? false;
    },
    [goToSettings],
  );
  const wasSettingsOpen = useRef(false);
  useEffect(() => {
    if (wasSettingsOpen.current && !settings.open) {
      if (
        settingsOrigin.current?.isConnected &&
        !settingsOrigin.current.closest("[inert], [hidden]")
      )
        settingsOrigin.current.focus();
      else settingsButton.current?.focus();
    }
    wasSettingsOpen.current = settings.open;
  }, [settings.open]);
  const stage = useRef<StageHandle>(null);
  const [picture, setPicture] = useState<StreamPicture>("none");
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
        if (!controller.signal.aborted && historyRevision === historyOwner.current) {
          setNewestReplayId(page.sessions[0]?.id ?? null);
          setReplayUnlisted(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setReplayUnlisted(true);
      });
    return () => controller.abort();
  }, [api, session.sessionId, session.ended, historyRevision]);
  const agent = useAgentSession(api, cell, session);
  const selectedScreen = agent.model.screen ?? agent.snapshot?.screen;
  const browserScreen = useBrowserScreen(api, cell, selectedScreen);
  const physicalStageCell = selectedScreen?.screen === "browser" ? browserScreen.cell : cell;
  const hud = hudFor({
    cell,
    status,
    pending,
    picture: physicalStageCell === cell ? picture : "none",
    streamed,
  });
  const manualGeometry = selectedScreen?.geometry ?? session.model.screen;
  const layout = useLayout();
  const phone = layout === "phone";
  const [railView, setRailView] = useState<RailView>("chat");
  // A phone shows Activity in a sheet over the thread.
  const [activityOpen, setActivityOpen] = useState(false);
  if (activityOpen && !phone) setActivityOpen(false);
  // A phone shows the routines in a sheet too.
  const [routinesOpen, setRoutinesOpen] = useState(false);
  if (routinesOpen && !phone) setRoutinesOpen(false);
  const [routineTarget, setRoutineTarget] = useState<RoutineTarget | null>(null);
  const routines = useRoutines(
    api,
    railView === "routines" ||
      routinesOpen ||
      routineTarget !== null ||
      agent.model.routineProposals.size > 0
      ? "live"
      : settings.open
        ? "read"
        : "off",
  );
  const routineOrigin = useRef<HTMLElement | null>(null);
  const routinesControl = useMemo<RoutinesControl>(
    () => ({
      view: routines,
      open: (target, trigger) => {
        routineOrigin.current = trigger ?? null;
        setRoutineTarget(target);
      },
    }),
    [routines],
  );
  useProvideRoutines(routinesControl);
  const openRoutine = useCallback(
    (routine: { id: string }, trigger?: HTMLElement) =>
      routinesControl.open({ mode: "detail", id: routine.id }, trigger),
    [routinesControl],
  );
  const newRoutine = useCallback(
    (trigger?: HTMLElement) => routinesControl.open({ mode: "new" }, trigger),
    [routinesControl],
  );
  const stopAll = useStopAll(routines.api);
  const settingsStopAll = useMemo(
    () => ({ run: () => void stopAll.run(), running: stopAll.running }),
    [stopAll],
  );
  const loginState = routines.reply?.startAtLogin;
  const routinesAct = routines.act;
  const settingsLogin = useMemo(
    () => ({
      state: loginState,
      busy: routines.busy,
      set: (on: boolean) => void routinesAct((each) => each.setStartAtLogin(on)),
    }),
    [loginState, routines.busy, routinesAct],
  );
  // The top bar redraws only when what it shows changes, never with the task.
  const showRoutines = useRef(() => {});
  const barMore = useMemo(
    () =>
      !phone && (
        <RowMenu label="More" size={32}>
          <MenuItem icon="repeat" onSelect={() => showRoutines.current()}>
            Routines
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon="stop"
            disabledReason={stopAll.running ? "Stopping…" : undefined}
            onSelect={() => void stopAll.run()}
          >
            Stop everything
          </MenuItem>
        </RowMenu>
      ),
    [phone, stopAll.running, stopAll.run],
  );
  const island = useRef<HTMLDivElement>(null);
  const toastAnchor = useRef<HTMLDivElement>(null);
  const controls = useTaskControls({
    api,
    cell,
    cellPending: pending,
    agent,
    feed: session.agentFeed,
    suspended: settings.open,
    manualVisible: true,
    refreshCell: retry,
    lookLive: session.check,
  });
  const safety = useSafety({
    api,
    cell,
    agent,
    feed: session.agentFeed,
    blocked: controls.stopping || controls.fenced,
    replaceBlocked: controls.stopping,
    visible: !settings.open,
    selectReady,
  });
  useStopHotkey(() => void controls.stop(), controls.canStop && !controls.stopping);
  useControlToast(controls.status, controls.recheck);
  const [pointerMode, setPointerMode] = useState<PointerMode>("click");
  const [typing, setTyping] = useState(false);
  const [pasteRefused, setPasteRefused] = useState<string | null>(null);
  const settingsKnowledge = useKnowledge(api, null, settings.open);
  const whatDotKnows = useWhatDotKnows(api, settings.open);
  const settingsNotifications = useNotifications(api, settings.open);
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
  const yours = !!takeover && takeover === heldByUser(agent.model);
  const askDraft = useAskDraft(question);
  const answer = useRef(controls.answer);
  answer.current = controls.answer;
  const answerAsk = useCallback((request: QuestionAnswerRequest) => answer.current(request), []);
  const askCell = cell?.state === "ready" && !cell.paused ? cell.id : null;
  const uploadAsk = useMemo<AskUpload | undefined>(
    () => (askCell ? (file, signal) => uploadFile(api, askCell, file, signal) : undefined),
    [api, askCell],
  );
  const askReason = controls.canAnswer ? undefined : "Check the current task before answering.";
  // While dot waits on the answer, the stage keeps its ring on each field a secret goes into.
  const askMarks = useMemo<readonly FieldMark[] | undefined>(
    () =>
      askDraft?.question.fields?.flatMap(({ target }) =>
        target
          ? [
              {
                screen: target.screen,
                point: target.point,
                ...(target.bbox ? { bbox: target.bbox } : {}),
              },
            ]
          : [],
      ),
    [askDraft],
  );
  const shownScreen = selectedScreen?.screen ?? "desktop";
  const askFields = useMemo<StageFields | undefined>(() => {
    const marks = askMarks?.filter((mark) => mark.screen === shownScreen);
    return manualGeometry && marks?.length ? { screen: manualGeometry, marks } : undefined;
  }, [askMarks, shownScreen, manualGeometry]);
  const replyAsk = async (text: string, attached: boolean): Promise<ReplyOutcome> => {
    if (!askDraft) return "failed";
    const plan = composerReply(askDraft.question, text, attached);
    if (plan.kind === "hold") return { hold: plan.reason };
    if (!(await answerAsk(plan.request))) return "failed";
    return plan.kind === "answer" ? "answered" : "declined";
  };
  const manualLive =
    yours &&
    controls.canInput &&
    physicalStageCell?.state === "ready" &&
    !physicalStageCell.paused &&
    !(selectedScreen?.screen === "browser" && browserScreen.stale);
  const manual = useManualChannel(
    api,
    manualLive ? agent.sessionId : null,
    manualLive ? (takeover?.requestId ?? null) : null,
    agent.reconcile,
  );
  const { send: sendManual } = manual;
  // A right-click on a phone is for the next tap only.
  const sendToComputer = useCallback(
    (input: Parameters<typeof sendManual>[0]) => {
      sendManual(input);
      if (input.kind === "click" && input.button === "right") setPointerMode("click");
    },
    [sendManual],
  );
  useEffect(() => {
    if (pasteRefused) showToast({ title: pasteRefused, tone: "danger" });
  }, [pasteRefused]);
  const lastScreen = useRef(shownScreen);
  useEffect(() => {
    if (replayId || lastScreen.current === shownScreen) return;
    lastScreen.current = shownScreen;
    showToast({
      id: "screen",
      title:
        shownScreen === "browser" ? "dot moved to the web browser" : "dot is back on the desktop",
    });
  }, [replayId, shownScreen]);
  const browserProblem =
    !replayId && shownScreen === "browser" && !browserScreen.cell ? browserScreen.error : undefined;
  useEffect(() => {
    if (browserProblem) showToast({ id: "screen", title: browserProblem, tone: "danger" });
  }, [browserProblem]);
  const shownView: RailView =
    (railView === "activity" && layout === "wide") || phone ? "chat" : railView;
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
  // Carries on a task the user's action limit stopped: their message starts the count again.
  const continueTask = async () => {
    if (!cell || !agent.sessionId) return false;
    try {
      await deliverText(api, {
        cellId: cell.id,
        sessionId: agent.sessionId,
        mode: "followup",
        text: "Continue.",
      });
      return true;
    } catch {
      return false;
    }
  };
  // An interrupted task carries on as the conversation's next one.
  const carryOn = async () => {
    if (!cell) return false;
    try {
      await deliverText(api, {
        cellId: cell.id,
        sessionId: null,
        mode: "new",
        text: "Continue where you left off.",
      });
      session.check();
      return true;
    } catch {
      return false;
    }
  };
  const stageCell =
    physicalStageCell && controls.stopStatus.phase === "paused"
      ? { ...physicalStageCell, paused: true as const }
      : physicalStageCell && controls.stopStatus.phase === "stopped"
        ? { ...physicalStageCell, state: "stopped" as const }
        : physicalStageCell;
  // The displayed screen owns video visibility. Parent lifecycle controls still
  // use the desktop HUD, even when only the separate browser has a live viewer.
  const stageHud = hudFor({
    cell: stageCell,
    status,
    pending,
    picture,
    streamed: physicalStageCell === cell && streamed,
  });
  const containedHud =
    controls.stopStatus.phase === "paused" || controls.stopStatus.phase === "stopped"
      ? stageHud
      : hud;
  // Which conversation and task the thread shows is not known yet.
  const threadPending =
    status === "listing" ||
    !conversation.known ||
    (status === "known" && conversation.sessions.length > 0 && !session.sessionId);
  // On opening, what the task is doing is unknown until its history is in: the island waits rather
  // than say "Working" for a task that is done. Later tasks start from nothing, so never wait.
  const [opened, setOpened] = useState(false);
  const opening = !opened && (threadPending || (!!session.sessionId && agent.history === false));
  if (!opened && !opening && status !== "listing") setOpened(true);
  useEffect(() => {
    if (opened) return;
    const timer = setTimeout(() => setOpened(true), OPENING_MAX_MS);
    return () => clearTimeout(timer);
  }, [opened]);
  const facts = taskFacts(agent.model);
  // The user's own time on the computer, with no task: the island shows it only while they hold it.
  const ownHold =
    agent.snapshot?.holder === true ||
    (session.ended && agent.history === true && agent.model.messages.size === 0);
  const shownTask = !!session.sessionId && !opening && (!ownHold || !!facts.yours);
  const now = useNowMs(session.model, session.version, (t) => {
    if (!shownTask) return false;
    const hud = taskHud(session.model, t, facts);
    return hud.phase === "running" || hud.elapsedS !== null;
  });
  const task = shownTask ? taskHud(session.model, now, facts) : null;
  const foot = footWork(task);
  // The daemon refuses an Update in these cases too; the button says so before it is pressed.
  const updateWait =
    agent.snapshot?.holder === true || yours
      ? "Hand back the computer first"
      : task && task.phase !== "finished"
        ? "Wait for dot to finish"
        : undefined;
  useUpdateNotice(cell, hud.phase === "live" && !updateWait, computerUpdate);
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
  // A task feed out of touch for a moment says nothing; one that stays out says so in the island.
  const linkLost = useHeldFor(
    !!session.sessionId && (agent.connection === "lost" || agent.availability === "error"),
    LINK_LOST_MS,
  );
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
        : controls.stopStatus.phase === "paused"
          ? "stopped"
          : null,
    canStop: controls.canStop,
    link: linkLost ? "lost" : null,
    mayControl:
      !controls.fenced &&
      agent.fresh &&
      !agent.model.pendingTakeover &&
      !agent.snapshot?.pendingTakeover,
  });
  // The sheets offer Shut down, which the island leaves out; on a phone, where a sheet covers the
  // island, the task's Stop too.
  const sheetStop = appStatus.actions.find(
    (action) => action.kind === "stop" || (phone && action.kind === "stop-task"),
  );
  const stopped = stopNotice(controls.stopStatus);
  const stopNote = stopped ? { line: stopped.title, details: stopped.details } : undefined;
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
  const keysPanel = {
    keys,
    intakeRef: keysIntake,
    preset: keyPreset,
    uses,
    onSaved: (key: KeyRecord, request: number) => {
      const context = keyCapture.current;
      if (context?.request === request) void settings.keySaved(context.capture, key);
    },
  };
  const newConversation: NewConversation = {
    run: () => {
      void conversation.startNew();
      setRailView("chat");
    },
    reason: conversationReason,
  };
  const curtain = useCurtain(appStatus.computer, !!replayId);
  useStopToast(controls.stopStatus, controls.recheck, curtain.up);
  const stageBox = useRef<HTMLDivElement>(null);
  const fullScreen = useFullScreen({
    available: !curtain.up && !replayId,
    phone,
    frame: stageBox,
  });
  // A phone shows full screen as focus mode; a wider screen gives the stage the whole screen.
  const full = fullScreen.on && !phone;
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
  const setupKnown = !!settings.saved;
  const onboarding = useOnboarding({ known: setupKnown, configured: !!settings.saved?.main });
  const setupStep = onboarding.progress.step;
  const previewRoom = useMediaQuery(PREVIEW_ROOM) && !phone;
  const place = presencePlace({
    showDot: showDot.value,
    curtain: curtain.up,
    replaying: !!replayId,
    browsing: replayId === LIBRARY && !previewRoom,
    keyboard,
    setup: onboarding.open,
    full,
  });
  const chosenKey = mainApp
    ? (mainApp === "chatgpt" ? settings.chatgpt.canStart : settings.claudeCode.canStart)
      ? "Signed in"
      : null
    : mainProvider && mainChoice?.key && keys.keys.some((key) => key.id === mainChoice.key)
      ? mainChoice.key
      : null;
  const savedAutonomy = settings.saved?.autonomy;
  const setup = setupSteps({
    provider: mainApp ?? mainProvider ?? null,
    key: chosenKey,
    modelReady: mainReady,
    model: mainChoice
      ? `${mainProvider?.name ?? (mainApp === "claude-code" ? "Claude Code" : "ChatGPT")} · ${modelName(mainChoice.provider, mainChoice.model) ?? mainChoice.model}`
      : null,
    permissions: savedAutonomy ? (presetOf(savedAutonomy)?.label ?? "Your own choices") : null,
    computer: !!cell || listed.length > 0,
  });
  const keysState = useMemo(() => keyStatus(keys.health), [keys.health]);
  const wide = layout === "wide";
  const views: SegmentItem[] = [
    {
      value: "chat",
      label: "Chat",
      attention: shownView !== "chat" && !!agent.model.pendingAsk,
    },
    ...(wide || phone ? [] : [{ value: "activity", label: "Activity" }]),
    ...(phone ? [] : [{ value: "routines", label: "Routines" }]),
  ];
  showRoutines.current = () => {
    if (replayId) selectReplay(null);
    setRailView("routines");
  };
  const activity = (
    <ActivityRail
      cellId={cell?.id}
      releaseReady={
        cell?.state === "ready" && !cell.paused && !cell.fenced && !cell.replacementPending
      }
      models={agent.snapshot?.models}
      modelName={modelName}
      onSpending={(trigger) => showSettings(trigger, "spending")}
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
      nowMs={now}
    />
  );
  const shape = islandShape(appStatus, curtain.up || opening);
  const sheetsClosed = !settings.open;
  const decision = replayId
    ? null
    : islandDecision({
        shape,
        approval: !!safety.approval && sheetsClosed,
        question: !!question && !agent.model.ended && sheetsClosed,
        chatShown: shownView === "chat" || wide || phone,
      });
  const approval = safety.approval;
  const approvalView = approval && decision === "approval" && (
    <ApprovalDecision
      key={`${approval.approvalId}:${approval.generation}:${approval.revision}`}
      card={approval}
      enabled={safety.canApprove}
      pending={safety.pending === "approval"}
      onDecision={safety.answerApproval}
      loadField={safety.readApprovalField}
      layout={phone ? "sheet" : "island"}
    />
  );
  // One question, answered where you are: in the thread, in the island while you watch the
  // computer, or in a phone's sheet. Each is the same draft, so answering one answers all.
  const askIn =
    !askDraft || replayId || !sheetsClosed
      ? null
      : phone
        ? "sheet"
        : decision === "question"
          ? "island"
          : "thread";
  const askThread = useMemo(
    () =>
      askDraft && askIn === "thread" ? (
        <AskForm
          key={askDraft.question.askId}
          draft={askDraft}
          layout="thread"
          answer={answerAsk}
          reason={askReason}
          upload={uploadAsk}
          receiveKey={receiveKey}
        />
      ) : undefined,
    [askDraft, askIn, answerAsk, askReason, uploadAsk, receiveKey],
  );
  const openSession = useOpenSession({
    known: session.known,
    sessionId: agent.sessionId,
    decision:
      approvalView && approval
        ? `approval-${approval.approvalId}`
        : askDraft && askIn
          ? `ask-${askDraft.question.askId}`
          : null,
    select: selectReplay,
  });
  const attention = useAttention(api, openSession);
  useEffect(() => listenForSessionLinks(openSession), [openSession]);
  const viewing = replayId === LIBRARY ? null : (replayId ?? agent.sessionId ?? null);
  useSeenReporting(api, attention.items, viewing);
  useAttentionToasts(attention.latest, { viewing, island: !replayId }, openSession);
  useTabAttention(appStatus, { count: attention.items.length, top: attention.top });
  const askOver = (layout: "island" | "sheet") =>
    askDraft && (
      <AskForm
        key={askDraft.question.askId}
        draft={askDraft}
        layout={layout}
        answer={answerAsk}
        reason={askReason}
        upload={uploadAsk}
        receiveKey={receiveKey}
      />
    );
  const grown =
    phone || !decision
      ? undefined
      : decision === "approval"
        ? approvalView
        : askIn === "island"
          ? askOver("island")
          : undefined;
  // A task live on the computer gives the user its own control; with none, the user's own hold
  // starts.
  const liveTask = !!agent.sessionId && !session.ended && !ownHold;
  // Take control works whatever dot is doing: it does an approval's step instead of dot, takes the
  // computer dot handed over, or takes it from dot at work, at rest or paused.
  const take = () => {
    if (decision === "approval" && approval) {
      if (!safety.canApprove || safety.pending) return;
      void safety.answerApproval({
        approvalId: approval.approvalId,
        generation: approval.generation,
        revision: approval.revision,
        decision: "take_control",
      });
      return;
    }
    if (liveTask) void controls.take();
    else void controls.takeComputer();
  };
  const takeBlocked = takeReason({
    task: liveTask,
    ready: liveTask ? controls.canTake : controls.canTakeComputer,
    pause: safety.pause?.phase,
  });
  const takeState = takeSlot(appStatus, {
    decision,
    blocked: takeBlocked,
    taking: controls.taking,
  });
  const confirming = agent.snapshot?.manualControl === "unconfirmed";
  const handBack = useHandBack({ takeover, controls, drained: manual.drained });
  const inputBlocked = manualLive ? undefined : "Wait for the computer to be ready";
  const replacement = safety.replacement?.phase;
  // The curtain speaks while it is up; under it the band is quiet. On a phone, where the decision
  // is a sheet below, dot asks it aloud.
  const narration = curtain.up
    ? ""
    : phone && approvalView && approval
      ? decisionWords(approval).line
      : yours && confirming
        ? CONFIRMING_LINE
        : yours && phone
          ? PHONE_CONTROL_LINE
          : !replayId && taskStalled(agent, performance.now())
            ? SLOW_LINE
            : appStatus.caption.speaker === "dot" || appStatus.computer !== "live"
              ? narrationLine(
                  appStatus.row,
                  appStatus.caption.text,
                  // Out of touch, dot's last words are old news; the caption says what is going on.
                  linkLost || !session.sessionId ? null : session.model,
                  now,
                )
              : "";
  const speaker = (phone && approvalView) || yours ? "dot" : appStatus.caption.speaker;
  const asked = agent.model.pendingAsk
    ? agent.model.questions.get(agent.model.pendingAsk)?.question
    : undefined;
  const pause = pauseSlot({
    pause: safety.pause,
    canPause: safety.canPause,
    canResume: safety.canResume,
    handedOver: !!takeover,
    budgetHeld: agent.snapshot?.budgetHold === "task",
  });
  const { focus, leave: leaveFocus } = useFocusMode(
    !curtain.up && !replayId,
    !!question,
    fullScreen.on && phone,
  );
  const touchStill = useStill(focus);
  const edgeStill = useEdgeStill(full);
  const still = (touchStill || edgeStill) && !islandAttention(appStatus);
  useFullScreenKeys({
    enabled: !phone && !curtain.up && !replayId,
    apple: isApple(),
    full,
    yours,
    enter: fullScreen.enter,
    exit: fullScreen.exit,
  });
  const working = !!task && !yours;
  const stepCount = useMemo(
    () => (focus && working ? workSteps(rows, agent.model).length : 0),
    [focus, working, rows, agent.model],
  );
  const replayContinue = {
    current: conversation.sessions.at(-1) ?? null,
    reason: conversationReason,
    run: (id: string) =>
      void conversation.continueFrom(id).then((done) => {
        if (done) selectReplay(null);
      }),
  };
  const page = useRef<HTMLDivElement>(null);
  useKeyboardFit(page, keyboard);
  return (
    <div
      ref={page}
      className={appStatus.control && !replayId ? "app control" : "app"}
      data-layout={layout}
      data-replaying={replayId ? "" : undefined}
      data-focus={focus ? "" : undefined}
      data-full={full ? "" : undefined}
      data-still={still ? "" : undefined}
      data-keyboard={keyboard ? "" : undefined}
      data-setup={onboarding.open ? "" : undefined}
    >
      <TopBar
        title={
          replayId === LIBRARY
            ? "Replay"
            : replayId
              ? (shownRecording?.title ?? RECORDED_TASK)
              : (session.model.title ??
                ((curtain.up && !agent.sessionId && conversation.sessions.length === 0) ||
                // Until the shown task's history is in, its title is unknown, not new.
                threadPending ||
                (!!session.sessionId && agent.history !== true)
                  ? undefined
                  : "New conversation"))
        }
        note={
          shownRecording?.note ??
          (!replayId && agent.model.origin?.kind === "routine" ? "Routine" : undefined)
        }
        lead={
          shownRecording && (
            <Button
              variant="primary"
              size="sm"
              icon="continue"
              disabledReason={
                shownRecording.verdict !== "live" &&
                shownRecording.sessionId !== conversation.sessions.at(-1)
                  ? conversationReason
                  : undefined
              }
              onClick={() =>
                shownRecording.verdict === "live" ||
                shownRecording.sessionId === conversation.sessions.at(-1)
                  ? selectReplay(null)
                  : replayContinue.run(shownRecording.sessionId)
              }
            >
              Continue
            </Button>
          )
        }
        mode={replayId ? "replay" : "watch"}
        watchAttention={
          !!replayId &&
          (appStatus.attention === "needs_you" ||
            attention.items.some(
              (item) => item.level === "needs_you" && item.sessionId === agent.sessionId,
            ))
        }
        replayEnabled={!!(replayId || newestReplayId || replayUnlisted)}
        onMode={(mode) => selectReplay(mode === "watch" ? null : LIBRARY)}
        onModeAgain={() => {
          if (playing) selectReplay(LIBRARY);
        }}
        keys={keysState}
        keysOpen={settings.open && settingsAt.section === "keys"}
        onKeys={() => showKeys(keysButton.current)}
        keysRef={keysButton}
        settingsOpen={settings.open}
        onSettings={showSettings}
        settingsRef={settingsButton}
        more={barMore}
      />
      <div className="watch" hidden={!!replayId} inert={!!replayId}>
        <main className="stage-col" aria-label="Computer">
          <ErrorBoundary>
            <StageFrame
              boxRef={stageBox}
              onPictureDoubleClick={!phone && !yours ? fullScreen.enter : undefined}
              light={appStatus.control ? "dot" : yours ? "you" : "none"}
              live={stageHud.live || stageHud.phase === "reconnecting"}
              frozen={!!stageHud.paused}
              curtain={
                <Presence show={curtain.up}>
                  <Curtain
                    phase={curtain.phase}
                    first={!cell && listed.length === 0}
                    waking={pending === "start" || pending === "create"}
                    updating={!!cell?.updating}
                    caption={computer.caption}
                    notice={error ?? stoppedOff(controls.stopStatus)}
                    action={computerAction}
                    onAction={() => computerAction && onComputer[computerAction.kind]()}
                    replace={
                      cell?.fenced
                        ? {
                            enabled: safety.canReplace,
                            busy: safety.replacing,
                            note:
                              replacement === "blocked"
                                ? "The fresh computer couldn't be checked, so the old one stays off."
                                : replacement === "ready"
                                  ? "The fresh computer is ready. Opening it…"
                                  : replacement
                                    ? "Setting the old computer aside and starting a fresh one."
                                    : undefined,
                            run: () => void safety.replace(),
                          }
                        : undefined
                    }
                    freshStart={freshStart.curtain}
                    showDot={showDot.value}
                  />
                </Presence>
              }
              island={
                <>
                  <HudIsland
                    ref={island}
                    status={appStatus}
                    shape={shape}
                    badge={place === "badge"}
                    pause={pause}
                    take={takeState}
                    handBack={handBack.slot}
                    onPause={() => void safety.requestPause()}
                    onContinue={() => void safety.resume()}
                    onStopTask={taskStop}
                    onTake={take}
                    onHandBack={() => void handBack.run()}
                    onComputer={onComputer}
                    decision={grown}
                    full={full}
                    onExitFull={fullScreen.exit}
                    fields={askFields}
                    noticesRef={toastAnchor}
                    notices={<SafetyNotes safety={safety} agent={agent} visible={sheetsClosed} />}
                  />
                  <Toaster anchor={toastAnchor} />
                </>
              }
              band={
                <>
                  <NarratorBand
                    line={narration}
                    speaker={speaker}
                    reveal={!!asked && narration === asked}
                    showDot={showDot.value}
                    note={focus && stepCount ? `Step ${stepCount}` : undefined}
                  />
                  {yours && !phone && (
                    <ControlStrip
                      send={sendToComputer}
                      blocked={inputBlocked}
                      full={full}
                      onFullScreen={fullScreen.toggle}
                    />
                  )}
                </>
              }
              side={
                focus && (
                  <FocusControls
                    take={takeState}
                    pause={shape === "task" ? pause : null}
                    stop={appStatus.actions.find((action) => action.kind === "stop-task")}
                    onTake={take}
                    onPause={() => void safety.requestPause()}
                    onContinue={() => void safety.resume()}
                    onStop={taskStop}
                    onLeave={() => {
                      leaveFocus();
                      fullScreen.exit();
                    }}
                    tools={
                      yours ? (
                        <ControlTools
                          compact
                          send={sendToComputer}
                          blocked={inputBlocked}
                          typing={typing}
                          onKeyboard={(on) => stage.current?.keyboard(on)}
                          rightClick={pointerMode === "right"}
                          onRightClick={(on) => setPointerMode(on ? "right" : "click")}
                          handBack={handBack.slot}
                          onHandBack={() => void handBack.run()}
                        />
                      ) : undefined
                    }
                  />
                )
              }
            >
              <Stage
                ref={stage}
                mode={replayId ? "replay" : "live"}
                dim={decision !== null}
                fields={replayId ? undefined : askMarks}
                cell={stageCell}
                parentId={cell?.id}
                selection={selectedScreen}
                api={api}
                reconnects={reconnects + browserScreen.reconnects}
                listed={listed}
                onPicture={setPicture}
                manual={
                  yours && manualGeometry && !agent.model.ended
                    ? {
                        enabled: manualLive,
                        screen: manualGeometry,
                        pointer: pointerMode,
                        send: sendToComputer,
                        onTyping: setTyping,
                        onRefused: setPasteRefused,
                      }
                    : undefined
                }
              />
              {!phone && !yours && !full && stageHud.live && (
                <span className="stage-expand">
                  <IconButton
                    variant="glass"
                    round
                    size={32}
                    icon="expand"
                    label="Full screen"
                    kbd={["F"]}
                    onClick={fullScreen.enter}
                  />
                </span>
              )}
            </StageFrame>
          </ErrorBoundary>
        </main>
        {wide && (
          <RailPanel label="Activity" className="rail-activity">
            <ErrorBoundary>{activity}</ErrorBoundary>
          </RailPanel>
        )}
        <RailPanel
          label="Conversation"
          className="rail-chat"
          views={views}
          view={shownView}
          onView={(view) => setRailView(view as RailView)}
          end={!phone && agent.sessionId && <NewConversationButton {...newConversation} />}
        >
          <ErrorBoundary>
            <ChatThread
              visible={shownView === "chat"}
              agent={agent}
              api={api}
              rows={rows}
              computerReady={cell?.state === "ready" && !cell.paused}
              computerUpdating={!!cell?.updating}
              live={foot && !session.ended ? { ...foot, nowMs: now } : null}
              onReplay={
                agent.sessionId && (agent.model.ended || task?.phase === "finished")
                  ? () => selectReplay(agent.sessionId)
                  : undefined
              }
              onReplayTask={selectReplay}
              sessions={conversation.sessions}
              more={conversation.more}
              pending={threadPending}
              pinned={phone}
              lead={
                phone && (
                  <IconButton
                    className="toolbar-button"
                    size={44}
                    round
                    icon="list"
                    label="Activity"
                    onClick={() => setActivityOpen(true)}
                  />
                )
              }
              trail={
                phone && (
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
                        startsGroup: true,
                        disabledReason:
                          replayId || newestReplayId || replayUnlisted
                            ? undefined
                            : "No recordings yet",
                        run: () => selectReplay(LIBRARY),
                      },
                      {
                        label: "Routines",
                        icon: "repeat",
                        run: () => setRoutinesOpen(true),
                      },
                      {
                        label: "Settings",
                        icon: "settings",
                        run: (trigger) => showSettings(trigger),
                      },
                      { label: "Keys", icon: "key-round", run: (trigger) => showKeys(trigger) },
                      {
                        label: "Full screen",
                        icon: "expand",
                        disabledReason:
                          curtain.up || replayId ? "Turn on your computer first" : undefined,
                        run: () => fullScreen.enter(),
                      },
                      {
                        label: "Stop everything",
                        icon: "stop",
                        startsGroup: true,
                        disabledReason: stopAll.running ? "Stopping…" : undefined,
                        run: () => void stopAll.run(),
                      },
                    ]}
                  />
                )
              }
              start={
                setupKnown && !mainReady ? (
                  <FinishSetup
                    steps={setup.steps}
                    done={setup.done}
                    onChooseModel={(event) => showSettings(event.currentTarget, "models")}
                    onContinue={() => onboarding.reopen()}
                  />
                ) : undefined
              }
              covered={shownView !== "chat"}
              cover={
                !phone && (
                  <>
                    {!wide && (
                      <div
                        className="rail-cover-activity"
                        data-shown={shownView === "activity" || undefined}
                      >
                        {activity}
                      </div>
                    )}
                    <div
                      className="rail-cover-routines"
                      data-shown={shownView === "routines" || undefined}
                    >
                      <RoutinesPanel routines={routines} onOpen={openRoutine} onNew={newRoutine} />
                    </div>
                  </>
                )
              }
              tools={
                phone &&
                yours && (
                  <ControlTools
                    send={sendToComputer}
                    blocked={inputBlocked}
                    typing={typing}
                    onKeyboard={(on) => stage.current?.keyboard(on)}
                    rightClick={pointerMode === "right"}
                    onRightClick={(on) => setPointerMode(on ? "right" : "click")}
                    handBack={handBack.slot}
                    onHandBack={() => void handBack.run()}
                    onFullScreen={fullScreen.enter}
                  />
                )
              }
              recovery={
                <TaskRecovery
                  agent={agent}
                  controls={controls}
                  onSettings={showSettings}
                  onContinue={continueTask}
                  onCarryOn={cell?.state === "ready" && !cell.paused ? carryOn : undefined}
                />
              }
              ask={askThread}
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
                  keysOpen={settings.open}
                  receiveKey={receiveKey}
                  configured={mainReady}
                  onSettings={(trigger) => showSettings(trigger, "models")}
                  onTaskStarted={session.check}
                  layout={phone ? "pill" : "card"}
                  reply={askDraft ? replyAsk : undefined}
                />
              }
            />
          </ErrorBoundary>
        </RailPanel>
      </div>
      {replayId && (
        <ErrorBoundary className="replay-failed">
          <ReplayView
            api={api}
            sessionId={playing}
            onSelect={selectReplay}
            onLibrary={() => selectReplay(LIBRARY)}
            onGoLive={() => selectReplay(null)}
            onDeleted={(id) => {
              deletedRecordings.current.add(id);
              if (id === newestReplayId) setNewestReplayId(null);
              historyOwner.current++;
              setHistoryRevision(historyOwner.current);
              if (id === replayId) selectReplay(LIBRARY, "replace");
            }}
            onTitle={setRecorded}
            continueTask={replayContinue}
            exportJob={exportJob}
            visible={!settings.open && !safety.approval}
            showDot={showDot.value}
          />
        </ErrorBoundary>
      )}
      <ErrorBoundary floating>
        <SettingsSheet
          section={settingsAt.section}
          sectionRequest={settingsAt.request}
          appearance={appearance}
          showDot={showDot}
          stopNote={stopNote}
          stream={streamChoice}
          stop={sheetStopControl}
          stopAll={settingsStopAll}
          startAtLogin={settingsLogin}
          update={updateWait ? { ...computerUpdate, waitReason: updateWait } : computerUpdate}
          freshStart={freshStart.available ? { ...freshStart, waitReason: updateWait } : undefined}
          open={settings.open}
          keysPanel={keysPanel}
          choices={settings.draft?.choices ?? {}}
          chatgpt={settings.chatgpt}
          claudeCode={settings.claudeCode}
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
            setKeyPreset({
              requestId: request,
              provider: provider.keyd as (typeof LLM_PROVIDERS)[number],
              ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
            });
            goToSettings(trigger, "keys");
          }}
          onRefresh={() => void settings.refresh()}
          onReload={settings.reload}
          save={{
            enabled: settings.saveEnabled && settings.dirty,
            run: settings.save,
          }}
          manualPrices={Object.fromEntries(
            (["main", "fast", "local"] as const)
              .filter(
                (role) =>
                  needsPrice(settings.draft?.choices[role], settings.index) &&
                  (role === "main" ||
                    !["chatgpt", "claude-code"].includes(
                      settings.draft?.choices.main?.provider ?? "",
                    )),
              )
              .map((role) => [role, settings.draft?.prices[role] ?? { input: "", output: "" }]),
          )}
          onPrice={settings.changePrice}
          autonomy={settings.draft?.autonomy}
          savedAutonomy={settings.saved?.autonomy ?? DEFAULT_AUTONOMY}
          onAutonomy={settings.changeAutonomy}
          knowledge={settingsKnowledge}
          known={whatDotKnows}
          recentActivity={
            settings.draft
              ? { on: settings.draft.recentActivity, change: settings.recentActivity }
              : undefined
          }
          onOpenTask={(id) => {
            settings.close();
            selectReplay(id);
          }}
          notifications={settingsNotifications}
          accounts={settingsAccounts}
          rules={rules}
          spending={
            settings.draft
              ? { value: settings.draft.spending, change: settings.spending }
              : undefined
          }
          checkIns={
            settings.draft
              ? { value: settings.draft.checkIns, change: settings.checkIn }
              : undefined
          }
          purposeCheck={
            settings.draft
              ? {
                  on: settings.draft.purposeCheck,
                  change: settings.purposeCheck,
                  judge: purposeJudge(keys.keys.some(isJevKey), settings.draft.choices),
                  ...(subscription(settings.draft.choices.main?.provider)
                    ? { plan: settings.draft.choices.main?.provider }
                    : {}),
                  addJevKey: (trigger) => {
                    keyCapture.current = null;
                    setKeyPreset({ requestId: ++keyRequest.current, web: JEV_KEY });
                    goToSettings(trigger, "keys");
                  },
                }
              : undefined
          }
          spent={agent.model.spend}
          onSetup={() => {
            settings.close();
            onboarding.reopen("thinks");
          }}
        />
      </ErrorBoundary>
      {phone && (approvalView || askIn === "sheet") && (
        <ErrorBoundary floating>
          <DecisionSheet label={appStatus.label} elapsedS={appStatus.elapsedS}>
            {approvalView || askOver("sheet")}
          </DecisionSheet>
        </ErrorBoundary>
      )}
      {phone && (
        <Sheet
          open={routinesOpen}
          onClose={() => setRoutinesOpen(false)}
          title="Routines"
          doneLabel="Done"
          detents={ACTIVITY_DETENTS}
          className="routines-sheet"
        >
          <RoutinesPanel
            routines={routines}
            compact
            onOpen={(routine, trigger) => {
              setRoutinesOpen(false);
              openRoutine(routine, trigger);
            }}
            onNew={(trigger) => {
              setRoutinesOpen(false);
              newRoutine(trigger);
            }}
          />
        </Sheet>
      )}
      <ErrorBoundary floating>
        <RoutineSheet
          routines={routines}
          target={routineTarget}
          onClose={() => setRoutineTarget(null)}
          onWatch={(sessionId) => {
            setRoutineTarget(null);
            selectReplay(sessionId);
          }}
          onAnswer={() => {
            setRoutineTarget(null);
            if (replayId) selectReplay(null);
            setRailView("chat");
          }}
          returnFocus={routineOrigin}
        />
      </ErrorBoundary>
      {phone && (
        <Sheet
          open={activityOpen}
          onClose={() => setActivityOpen(false)}
          title="Activity"
          doneLabel="Done"
          detents={ACTIVITY_DETENTS}
        >
          <div className="activity-sheet">{activity}</div>
        </Sheet>
      )}
      <Presence show={onboarding.open}>
        <ErrorBoundary floating>
          <Onboarding
            api={api}
            control={onboarding}
            phone={phone}
            keys={keys}
            index={settings.index}
            saved={settings.saved}
            onSaved={settings.reload}
            turnOn={
              computerAction && computerAction.kind !== "stop"
                ? {
                    run: () => onComputer[computerAction.kind](),
                    reason: computerAction.enabled ? undefined : "Wait a moment",
                  }
                : null
            }
            showDot={showDot.value}
          />
        </ErrorBoundary>
      </Presence>
      {showDot.value && (
        <PresenceLayer
          place={place}
          provisional={curtain.up && curtain.phase === "checking"}
          feed={
            onboarding.open
              ? {
                  state: STEP_DOT[setupStep],
                  control: false,
                  attention: false,
                  focus: null,
                  dispatched: null,
                  done: false,
                  nod: setupStep,
                }
              : dotFeed(appStatus, session.sessionId ? session.model : null, now)
          }
          line={onboarding.open || speaker !== "dot" ? "" : narration}
        />
      )}
      <Announcer />
    </div>
  );
}
