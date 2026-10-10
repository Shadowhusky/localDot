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
import { endTaskRun } from "./agent/control-api.ts";
import { uploadFile } from "./agent/file-transfer.ts";
import { taskStalled } from "./agent/heartbeat.ts";
import { ModelChip, ModelMenu } from "./agent/ModelChip.tsx";
import { markdownToPlain } from "./agent/markdown.ts";
import { heldByUser } from "./agent/model.ts";
import { PermissionChip } from "./agent/PermissionChip.tsx";
import { requestResearch, researchWait } from "./agent/research.ts";
import { SafetyNotes } from "./agent/SafetyNotes.tsx";
import { TaskRecovery } from "./agent/TaskRecovery.tsx";
import { workSteps } from "./agent/thread.ts";
import { useAgentSession } from "./agent/useAgentSession.ts";
import { useControlToast } from "./agent/useControlToast.ts";
import { FINISH_FIRST, useConversation } from "./agent/useConversation.ts";
import { useHandBack } from "./agent/useHandBack.ts";
import { useHandOff } from "./agent/useHandOff.ts";
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
import { restingBand, useIdleLine, usePageHidden } from "./dot/idle-line.ts";
import { PresenceLayer } from "./dot/PresenceLayer.tsx";
import { presencePlace } from "./dot/presence-rules.ts";
import { useShowDot } from "./dot/show-dot.ts";
import type { TipAction } from "./dot/tips.ts";
import { hasExported } from "./export/export-estimate.ts";
import { createHostExports } from "./export/host-exports.ts";
import { createExportJob } from "./export/job.ts";
import { useExportToast } from "./export/useExportToast.tsx";
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
import {
  footWork,
  type HudAction,
  statusFor,
  taskFacts,
  taskHud,
  withSending,
} from "./session/status.ts";
import { useLiveSession } from "./session/useLiveSession.ts";
import { useNowMs } from "./session/useNowMs.ts";
import { useSeenReporting } from "./session/useSeenReporting.ts";
import { matchingKeys } from "./settings/choices.ts";
import { subscription } from "./settings/chooser.ts";
import { useWhatDotKnows } from "./settings/memory/useWhatDotKnows.ts";
import { modelNames } from "./settings/model-names.ts";
import { currentOption, type ModelOption, modelGroups } from "./settings/model-options.ts";
import { purposeJudge } from "./settings/PurposeCheck.tsx";
import { type SettingsSection, SettingsSheet } from "./settings/SettingsSheet.tsx";
import { needsPrice, pickerKeys } from "./settings/settings-form.ts";
import { useAccounts } from "./settings/useAccounts.ts";
import { useAppUpdate } from "./settings/useAppUpdate.ts";
import { useConnectors } from "./settings/useConnectors.ts";
import { useDesktopSignIn } from "./settings/useDesktopSignIn.ts";
import { useNotifications } from "./settings/useNotifications.ts";
import { useRules } from "./settings/useRules.ts";
import { useSettings } from "./settings/useSettings.ts";
import { useSignIn } from "./settings/useSignIn.ts";
import { ActivityRail } from "./shell/ActivityRail.tsx";
import { ChatThread, type NewConversation, NewConversationButton } from "./shell/ChatThread.tsx";
import { ControlStrip, ControlTools } from "./shell/ControlStrip.tsx";
import { ConversationList, ConversationsButton } from "./shell/ConversationList.tsx";
import { Curtain } from "./shell/Curtain.tsx";
import { useCurtain } from "./shell/curtain.ts";
import { ApprovalDecision, DecisionSheetPresence } from "./shell/DecisionIsland.tsx";
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
import { atWork, narrationLine } from "./shell/narration.ts";
import { PanelMenu } from "./shell/PanelMenu.tsx";
import { type RailView, usePanelPreferences } from "./shell/panel-preferences.ts";
import { ACTIVITY_WIDTH, CHAT_WIDTH } from "./shell/panel-width.ts";
import { RailPanel } from "./shell/RailPanel.tsx";
import { ResizeHandle } from "./shell/ResizeHandle.tsx";
import { SignIn, type SignInState } from "./shell/SignIn.tsx";
import { StageFrame } from "./shell/StageFrame.tsx";
import { TopBar } from "./shell/TopBar.tsx";
import { useTabAttention } from "./shell/tab-attention.ts";
import { useStopAll } from "./shell/useStopAll.ts";
import { WorkOverlay } from "./shell/WorkOverlay.tsx";
import type { StreamPicture } from "./stage/live-stream.ts";
import type { PointerMode } from "./stage/ManualSurface.tsx";
import { Stage, type StageHandle } from "./stage/Stage.tsx";
import { useStreamPreference } from "./stage/stream-preference.ts";
import type { FieldMark } from "./stage/worker-protocol.ts";
import { Announcer, announce } from "./ui/Announcer.tsx";
import { Button } from "./ui/Button.tsx";
import { ErrorBoundary } from "./ui/ErrorBoundary.tsx";
import { useHeldFor } from "./ui/held.ts";
import { IconButton } from "./ui/IconButton.tsx";
import { isApple } from "./ui/Kbd.tsx";
import { MenuItem, MenuSeparator } from "./ui/Menu.tsx";
import { TOUCH, useMediaQuery } from "./ui/media.ts";
import { Presence } from "./ui/Presence.tsx";
import type { SegmentItem } from "./ui/SegmentedControl.tsx";
import { Sheet } from "./ui/Sheet.tsx";
import { showToast, Toaster } from "./ui/Toast.tsx";
import "./app.css";
import { speechLanguage } from "./voice/language.ts";
import { useListening } from "./voice/listening.ts";
import { useVoicePrefs } from "./voice/prefs.ts";
import { useReadAloud } from "./voice/read-aloud.ts";
import { useVoiceSupport, voiceRoute } from "./voice/support.ts";
import { browserLanguages } from "./voice/useVoice.ts";
import { LISTENING_LINE } from "./voice/words.ts";

export interface AppProps {
  fetchImpl?: typeof fetch;
}

type Rejected = "stored" | "link" | "code" | null;

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
const LIST_DETENTS = ["large"] as const;
// A chosen conversation that never comes on show once the daemon has taken the choice (another
// task holds the computer) stops waiting.
const SWITCH_MAX_MS = 3000;
const ALREADY_NEW = "This is a new conversation";
const NEW_TITLE = "New conversation";
const NO_SESSIONS: readonly string[] = [];
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

// How long a sent message shows dot thinking with no word from the task before the real status returns.
const SENDING_HOLD_MS = 20_000;

function Theatre({ api }: { api: ApiClient }) {
  const appearance = useAppearance();
  const showDot = useShowDot();
  const streamChoice = useStreamPreference();
  const [replayId, setReplayId] = useState<string | null>(() =>
    replayAddress(new URLSearchParams(window.location.search).get("replay")),
  );
  const playing = replayId === LIBRARY ? null : replayId;
  // undefined until the recordings are read: Replay is offered meanwhile rather than dimmed.
  const [newestReplayId, setNewestReplayId] = useState<string | null | undefined>(undefined);
  // The recordings couldn't be listed: Replay opens anyway and says so, with Try again.
  const [replayUnlisted, setReplayUnlisted] = useState(false);
  const hasRecordings = !!replayId || newestReplayId !== null || replayUnlisted;
  const [recorded, setRecorded] = useState<RecordedTitle | null>(null);
  const shownRecording = replayId && recorded?.sessionId === replayId ? recorded : null;
  // An export keeps going when Replay closes or moves to another task.
  // Made by the host when it can, so a video goes on when this page closes.
  const [hostExports] = useState(() => createHostExports(api));
  const [exportJob] = useState(() => createExportJob(hostExports));
  useEffect(
    () => () => {
      exportJob.dispose();
      hostExports.dispose();
    },
    [exportJob, hostExports],
  );
  useExportToast(exportJob);
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
    operation,
    start,
    stop,
    resume,
    retry,
    selectReady,
    selectRecovery,
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
  const names = useMemo(
    () => modelNames(providerIndex, { chatgpt: accountModels, claudeCode: claudeModels }),
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
  // Whether a task can start on the chosen model is unknown, not no, until settings, the account
  // and the key layer have answered, so nothing that depends on it shows and then goes. A read
  // again (Settings opening, the key layer restarting) keeps the last answer meanwhile.
  const mainKnown =
    !!settings.saved &&
    !!settings.index &&
    settings.phase === "ready" &&
    (!mainChoice ||
      (mainChoice.provider === "chatgpt"
        ? settings.chatgpt.summary !== null || !!settings.chatgpt.error
        : mainChoice.provider === "claude-code"
          ? settings.claudeCode.status !== null || !!settings.claudeCode.error
          : mainProvider?.local === true ||
            (keys.health?.online === true && keys.metadataReady === true)));
  const [setupSeen, setSetupSeen] = useState<boolean | undefined>(undefined);
  if (mainKnown && setupSeen !== mainReady) setSetupSeen(mainReady);
  const setupDone = mainKnown ? mainReady : setupSeen;
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
  const [keyReentry, setKeyReentry] = useState<{ requestId: number; id: string } | undefined>();
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
  const reenterKey = (trigger: HTMLElement, id: string) => {
    keyCapture.current = null;
    setKeyPreset(undefined);
    setKeyReentry({ requestId: ++keyRequest.current, id });
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
  // Browsing history never changes who owns the physical computer.
  const [viewedConversation, setViewedConversation] = useState<{
    id: string;
    sessions: readonly string[];
  } | null>(null);
  const historyStage = useRef<StageHandle | null>(null);
  const historySession = useLiveSession(api, null, historyStage, viewedConversation?.id ?? null);
  const historyAgent = useAgentSession(api, null, historySession);
  // Talking to dot: its listening pose and line, Settings → Voice, and replies read aloud.
  const hearing = useListening();
  const voicePrefs = useVoicePrefs();
  const voiceBrowser = browserLanguages();
  const voiceLanguage = speechLanguage(voicePrefs.value.language, voiceBrowser);
  const voiceSupport = useVoiceSupport(api, voiceLanguage);
  useReadAloud({
    on: voicePrefs.value.readAloud,
    sessionId: agent.sessionId,
    history: !!agent.history,
    messages: agent.model.messages,
    language: voiceLanguage,
  });
  // The conversation the user just chose: its thread clears at once and stays clear until the
  // chosen conversation is the one on show, so the one left behind never draws again.
  const [switching, setSwitching] = useState<{ to: string | null } | null>(null);
  const [reveal, setReveal] = useState(0);
  if (
    switching &&
    !conversation.busy &&
    (conversation.sessions.at(-1) ?? null) === switching.to &&
    (session.sessionId ?? null) === switching.to
  )
    setSwitching(null);
  const choosing = conversation.busy;
  useEffect(() => {
    if (!switching || choosing) return;
    const timer = setTimeout(() => setSwitching(null), SWITCH_MAX_MS);
    return () => clearTimeout(timer);
  }, [switching, choosing]);
  const choices = useRef(0);
  const { startNew, continueFrom } = conversation;
  const choose = useCallback(
    async (to: string | null) => {
      setViewedConversation(null);
      const request = ++choices.current;
      setSwitching({ to });
      setReveal((value) => value + 1);
      const done = await (to ? continueFrom(to) : startNew());
      if (!done && request === choices.current) {
        setSwitching(null);
        setReveal((value) => value + 1);
      }
      return done;
    },
    [startNew, continueFrom],
  );
  // Restored conversation history can refer to a retired desktop or browser. Only a live
  // task selects the current computer's screen; history must never prevent its stream opening.
  const selectedScreen =
    session.resting || agent.model.ended || agent.interrupted
      ? undefined
      : (agent.model.screen ?? agent.snapshot?.screen);
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
  const panelsButton = useRef<HTMLButtonElement>(null);
  const { panels, update: updatePanels } = usePanelPreferences();
  const railView = panels.view;
  const setRailView = (view: RailView) => updatePanels({ view, chat: true });
  const activityVisible = layout === "wide" && panels.activity;
  const chatVisible = phone || panels.chat;
  // A phone shows Activity in a sheet over the thread.
  const [activityOpen, setActivityOpen] = useState(false);
  if (activityOpen && !phone) setActivityOpen(false);
  // A phone shows the routines in a sheet too.
  const [routinesOpen, setRoutinesOpen] = useState(false);
  if (routinesOpen && !phone) setRoutinesOpen(false);
  const [routineTarget, setRoutineTarget] = useState<RoutineTarget | null>(null);
  // Read once dot first rests, so its tips know whether there are routines and Open at login.
  const [tipsRead, setTipsRead] = useState(false);
  const routines = useRoutines(
    api,
    railView === "routines" ||
      routinesOpen ||
      routineTarget !== null ||
      agent.model.routineProposals.size > 0
      ? "live"
      : settings.open || tipsRead
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
    selectRecovery,
  });
  useControlToast(controls.status, controls.recheck);
  const [pointerMode, setPointerMode] = useState<PointerMode>("click");
  const [typing, setTyping] = useState(false);
  const [pasteRefused, setPasteRefused] = useState<string | null>(null);
  const settingsKnowledge = useKnowledge(api, null, settings.open);
  const whatDotKnows = useWhatDotKnows(api, settings.open);
  const settingsNotifications = useNotifications(api, settings.open);
  const settingsConnectors = useConnectors(api, settings.open);
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
  useHandOff({
    sessionId: agent.sessionId,
    fresh: agent.fresh,
    offered: yours ? undefined : takeover,
    shown: !replayId && !settings.open,
    canTake: controls.canTake,
    take: controls.take,
  });
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
  const [stoppingRun, setStoppingRun] = useState<string | null>(null);
  const stoppingRunRef = useRef<string | null>(null);
  const taskStop = () => {
    const id = agent.sessionId;
    if (!id || stoppingRunRef.current) return;
    stoppingRunRef.current = id;
    setStoppingRun(id);
    void endTaskRun(api, id, new AbortController().signal)
      .catch(() => {
        showToast({
          title: "Couldn't confirm Stop. Check the task and try again.",
          tone: "danger",
        });
      })
      .finally(() => {
        stoppingRunRef.current = null;
        setStoppingRun(null);
        agent.reconcile();
        session.check();
      });
  };
  useStopHotkey(taskStop, controls.canStop && !controls.stopping && !stoppingRun);
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
  // On opening, the page waits on everything it shows that could still change its mind: the
  // computer, setup, the conversation and its task's history. Meanwhile only dot wakes on the
  // curtain; then everything comes in at once (the curtain lifts, the rail slides in, dot flies to
  // its dock and the island fades in). Later tasks start from nothing, so never wait.
  const [opened, setOpened] = useState(false);
  const opening =
    !opened &&
    (status === "listing" ||
      setupDone === undefined ||
      threadPending ||
      (!!session.sessionId && agent.history === false));
  if (!opened && !opening) setOpened(true);
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
  // Sign-ins go to the web browser, where they are kept: from Settings, or from the desktop's own
  // browser while the user holds the computer with no task.
  const signIn = useSignIn(api, askCell, () => {
    if (settings.open) settings.close();
    session.check();
  });
  useDesktopSignIn({
    api,
    cellId: askCell,
    watching: manualLive && shownScreen === "desktop" && !settings.open && !replayId,
    offer: ownHold ? (site, failed) => void signIn.start(site, failed) : undefined,
  });
  const shownTask = !!session.sessionId && !opening && (!ownHold || !!facts.yours);
  const now = useNowMs(
    session.model,
    session.version,
    (t) => {
      if (!shownTask) return false;
      const hud = taskHud(session.model, t, facts);
      return hud.phase === "running" || hud.elapsedS !== null;
    },
    session.clock,
  );
  const task = shownTask ? taskHud(session.model, now, facts) : null;
  const foot = footWork(task);
  // The daemon refuses an Update in these cases too; the button says so before it is pressed.
  const updateWait =
    agent.snapshot?.holder === true || yours
      ? "Hand back the computer first"
      : task && task.phase !== "finished"
        ? "Wait for dot to finish"
        : undefined;
  const appUpdate = useAppUpdate(api, hud.phase === "live" && !updateWait, () => {
    settings.show();
    setSettingsAt((previous) => ({ section: "computer", request: previous.request + 1 }));
  });
  useUpdateNotice(cell, hud.phase === "live" && !updateWait, computerUpdate);
  // A finished task waits only for a follow-up; one still at work keeps its conversation. Until
  // the daemon says which, the choice is offered and the daemon has the last word.
  const taskStatus = agent.snapshot?.status;
  const recoveryWait =
    taskStatus === "paused" &&
    !agent.snapshot?.pause &&
    !agent.model.pendingAsk &&
    !agent.model.pendingTakeover &&
    !agent.snapshot?.approval;
  const conversationReason = stoppingRun
    ? "Stopping the current task…"
    : !session.ended &&
        taskStatus &&
        taskStatus !== "idle" &&
        taskStatus !== "ended" &&
        !recoveryWait
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
  const baseStatus = statusFor({
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
    stop:
      controls.stopping || stoppingRun
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
  // From the moment a message is sent until the task's first word, dot is shown thinking.
  const [sendingSince, setSendingSince] = useState<number | null>(null);
  const sendingAnswered = baseStatus.row !== "ready" && baseStatus.row !== "done";
  useEffect(() => {
    if (sendingSince === null) return;
    if (sendingAnswered) {
      setSendingSince(null);
      return;
    }
    const timer = setTimeout(() => setSendingSince(null), SENDING_HOLD_MS);
    return () => clearTimeout(timer);
  }, [sendingSince, sendingAnswered]);
  const appStatus = withSending(baseStatus, sendingSince !== null);
  // The sheets offer Shut down, which the island leaves out; on a phone, where a sheet covers the
  // island, the task's Stop too.
  const sheetStop = appStatus.actions.find(
    (action) => action.kind === "stop" || (phone && action.kind === "stop-task"),
  );
  const stopped = stopNotice(controls.stopStatus);
  const stopNote = stopped ? { line: stopped.title, details: stopped.details } : undefined;
  const sheetStopControl = sheetStop && {
    label: sheetStop.kind === "stop" ? "Shut down" : sheetStop.busy ? "Stopping…" : "Stop",
    task: sheetStop.kind === "stop-task",
    enabled: sheetStop.enabled,
    run: sheetStop.kind === "stop" ? guardComputerStop : taskStop,
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the model is folded in place, so its version is what changes
  const rows = useMemo(
    () => (session.sessionId ? timelineRows(stepRows(session.model), session.model.keyUses) : []),
    [session.sessionId, session.model, session.version],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: history is folded in place too
  const historyRows = useMemo(
    () => timelineRows(stepRows(historySession.model), historySession.model.keyUses),
    [historySession.model, historySession.version],
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
    reenter: keyReentry,
    uses,
    onSaved: (key: KeyRecord, request: number) => {
      const context = keyCapture.current;
      if (context?.request === request) void settings.keySaved(context.capture, key);
    },
  };
  const fresh =
    conversation.known && !conversation.sessions.length && !session.sessionId && !switching;
  const newConversation: NewConversation = {
    run: () => {
      void choose(null);
      setRailView("chat");
    },
    reason: conversationReason ?? (fresh ? ALREADY_NEW : undefined),
  };
  const curtain = useCurtain(opening ? "checking" : appStatus.computer, !!replayId);
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
  const onboarding = useOnboarding({
    known: setupKnown,
    configured: !!settings.saved?.main,
    replaying: !!replayId,
  });
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
  const chatgptReady = settings.chatgpt.canStart;
  const claudeReady = settings.claudeCode.canStart;
  const modelChoices = useMemo(
    () =>
      modelGroups(
        settings.saved,
        providerIndex,
        {
          chatgpt: { ready: chatgptReady, models: accountModels },
          claudeCode: { ready: claudeReady, models: claudeModels },
        },
        names,
      ),
    [settings.saved, providerIndex, chatgptReady, accountModels, claudeReady, claudeModels, names],
  );
  // The model being saved, which the chip shows meanwhile.
  const [modelSaving, setModelSaving] = useState<ModelOption | null>(null);
  const [phoneModels, setPhoneModels] = useState(false);
  const phoneModelsAnchor = useRef<HTMLElement | null>(null);
  const taskModels = agent.snapshot?.models;
  // The task runs on another model than the one saved now: the next task takes the saved one.
  const modelChanged =
    !!mainChoice &&
    !!taskModels &&
    !agent.model.ended &&
    (taskModels.kind === "api"
      ? !taskModels.roles.some(
          (role) =>
            role.role === "main" &&
            role.provider === mainChoice.provider &&
            role.model === mainChoice.model,
        )
      : taskModels.kind !== mainChoice.provider || taskModels.model !== mainChoice.model);
  // A task at work keeps its model; one chosen meanwhile starts with the next task.
  const taskWorking =
    !!taskModels && !agent.model.ended && agent.snapshot?.status !== "idle" && !recoveryWait;
  const modelNext = modelChanged && taskWorking;
  const modelLabel =
    modelSaving?.name ?? (mainChoice ? names.name(mainChoice.provider, mainChoice.model) : "");
  const chooseModel = async (option: ModelOption) => {
    setModelSaving(option);
    const saved = await settings.chooseMain(option.choice);
    setModelSaving(null);
    if (!saved) {
      showToast({
        title: `Couldn't switch to ${option.name}`,
        description: "Try again, or choose it in Settings.",
        tone: "danger",
      });
      return;
    }
    announce(
      "model",
      taskWorking
        ? `${option.name} starts with the next task.`
        : `dot uses ${option.name} from your next message.`,
    );
  };
  const modelMenu = {
    groups: modelChoices,
    current: modelSaving?.id ?? currentOption(settings.saved),
    working: taskWorking,
    onChoose: (option: ModelOption) => void chooseModel(option),
  };
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
      onHide={
        phone
          ? undefined
          : () => {
              if (activityVisible)
                updatePanels({
                  activity: false,
                  ...(railView === "activity" ? { view: "chat" } : {}),
                });
              else setRailView("chat");
              panelsButton.current?.focus();
            }
      }
      cellId={viewedConversation ? undefined : cell?.id}
      releaseReady={
        !viewedConversation &&
        cell?.state === "ready" &&
        !cell.paused &&
        !cell.fenced &&
        !cell.replacementPending
      }
      models={(viewedConversation ? historyAgent : agent).snapshot?.models}
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
          onUndo:
            !viewedConversation && controls.canUndoMemory
              ? (id) => void controls.undo(id)
              : undefined,
          onReread: (trigger) => {
            controls.recheck();
            setReadMemory(true);
            showSettings(trigger, "knowledge");
          },
        };
      }}
      agent={viewedConversation ? historyAgent.model : agent.model}
      rows={viewedConversation ? historyRows : rows}
      keyUses={(viewedConversation ? historySession : session).model.keyUses}
      sessionId={(viewedConversation ? historySession : session).sessionId}
      scale={cell?.scale ?? 2}
      api={api}
      nowMs={now}
      historyLoaded={(viewedConversation ? historyAgent : agent).history === true}
    />
  );
  const shape = islandShape(appStatus, curtain.up || opening);
  const sheetsClosed = !settings.open;
  const approval = safety.approval;
  // The card shown is the task's own step, not an app's connection.
  const stepApproval = !!approval && !!agent.snapshot?.approval;
  const decision = replayId
    ? null
    : islandDecision({
        shape,
        approval: !!approval && sheetsClosed,
        connection: !!approval && !stepApproval,
        question: !!question && !agent.model.ended && sheetsClosed,
        chatShown: shownView === "chat" || wide || phone,
      });
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
  const [conversationsOpen, setConversationsOpen] = useState(false);
  if (conversationsOpen && !phone) setConversationsOpen(false);
  const needsYou = useMemo(
    () =>
      new Set(
        attention.items.flatMap((item) =>
          item.level === "needs_you" && item.sessionId ? [item.sessionId] : [],
        ),
      ),
    [attention.items],
  );
  const liveFacts = useMemo(
    () => ({
      live: session.sessionId && !session.ended ? session.sessionId : null,
      idle: taskStatus === "idle",
      needsYou,
    }),
    [session.sessionId, session.ended, taskStatus, needsYou],
  );
  const currentTask = conversation.sessions.at(-1) ?? null;
  const pickConversation = (id: string, sessions?: readonly string[]) => {
    setRailView("chat");
    if (yours) {
      setViewedConversation(id === currentTask ? null : { id, sessions: sessions ?? [id] });
      return;
    }
    setViewedConversation(null);
    if (id !== currentTask) void choose(id);
  };
  const conversationList = {
    api,
    current: viewedConversation?.id ?? currentTask,
    facts: liveFacts,
    reason: yours ? undefined : conversationReason,
    onPick: pickConversation,
    onDeleted: (ids: readonly string[]) => {
      if (viewedConversation && ids.includes(viewedConversation.id)) setViewedConversation(null);
      conversation.reload();
    },
    onReplay: () => selectReplay(LIBRARY),
  };
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
  // computer dot handed over, or takes it from dot at work, at rest or paused. An app's connection
  // card is no step to do instead of dot: it waits while the user takes the computer.
  const stepDecision = decision === "approval" && !stepApproval ? null : decision;
  const take = () => {
    if (stepDecision === "approval" && approval) {
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
    decision: stepDecision,
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
  const resting = restingBand({
    row: appStatus.row,
    computer: appStatus.computer,
    attention: appStatus.attention,
    line: narration,
    covered: curtain.up || !!replayId || onboarding.open || yours || !!error,
  });
  useEffect(() => {
    if (resting) setTipsRead(true);
  }, [resting]);
  const [overBand, setOverBand] = useState(false);
  const pageHidden = usePageHidden();
  const touch = useMediaQuery(TOUCH);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again each time dot comes to rest
  const exported = useMemo(() => hasExported(), [resting]);
  const idle = useIdleLine({
    resting,
    held: pageHidden || overBand || settings.open,
    signals: {
      touch: touch || phone,
      apple: isApple(),
      recordings: !!newestReplayId,
      routines: routines.reply?.routines.length,
      exported,
      purposeCheck: settings.draft?.purposeCheck,
      openAtLogin: routines.reply?.startAtLogin,
      update: computerUpdate.available,
      freshStart: freshStart.available,
    },
  });
  const openTip = (action: TipAction, trigger: HTMLElement) => {
    switch (action.opens) {
      case "settings":
        return goToSettings(trigger, action.section);
      case "replay":
        return selectReplay(LIBRARY);
      case "routine":
        return newRoutine(trigger);
    }
  };
  const tipAction = idle?.action;
  const bandLine = hearing ? LISTENING_LINE : idle ? idle.text : narration;
  const bandSpeaker = hearing || idle ? "dot" : speaker;
  const pendingQuestion = agent.model.pendingAsk
    ? agent.model.questions.get(agent.model.pendingAsk)?.question
    : undefined;
  const asked = pendingQuestion && markdownToPlain(pendingQuestion);
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
  // A decision grown out of the island fades with it, so the island stays while one is out: an
  // app's connection card while the user holds the computer has no attention of its own.
  const still = (touchStill || edgeStill) && !islandAttention(appStatus) && !grown;
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
      void choose(id).then((done) => {
        if (done) selectReplay(null);
      }),
  };
  // Until the shown task's history is in, its title is unknown, not new.
  const watchTitle =
    opening ||
    switching?.to ||
    (!switching &&
      !session.model.title &&
      ((curtain.up && !agent.sessionId && conversation.sessions.length === 0) ||
        threadPending ||
        (!!session.sessionId && agent.history !== true)))
      ? undefined
      : switching
        ? NEW_TITLE
        : (session.model.title ?? NEW_TITLE);
  const page = useRef<HTMLDivElement>(null);
  useKeyboardFit(page, keyboard);
  return (
    <div
      ref={page}
      className={appStatus.control && !replayId ? "app control" : "app"}
      data-layout={layout}
      data-chat-hidden={!chatVisible || undefined}
      data-activity-hidden={(wide && !activityVisible) || undefined}
      data-replaying={replayId ? "" : undefined}
      data-focus={focus ? "" : undefined}
      data-full={full ? "" : undefined}
      data-still={still ? "" : undefined}
      data-keyboard={keyboard ? "" : undefined}
      data-setup={onboarding.open ? "" : undefined}
      data-entering={opening ? "" : undefined}
    >
      <TopBar
        title={
          replayId === LIBRARY
            ? "Replay"
            : replayId
              ? (shownRecording?.title ?? RECORDED_TASK)
              : watchTitle
        }
        note={
          shownRecording?.note ??
          (!replayId && agent.model.origin?.kind === "routine" ? "Routine" : undefined)
        }
        mode={replayId ? "replay" : "watch"}
        watchAttention={
          !!replayId &&
          (appStatus.attention === "needs_you" ||
            attention.items.some(
              (item) => item.level === "needs_you" && item.sessionId === agent.sessionId,
            ))
        }
        replayEnabled={hasRecordings}
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
        panels={
          !phone &&
          !replayId && (
            <PanelMenu
              buttonRef={panelsButton}
              chat={chatVisible}
              activity={activityVisible || (chatVisible && shownView === "activity")}
              onChat={() =>
                updatePanels({ chat: !chatVisible, ...(!chatVisible ? { view: "chat" } : {}) })
              }
              onActivity={() => {
                if (wide)
                  updatePanels({
                    activity: !activityVisible,
                    ...(railView === "activity" ? { view: "chat" } : {}),
                  });
                else setRailView(chatVisible && shownView === "activity" ? "chat" : "activity");
              }}
            />
          )
        }
      />
      <div className="watch" hidden={!!replayId} inert={!!replayId}>
        <main className="stage-col" aria-label="Computer">
          <ErrorBoundary>
            <StageFrame
              overlay={
                !replayId &&
                !curtain.up &&
                !viewedConversation &&
                !switching &&
                stageHud.live &&
                session.sessionId ? (
                  <WorkOverlay
                    key={session.sessionId}
                    model={agent.model}
                    working={!!appStatus.control && !yours && !agent.model.ended}
                  />
                ) : undefined
              }
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
                    operation={operation}
                    ready={curtain.lifting}
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
                    decline={handBack.declinable ? handBack.declineSlot : undefined}
                    onPause={taskStop}
                    onContinue={() => void safety.resume()}
                    onStopTask={taskStop}
                    onTake={take}
                    onHandBack={() => void handBack.run()}
                    onDecline={() => void handBack.decline()}
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
                    line={bandLine}
                    speaker={bandSpeaker}
                    reveal={!!asked && narration === asked}
                    forUser={hearing || !atWork(appStatus.row)}
                    showDot={showDot.value}
                    note={focus && stepCount ? `Step ${stepCount}` : undefined}
                    idle={!hearing && !!idle}
                    action={
                      hearing || !tipAction
                        ? undefined
                        : {
                            label: tipAction.label,
                            run: (trigger) => openTip(tipAction, trigger),
                          }
                    }
                    onHover={setOverBand}
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
                    onPause={taskStop}
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
                          {...(handBack.declinable
                            ? {
                                decline: handBack.declineSlot,
                                onDecline: () => void handBack.decline(),
                              }
                            : {})}
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
              {!yours && !full && !focus && stageHud.live && (
                <span className="stage-expand">
                  <IconButton
                    variant="glass"
                    round
                    size={phone ? 44 : 32}
                    icon="expand"
                    label="Full screen"
                    kbd={phone ? undefined : ["F"]}
                    onClick={fullScreen.enter}
                  />
                </span>
              )}
            </StageFrame>
          </ErrorBoundary>
        </main>
        {activityVisible && (
          <RailPanel label="Activity" className="rail-activity">
            <ErrorBoundary>{activity}</ErrorBoundary>
          </RailPanel>
        )}
        {activityVisible && (
          <ResizeHandle
            panel={ACTIVITY_WIDTH}
            property="--activity-w"
            label="Activity width"
            className="rail-resize-activity"
          />
        )}
        {chatVisible && (wide || layout === "laptop") && (
          <ResizeHandle
            panel={CHAT_WIDTH}
            property="--rail-w"
            label="Conversation width"
            className="rail-resize-chat"
          />
        )}
        <RailPanel
          label="Conversation"
          className="rail-chat"
          hidden={!chatVisible}
          views={views}
          view={shownView}
          onView={(view) => setRailView(view as RailView)}
          end={
            !phone && (
              <span className="rail-actions">
                <ConversationsButton {...conversationList} />
                <NewConversationButton {...newConversation} />
              </span>
            )
          }
        >
          <ErrorBoundary>
            <ChatThread
              visible={shownView === "chat"}
              agent={switching ? undefined : viewedConversation ? historyAgent : agent}
              words={
                switching
                  ? undefined
                  : viewedConversation
                    ? historySession.agentFeed
                    : session.agentFeed
              }
              api={api}
              rows={viewedConversation ? historyRows : rows}
              reveal={reveal}
              names={names}
              computerReady={cell?.state === "ready" && !cell.paused}
              computerUpdating={!!cell?.updating}
              live={!viewedConversation && foot && !session.ended ? { ...foot, nowMs: now } : null}
              onReplay={
                viewedConversation
                  ? () => selectReplay(viewedConversation.id)
                  : agent.sessionId && (agent.model.ended || task?.phase === "finished")
                    ? () => selectReplay(agent.sessionId)
                    : undefined
              }
              onReplayTask={selectReplay}
              sessions={
                switching ? NO_SESSIONS : (viewedConversation?.sessions ?? conversation.sessions)
              }
              more={!switching && conversation.more}
              pending={
                switching
                  ? switching.to !== null
                  : viewedConversation
                    ? !historyAgent.history
                    : threadPending
              }
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
                      {
                        label: "New conversation",
                        icon: "compose",
                        disabledReason: newConversation.reason,
                        run: newConversation.run,
                      },
                      {
                        label: "Conversations",
                        icon: "message-circle",
                        run: () => setConversationsOpen(true),
                      },
                      {
                        label: "Research a question",
                        icon: "library",
                        disabledReason: researchWait(agent),
                        run: requestResearch,
                      },
                      ...(mainChoice
                        ? [
                            {
                              label: `${modelNext ? "Next task" : "Model"}: ${modelLabel}`,
                              icon: "cpu" as const,
                              disabledReason: modelSaving ? "Saving…" : undefined,
                              run: (trigger: HTMLButtonElement) => {
                                settings.browseAccounts();
                                phoneModelsAnchor.current = trigger;
                                setPhoneModels(true);
                              },
                            },
                          ]
                        : []),
                      {
                        label: "Replay",
                        icon: "history",
                        startsGroup: true,
                        disabledReason: hasRecordings ? undefined : "No recordings yet",
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
                setupDone === false ? (
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
                !switching &&
                !viewedConversation && (
                  <>
                    {takeover && takeover.by !== "user" && (
                      <div className="thread-handoff" role="status">
                        <strong>{yours ? "Your turn" : "dot needs your help"}</strong>
                        <p>
                          {takeover.note ||
                            "Complete the step on the computer, then choose Hand back."}
                        </p>
                      </div>
                    )}
                    <TaskRecovery
                      agent={agent}
                      controls={controls}
                      onSettings={showSettings}
                      onReenterKey={reenterKey}
                      onContinue={continueTask}
                      onCarryOn={cell?.state === "ready" && !cell.paused ? carryOn : undefined}
                      onResumeSelected={modelChanged && recoveryWait ? carryOn : undefined}
                      resumeBlocked={modelSaving ? "Saving the selected model…" : undefined}
                    />
                  </>
                )
              }
              ask={switching || viewedConversation ? undefined : askThread}
              composer={
                viewedConversation ? (
                  <div className="thread-recovery-actions">
                    <Button variant="quiet" onClick={() => setViewedConversation(null)}>
                      Back to current conversation
                    </Button>
                    {!yours && (
                      <Button onClick={() => void choose(viewedConversation.id)}>
                        Continue this conversation
                      </Button>
                    )}
                  </div>
                ) : (
                  <Composer
                    api={api}
                    cell={cell}
                    onSending={(on) => setSendingSince(on ? Date.now() : null)}
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
                    configured={setupDone}
                    onSettings={(trigger) => showSettings(trigger, "models")}
                    onTaskStarted={session.check}
                    layout={phone ? "pill" : "card"}
                    reply={askDraft ? replyAsk : undefined}
                    modelChanged={modelChanged}
                    permissions={
                      <PermissionChip
                        value={settings.saved?.permissionMode ?? "custom"}
                        busy={settings.busy}
                        onChoose={(mode) => {
                          void settings.choosePermissions(mode).then((saved) => {
                            if (!saved)
                              showToast({ title: "Couldn't save permissions", tone: "danger" });
                          });
                        }}
                      />
                    }
                    taskAction={
                      agent.sessionId &&
                      !agent.model.ended &&
                      agent.snapshot?.status !== "idle" &&
                      agent.snapshot?.status !== "ended"
                        ? {
                            kind: "stop",
                            run: taskStop,
                            disabledReason: stoppingRun ? "Stopping…" : undefined,
                          }
                        : undefined
                    }
                    model={
                      mainChoice && (
                        <ModelChip
                          {...modelMenu}
                          name={modelLabel}
                          next={modelNext}
                          disabledReason={modelSaving ? "Saving…" : undefined}
                          onPeek={settings.browseAccounts}
                          onManage={(trigger) => showSettings(trigger, "models")}
                        />
                      )
                    }
                  />
                )
              }
            />
            {phone && (
              <ModelMenu
                {...modelMenu}
                open={phoneModels}
                onClose={() => setPhoneModels(false)}
                anchor={phoneModelsAnchor}
                side="top"
                align="end"
                dim
                onManage={(trigger) => showSettings(trigger, "models")}
              />
            )}
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
            hostExports={hostExports}
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
          voice={{
            prefs: voicePrefs.value,
            saved: voicePrefs.saved,
            change: voicePrefs.change,
            route: voiceRoute(voiceSupport.support, voicePrefs.value.online, voiceLanguage),
            browser: voiceBrowser,
            downloading: voiceSupport.downloading,
            download: voiceSupport.download,
          }}
          stopNote={stopNote}
          stream={streamChoice}
          stop={sheetStopControl}
          stopAll={settingsStopAll}
          startAtLogin={settingsLogin}
          appUpdate={appUpdate}
          remoteApi={api}
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
          signIn={signIn}
          connectors={settingsConnectors}
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
          research={
            settings.draft
              ? { value: settings.draft.research, change: settings.research }
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
      {phone && (
        <ErrorBoundary floating>
          <DecisionSheetPresence
            show={!!approvalView || askIn === "sheet"}
            label={appStatus.label}
            elapsedS={appStatus.elapsedS}
          >
            {approvalView || askOver("sheet")}
          </DecisionSheetPresence>
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
          open={conversationsOpen}
          onClose={() => setConversationsOpen(false)}
          title="Conversations"
          doneLabel="Done"
          detents={LIST_DETENTS}
          className="conversations-sheet"
        >
          <ConversationList
            {...conversationList}
            open={conversationsOpen}
            onPick={(id, sessions) => {
              setConversationsOpen(false);
              conversationList.onPick(id, sessions);
            }}
            onReplay={() => {
              setConversationsOpen(false);
              conversationList.onReplay();
            }}
          />
        </Sheet>
      )}
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
        <ErrorBoundary quiet>
          <PresenceLayer
            place={place}
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
                : hearing
                  ? { ...dotFeed(appStatus, null, now), state: "listening", tool: null }
                  : dotFeed(appStatus, session.sessionId ? session.model : null, now)
            }
            line={onboarding.open || bandSpeaker !== "dot" || hearing ? "" : bandLine}
          />
        </ErrorBoundary>
      )}
      <Announcer />
    </div>
  );
}
