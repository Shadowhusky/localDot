import {
  type ConversationEntry,
  DEFAULT_AUTONOMY,
  DEFAULT_PERSONA,
  isJevKey,
  LLM_PROVIDERS,
  outfit,
  type PersonaId,
  PlanProvider,
  personaOf,
  type QuestionAnswerRequest,
  SessionIndexPage,
  STALL,
  taskOutfit,
  ULID_PATTERN,
} from "@localdot/protocol";
import { providerById, sameModelOptions } from "@localdot/providers";
import { stepsRevision } from "@localdot/stage";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { CommandPalette, type PalettePage, usePaletteKeys } from "./actions/CommandPalette.tsx";
import { SideNote } from "./actions/SideNote.tsx";
import { useActions } from "./actions/useActions.ts";
import { useAside } from "./actions/useAside.ts";
import { PlainSteps } from "./agent/ActivityRow.tsx";
import { AskForm, type AskUpload } from "./agent/AskForm.tsx";
import { useAskDraft } from "./agent/ask-draft.ts";
import { asksPrivate } from "./agent/ask-form.ts";
import { BrowserSignIn } from "./agent/BrowserSignIn.tsx";
import { Composer, type DotWait, keepDraftNow } from "./agent/Composer.tsx";
import { endTaskRun } from "./agent/control-api.ts";
import {
  type ConversationRow,
  conversationLook,
  conversationRows,
  conversationTitle,
  knownConversation,
  organizeConversation,
  readConversationsAgain,
  renameConversation,
  STATUS_LABEL,
  useRecentConversations,
} from "./agent/conversation-list.ts";
import { conversationBlockReason } from "./agent/conversation-state.ts";
import { FixCards, fixesToShow, fixWait, takesSecret } from "./agent/FixCards.tsx";
import { useTaskStalled } from "./agent/heartbeat.ts";
import { LatestSteps } from "./agent/LatestSteps.tsx";
import { ModelChip, ModelMenu } from "./agent/ModelChip.tsx";
import { markdownToPlain } from "./agent/markdown.ts";
import { heldByUser } from "./agent/model.ts";
import { PermissionChip } from "./agent/PermissionChip.tsx";
import { giveBack, sendAfter } from "./agent/queued-draft.ts";
import { requestResearch, researchWait } from "./agent/research.ts";
import { uploadFile } from "./agent/resumable-upload.ts";
import { SafetyNotes } from "./agent/SafetyNotes.tsx";
import { StepPreviewScope } from "./agent/StepPreview.tsx";
import { planResets, TaskRecovery } from "./agent/TaskRecovery.tsx";
import { useAgentSession } from "./agent/useAgentSession.ts";
import { useControlToast } from "./agent/useControlToast.ts";
import { useConversation } from "./agent/useConversation.ts";
import { useHandBack } from "./agent/useHandBack.ts";
import { useHandOff } from "./agent/useHandOff.ts";
import { useKnowledge } from "./agent/useKnowledge.ts";
import { useManualChannel } from "./agent/useManualChannel.ts";
import { usePlanUsage } from "./agent/usePlanUsage.ts";
import { useSafety } from "./agent/useSafety.ts";
import { useStopHotkey } from "./agent/useStopHotkey.ts";
import { stopNotice, stoppedOff, useStopToast } from "./agent/useStopToast.ts";
import { useTaskControls } from "./agent/useTaskControls.ts";
import { deliverText } from "./agent/write-api.ts";
import { stageBounds } from "./cells/computer-update-stage.ts";
import { replacementNotice } from "./cells/errors.ts";
import { type HudActionKind, hudFor, withScreenHud } from "./cells/hud-state.ts";
import { useBrowserScreen } from "./cells/useBrowserScreen.ts";
import { useCell } from "./cells/useCell.ts";
import {
  useComputerUpdate,
  useUpdateNotice,
  useUpdateProgressNotice,
} from "./cells/useComputerUpdate.ts";
import { useFreshStart } from "./cells/useFreshStart.ts";
import { useRuntime } from "./cells/useRuntime.ts";
import { presetOf } from "./copy/autonomy.ts";
import { decisionWords } from "./copy/decision.ts";
import { useDotArrival } from "./dot/arrival.ts";
import { dotFeed } from "./dot/dot-feed.ts";
import { pictureAway, restingBand, useIdleLine, usePageHidden } from "./dot/idle-line.ts";
import { PresenceLayer } from "./dot/PresenceLayer.tsx";
import { phonePresencePlace, presencePlace } from "./dot/presence-rules.ts";
import { crown } from "./dot/render/wearables.ts";
import { useHasReplayPresence } from "./dot/replay-presence.ts";
import { useShowDot } from "./dot/show-dot.ts";
import type { TipAction } from "./dot/tips.ts";
import { VOICES } from "./dot/voices.ts";
import { setWearing } from "./dot/wearing.ts";
import { hasExported } from "./export/export-estimate.ts";
import { createHostExports } from "./export/host-exports.ts";
import { createExportJob } from "./export/job.ts";
import { useExportToast } from "./export/useExportToast.tsx";
import { t } from "./i18n/index.ts";
import { JEV_KEY } from "./keys/binding.ts";
import type { KeyFormPreset, KeyIntake } from "./keys/KeyForm.tsx";
import { type KeyRecord, vaultLocked } from "./keys/keys-api.ts";
import { keyStatus, useKeys } from "./keys/useKeys.ts";
import { useSavedLogins } from "./keys/useSavedLogins.ts";
import { type ApiClient, ApiError, createApi } from "./lib/api.ts";
import {
  exchangeInstallCode,
  type InstallLink,
  InstallLinkError,
  linkArrived,
  takeInstallLink,
} from "./lib/install-link.ts";
import {
  forgetToken,
  keepToken,
  rememberSharedToken,
  sharedToken,
  storedToken,
} from "./lib/token.ts";
import { listenForSessionLinks } from "./notify/session-link.ts";
import { useAttention } from "./notify/useAttention.ts";
import { useAttentionToasts } from "./notify/useAttentionToasts.ts";
import { useOpenSession } from "./notify/useOpenSession.ts";
import { FinishSetup } from "./onboarding/FinishSetup.tsx";
import { Onboarding } from "./onboarding/Onboarding.tsx";
import { setupSteps } from "./onboarding/setup.ts";
import { useAppearance } from "./onboarding/useAppearance.ts";
import { useOnboarding } from "./onboarding/useOnboarding.ts";
import { STEP_DOT } from "./onboarding/wizard.ts";
import { Overview } from "./overview/Overview.tsx";
import { PreviewNotice } from "./previews/PreviewNotice.tsx";
import { usePreviewsState } from "./previews/PreviewsContext.tsx";
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
import { conversationOfRun } from "./routines/routines-api.ts";
import { useRoutines } from "./routines/useRoutines.ts";
import { timelineRows } from "./session/key-uses.ts";
import { stepRows } from "./session/session-view.ts";
import {
  awaitingWord,
  footWork,
  type HudAction,
  SENT_THINKING,
  type SentTo,
  sentToRest,
  statusFor,
  taskFacts,
  taskHud,
  withSending,
} from "./session/status.ts";
import { useLiveSession } from "./session/useLiveSession.ts";
import { nextChange, SessionNowContext, useNowMs } from "./session/useNowMs.ts";
import { useSeenReporting } from "./session/useSeenReporting.ts";
import { AppUpdateOverlay } from "./settings/AppUpdateSettings.tsx";
import { autoDotReason } from "./settings/AutoDot.tsx";
import { matchingKeys } from "./settings/choices.ts";
import { subscription } from "./settings/chooser.ts";
import { useWhatDotKnows } from "./settings/memory/useWhatDotKnows.ts";
import { modelNames } from "./settings/model-names.ts";
import { type ModelOption, modelGroups, optionId } from "./settings/model-options.ts";
import { purposeJudge } from "./settings/PurposeCheck.tsx";
import type { ReportAbout, ReportControl } from "./settings/reports-api.ts";
import { type SettingsSection, SettingsSheet } from "./settings/SettingsSheet.tsx";
import { loadKeyModels } from "./settings/settings-api.ts";
import { NAME_PROBLEM, needsPrice, pickerKeys } from "./settings/settings-form.ts";
import { listenForSettingsLinks, type SettingsTip } from "./settings/settings-link.ts";
import { useAccounts } from "./settings/useAccounts.ts";
import { useAppUpdate } from "./settings/useAppUpdate.ts";
import { useBrowserEngine } from "./settings/useBrowserEngine.ts";
import { useBrowserStatus } from "./settings/useBrowserStatus.ts";
import { useConnectors } from "./settings/useConnectors.ts";
import { useDesktopSignIn } from "./settings/useDesktopSignIn.ts";
import { useNotifications } from "./settings/useNotifications.ts";
import { useRules } from "./settings/useRules.ts";
import { useSettings } from "./settings/useSettings.ts";
import { useSignIn } from "./settings/useSignIn.ts";
import { useTaskModel } from "./settings/useTaskModel.ts";
import { ActivityRail } from "./shell/ActivityRail.tsx";
import { showActivityTab } from "./shell/activity-tabs.ts";
import { ChatThread, type NewConversation, NewConversationButton } from "./shell/ChatThread.tsx";
import { ChatToggle } from "./shell/ChatToggle.tsx";
import { CoachMark } from "./shell/CoachMark.tsx";
import { ComputerScreen } from "./shell/ComputerScreen.tsx";
import { ControlStrip, ControlTools } from "./shell/ControlStrip.tsx";
import { ConversationDetails } from "./shell/ConversationDetails.tsx";
import { ConversationList, ConversationsButton } from "./shell/ConversationList.tsx";
import { ConversationsBubble } from "./shell/ConversationsBubble.tsx";
import { Curtain } from "./shell/Curtain.tsx";
import { useChatFit } from "./shell/chat-fit.ts";
import { useCurtain } from "./shell/curtain.ts";
import { ApprovalDecision, DecisionSheetPresence } from "./shell/DecisionIsland.tsx";
import { DeleteConversationDialog } from "./shell/DeleteConversationDialog.tsx";
import { DotChooser } from "./shell/DotChooser.tsx";
import { DotStrip } from "./shell/DotStrip.tsx";
import { useDotTuck } from "./shell/dot-tuck.ts";
import { FocusControls } from "./shell/FocusControls.tsx";
import { useFocusMode, useStill } from "./shell/focus.ts";
import { useEdgeStill, useFullScreen, useFullScreenKeys } from "./shell/fullscreen.ts";
import { Held } from "./shell/Held.tsx";
import { HudIsland, type StageFields } from "./shell/HudIsland.tsx";
import {
  islandAttention,
  islandDecision,
  islandShape,
  pauseSlot,
  type TakeSlot,
  takeReason,
  takeSlot,
} from "./shell/island.ts";
import { LocalDotSwitcher } from "./shell/LocalDotSwitcher.tsx";
import { LookChooser } from "./shell/LookChooser.tsx";
import { useKeyboardUp, useLayout, useViewportFit } from "./shell/layout.ts";
import { forgetLocalDot, useOtherLocalDots } from "./shell/localdot-handoff.ts";
import { MoreMenu } from "./shell/MoreMenu.tsx";
import { NarratorBand } from "./shell/NarratorBand.tsx";
import { atWork, longThinkAt, narrationLine } from "./shell/narration.ts";
import { PhoneBanner } from "./shell/PhoneBanner.tsx";
import { PhoneBar } from "./shell/PhoneBar.tsx";
import { PhoneList } from "./shell/PhoneList.tsx";
import {
  ComputerMenuItems,
  ComputerNotice,
  ConversationMenuItems,
  PhoneAdd,
  TaskControls,
} from "./shell/PhoneParts.tsx";
import { PhoneStack } from "./shell/PhoneStack.tsx";
import { PANEL_NAME } from "./shell/panel-name.ts";
import { type RailView, usePanelPreferences } from "./shell/panel-preferences.ts";
import { CHAT_WIDTH, SESSIONS_FOLDED, SESSIONS_WIDTH } from "./shell/panel-width.ts";
import { usePhoneConversation } from "./shell/phone-conversation.ts";
import { Flyer } from "./shell/phone-flyer.ts";
import { parsePhoneRoute, phoneHash, usePhoneAddress, usePhoneRoute } from "./shell/phone-route.ts";
import { RailPanel } from "./shell/RailPanel.tsx";
import { ResizeHandle } from "./shell/ResizeHandle.tsx";
import { SessionRail, useRailExpandedByDefault } from "./shell/SessionRail.tsx";
import { SignIn, type SignInState } from "./shell/SignIn.tsx";
import { StageExpand } from "./shell/StageExpand.tsx";
import { StageFrame } from "./shell/StageFrame.tsx";
import { StreamMenu } from "./shell/StreamMenu.tsx";
import { changeCalmly } from "./shell/switch-motion.ts";
import { TaskTime } from "./shell/TaskTime.tsx";
import { TopBar } from "./shell/TopBar.tsx";
import { useTabAttention } from "./shell/tab-attention.ts";
import { switchToDot, useLocalDots } from "./shell/useLocalDots.ts";
import { useMobileScreen } from "./shell/useMobileScreen.ts";
import { useStopAll } from "./shell/useStopAll.ts";
import { otherView, switchViewLabel, useViewStyle, type ViewStyle } from "./shell/view-style.ts";
import { runningEngine } from "./stage/BrowserWindow.tsx";
import { useStageConnection, useStagePicture } from "./stage/connection.ts";
import type { PointerMode } from "./stage/ManualSurface.tsx";
import { SharedScreen, useSharedLook } from "./stage/SharedScreen.tsx";
import { Stage, type StageHandle } from "./stage/Stage.tsx";
import { screenMoveNote } from "./stage/StageNotice.tsx";
import { SwitchCover } from "./stage/SwitchCover.tsx";
import { useStageSwitch } from "./stage/stage-switch.ts";
import { useStreamPreference } from "./stage/stream-preference.ts";
import { useStageFront } from "./stage/useStageFront.ts";
import type { FieldMark } from "./stage/worker-protocol.ts";
import { Announcer, announce, withdraw } from "./ui/Announcer.tsx";
import { Button } from "./ui/Button.tsx";
import { ErrorBoundary } from "./ui/ErrorBoundary.tsx";
import { useHeldFor } from "./ui/held.ts";
import { IconButton } from "./ui/IconButton.tsx";
import { isApple } from "./ui/Kbd.tsx";
import { Menu, MenuItem, MenuSeparator } from "./ui/Menu.tsx";
import { TOUCH, useMediaQuery } from "./ui/media.ts";
import { Presence } from "./ui/Presence.tsx";
import type { SegmentItem } from "./ui/SegmentedControl.tsx";
import { Sheet } from "./ui/Sheet.tsx";
import { dismissToast, showToast, Toaster } from "./ui/Toast.tsx";
import { useHandler } from "./ui/useHandler.ts";
import { WorkView } from "./work/WorkView.tsx";
import { workCard } from "./work/work-view.ts";
import "./app.css";
import { personaName } from "./dot/persona-words.ts";
import { GuestSettingsSheet } from "./remote/GuestSettings.tsx";
import {
  type Guest,
  GuestProvider,
  guestModelGroups,
  guestModelName,
  guestNames,
  useGuestLink,
} from "./remote/guest.ts";
import { speechLanguage } from "./voice/language.ts";
import { useListening } from "./voice/listening.ts";
import { useVoicePrefs } from "./voice/prefs.ts";
import { useReadAloud } from "./voice/read-aloud.ts";
import { useVoiceSupport, voiceRoute } from "./voice/support.ts";
import { useSpeechInstall } from "./voice/useSpeechInstall.ts";
import { browserLanguages } from "./voice/useVoice.ts";
import { LISTENING_LINE } from "./voice/words.ts";

export interface AppProps {
  fetchImpl?: typeof fetch;
}

type Rejected = "stored" | "ended" | "link" | "code" | "unconfirmed" | null;

const RETRY_CHECK_MS = 2000;
// Slow restoration offers recovery; elapsed time never means the history is ready.
const OPENING_NOTICE_MS = 10_000;
// How long the task's feed may be out of touch before the island says it is reconnecting.
const LINK_LOST_MS = 3000;
const FROM_WATCH = { fromWatch: true };
const FROM_LIBRARY = { fromLibrary: true };
// Replay's address names the recording that plays, or this for the library of recordings.
const LIBRARY = "library";
const replayAddress = (selected: string | null) =>
  selected && (selected === LIBRARY || ULID_PATTERN.test(selected)) ? selected : null;
// The overview is in the address too, so Back, a reload and a link all find it.
const OVERVIEW = "overview";
const overviewAddress = () => new URLSearchParams(window.location.search).has(OVERVIEW);
const ACTIVITY_DETENTS = ["medium", "large"] as const;
const LIST_DETENTS = ["medium", "large"] as const;
// A chosen conversation that never comes on show once the daemon has taken the choice (another
// task holds the computer) stops waiting.
const SWITCH_MAX_MS = 3000;
const ALREADY_NEW = t`This is a new conversation`;
const NEW_TITLE = t`New conversation`;
const NO_SESSIONS: readonly string[] = [];
const PHONE_CONTROL_LINE = t`Tap to click, drag to scroll. Hand back when you're done.`;
const CONFIRMING_LINE = t`Checking that your last input reached the computer…`;
const SLOW_LINE = t`This is taking longer than usual. Stop me if it looks stuck.`;

export function App({ fetchImpl }: AppProps) {
  const [token, setToken] = useState(() => storedToken());
  const [shared, setShared] = useState(() => sharedToken(storedToken()));
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
    const accept = (accepted: string, shared = false) => {
      if (!current()) return;
      keepToken(accepted);
      rememberSharedToken(accepted, shared);
      setShared(shared);
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
          const identity = await createApi(accepted, { fetchImpl }).get<{ shared?: boolean }>(
            "/api/whoami",
          );
          accept(accepted, identity.shared === true);
        })
        .catch((error: unknown) => {
          if (!current()) return;
          setRejected(
            error instanceof InstallLinkError && error.kind === "expired" ? "code" : "unconfirmed",
          );
          setCandidate(null);
        });
      return () => {
        cancelled = true;
      };
    }
    const check = () => {
      createApi(candidate.value, { fetchImpl })
        .get<{ shared?: boolean }>("/api/whoami")
        .then(
          (identity) => {
            accept(candidate.value, identity.shared === true);
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
              setRejected(sharedToken(token) ? "ended" : "stored");
              forgetToken(token);
              setToken((current) => (current === token ? null : current));
            },
          })
        : null,
    [token, fetchImpl],
  );

  if (api)
    return shared ? <GuestTheatre key={token} api={api} /> : <Theatre key={token} api={api} />;
  if (candidate || arriving) return <SignIn state="checking" />;
  return <SignIn state={SIGN_IN[rejected ?? "none"]} />;
}

const SIGN_IN: Record<Exclude<Rejected, null> | "none", SignInState> = {
  none: "first",
  stored: "signed-out",
  ended: "ended",
  link: "expired",
  code: "expired",
  unconfirmed: "unconfirmed",
};

// How long a sent message shows dot thinking with no word from the task before the real status returns.
const SENDING_HOLD_MS = 20_000;
const FIXED_MODEL = t`This link sets the model`;
const THINKING_LINE = t`Thinking…`;

// A shared link opens the same app, with the link's limits in front of everything it asks for.
function GuestTheatre({ api }: { api: ApiClient }) {
  const link = useGuestLink(api);
  if (!link.guest) return <SignIn state="checking" />;
  return (
    <GuestProvider value={link.guest}>
      <Theatre api={link.api} guest={link.guest} />
    </GuestProvider>
  );
}

function Theatre({ api, guest = null }: { api: ApiClient; guest?: Guest | null }) {
  const canReplay = !guest || guest.grant.replay;
  const appearance = useAppearance();
  const localDots = useLocalDots(api);
  const showDot = useShowDot();
  const streamChoice = useStreamPreference(showToast);
  const [replayId, setReplayId] = useState<string | null>(() =>
    canReplay ? replayAddress(new URLSearchParams(window.location.search).get("replay")) : null,
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
  const selectReplay = (
    id: string | null,
    entry: "navigate" | "replace" = "navigate",
    atMs?: number,
  ) => {
    if (id && !canReplay) return;
    const was = replayIdRef.current;
    const address = new URL(window.location.href);
    if (id) {
      address.searchParams.set("replay", id);
      address.searchParams.delete(OVERVIEW);
      setOverviewOpen(false);
    } else address.searchParams.delete("replay");
    if (id !== was) address.searchParams.delete("t");
    if (atMs !== undefined) address.searchParams.set("t", String(Math.round(atMs)));
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
  // Opening the overview adds one marked entry, and closing it steps back over that entry, so Back
  // leaves it as it came; a conversation opened from it is an entry of its own above it.
  const [overviewOpen, setOverviewOpen] = useState(overviewAddress);
  useEffect(() => {
    const restore = () => setOverviewOpen(overviewAddress());
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  const showOverview = (open: boolean) => {
    if (open === overviewAddress()) return setOverviewOpen(open);
    const address = new URL(window.location.href);
    if (open) {
      address.searchParams.set(OVERVIEW, "1");
      address.searchParams.delete("replay");
      address.searchParams.delete("t");
      window.history.pushState({ ...window.history.state, overview: true }, "", address);
      setReplayId(null);
    } else if (window.history.state?.overview) window.history.back();
    else {
      address.searchParams.delete(OVERVIEW);
      window.history.replaceState(window.history.state, "", address);
    }
    setOverviewOpen(open);
  };
  const {
    cell,
    status,
    pending,
    streamed,
    error,
    startAnyway,
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
  const runtime = useRuntime(api);
  const computerUpdate = useComputerUpdate(api, cell);
  const freshStart = useFreshStart(api, cell, selectReady);
  const keys = useKeys(api);
  const settings = useSettings(api);
  const otherLocalDots = useOtherLocalDots(settings.saved);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a saved-key revision invalidates the independently cached provider metadata
  useEffect(() => {
    if (keys.metadataReady) void settings.checkModels();
  }, [keys.revision, keys.metadataReady, settings.checkModels]);
  // Every dot on screen wears what the user's dot wears, with this localDot's accessory.
  const persona = settings.saved?.persona;
  const accessory = settings.saved?.accessory;
  const worn = useMemo(() => outfit(persona, accessory), [persona, accessory]);
  const dotAnchor = useRef<HTMLElement | null>(null);
  const [choosingDot, setChoosingDot] = useState(false);
  const ownDotKnown = !!settings.saved || !!guest;
  // Ahead of the effects of any dot this render brings on to the page.
  useLayoutEffect(() => {
    if (ownDotKnown) setWearing(worn, accessory);
  }, [ownDotKnown, worn, accessory]);
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
    () =>
      guest
        ? guestNames(guest.grant)
        : modelNames(providerIndex, { chatgpt: accountModels, claudeCode: claudeModels }),
    [guest, providerIndex, accountModels, claudeModels],
  );
  // A link's tasks run on the link's model, which the owner set up.
  const mainChoice = guest ? guest.grant.model : settings.saved?.main;
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
  const setupDone = guest ? true : mainKnown ? mainReady : setupSeen;
  const keysButton = useRef<HTMLButtonElement>(null);
  const keysIntake = useRef<KeyIntake>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const settingsOrigin = useRef<HTMLElement | null>(null);
  const settingsOpen = useRef(settings.open);
  settingsOpen.current = settings.open;
  // Where Settings goes, with a count, so a section asked for again is still gone to.
  const [settingsAt, setSettingsAt] = useState<{
    section?: SettingsSection;
    tip?: SettingsTip;
    request: number;
  }>({ request: 0 });
  const [keyPreset, setKeyPreset] = useState<KeyFormPreset | undefined>();
  const [keyReentry, setKeyReentry] = useState<{ requestId: number; id: string } | undefined>();
  const keyRequest = useRef(0);
  const keyCapture = useRef<{
    request: number;
    capture: ReturnType<typeof settings.captureKey>;
  } | null>(null);
  const { show: openSettings } = settings;
  const goToSettings = useCallback(
    (trigger: HTMLElement | null, section?: SettingsSection, tip?: SettingsTip) => {
      if (guest) return;
      if (!settingsOpen.current) settingsOrigin.current = trigger;
      setSettingsAt((now) => ({ section, tip, request: now.request + 1 }));
      openSettings();
    },
    [openSettings, guest],
  );
  const showSettings: (trigger: HTMLElement, section?: SettingsSection, tip?: SettingsTip) => void =
    goToSettings;
  const [reportAbout, setReportAbout] = useState<ReportAbout>();
  const report = useMemo<ReportControl>(
    () => ({
      api,
      about: reportAbout,
      start: (trigger, about) => {
        setReportAbout(about);
        goToSettings(trigger, "report");
      },
      clear: () => setReportAbout(undefined),
    }),
    [api, reportAbout, goToSettings],
  );
  const showModels = useCallback(
    (trigger: HTMLElement) => goToSettings(trigger, "models"),
    [goToSettings],
  );
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
    if (!canReplay) {
      setNewestReplayId(null);
      return;
    }
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
  }, [api, canReplay, session.sessionId, session.ended, historyRevision]);
  const agent = useAgentSession(api, cell, session);
  // A link changes only the tasks it started.
  const mine = !guest || guest.owns(agent.sessionId);
  // The dot this task works as, which the one on screen wears from the moment it is chosen. While
  // a task's record is being read it keeps what it wears, so taking up a conversation changes it once.
  const worksAs = session.sessionId ? session.model.dots.at(-1)?.persona : undefined;
  const taskDotRef = useRef<PersonaId | undefined>(undefined);
  if (worksAs || !session.sessionId || agent.history === true) taskDotRef.current = worksAs;
  const taskDot = taskDotRef.current;
  const currentWork = useMemo(() => workCard(agent.model), [agent.model]);
  const [displayChoice, setDisplayChoice] = useState({ session: "", value: "auto" });
  const displayControl = {
    value: displayChoice.session === agent.sessionId ? displayChoice.value : "auto",
    change: (value: string) => setDisplayChoice({ session: agent.sessionId ?? "", value }),
  };
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
  // The conversation's next task starts on the daemon, by a message or by one that waited: its list
  // of tasks is read again as the task comes on show.
  const unlisted =
    conversation.known &&
    !switching &&
    !choosing &&
    !viewedConversation &&
    !!session.sessionId &&
    !conversation.sessions.includes(session.sessionId);
  const { reload: readConversation } = conversation;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each task is listed once; the id is the trigger.
  useEffect(() => {
    if (unlisted) readConversation();
  }, [unlisted, session.sessionId, readConversation]);
  useEffect(() => {
    if (!switching || choosing) return;
    const timer = setTimeout(() => setSwitching(null), SWITCH_MAX_MS);
    return () => clearTimeout(timer);
  }, [switching, choosing]);
  const choices = useRef(0);
  const { startNew, continueFrom } = conversation;
  // The stage's side of the choice: what it covers with until the conversation's own screen is in.
  const stageSwitch = useStageSwitch();
  const { begin: beginStageSwitch, end: endStageSwitch } = stageSwitch;
  const stageSwitchFacts = useRef<(to: string | null) => { title?: string; same: boolean }>(() => ({
    same: false,
  }));
  const choose = useCallback(
    async (to: string | null) => {
      setViewedConversation(null);
      const request = ++choices.current;
      setSwitching({ to });
      setReveal((value) => value + 1);
      const { title, same } = stageSwitchFacts.current(to);
      beginStageSwitch(to, title, same);
      // Where dot moved in the conversation left behind is no news in the one taken up.
      dismissToast("screen");
      const done = await (to ? continueFrom(to) : startNew());
      if (!done && request === choices.current) {
        setSwitching(null);
        endStageSwitch();
        setReveal((value) => value + 1);
      }
      return done;
    },
    [startNew, continueFrom, beginStageSwitch, endStageSwitch],
  );
  // The web browser is signed in as the owner: a link without their apps watches the desktop.
  const selectedScreen = guest && !guest.grant.apps ? undefined : agent.watchScreen;
  const stageFront = useStageFront(
    api,
    cell,
    selectedScreen,
    agent.sessionId,
    !!agent.model.pendingTakeover,
  );
  // What the web browser runs, for its window's title and its dock item.
  const stageEngine = useBrowserEngine(api, !!cell);
  const shownScreen = stageFront.screen;
  const browserScreen = useBrowserScreen(api, cell, stageFront.browser);
  const physicalStageCell = shownScreen === "browser" ? browserScreen.cell : cell;
  const { picture, onPicture } = useStagePicture(shownScreen, physicalStageCell?.state === "ready");
  const layout = useLayout();
  const chosenStyle = useViewStyle();
  // A shared link has one conversation: Chat, with no list beside it.
  const viewStyle = guest ? { ...chosenStyle, value: "chat" as const } : chosenStyle;
  // Chat: a stack of the list, the conversation and the computer, opened out from tablet width up.
  const stack = viewStyle.value === "chat";
  const split = stack && layout !== "phone";
  // On a wide screen Replay takes the whole page, under the top bar.
  const wideReplay = stack && layout !== "phone" && !!replayId;
  // Studio's phone layout.
  const phone = layout === "phone" && !stack;
  // No rails: what a wide Studio keeps in them comes up in sheets.
  const sheets = phone || stack;
  const nav = usePhoneRoute(stack);
  // Beside the list a tablet always shows a conversation.
  const level = split ? (nav.route.level === 2 ? 2 : 1) : nav.route.level;
  // The live picture rests in the thread's foot while this task holds the computer.
  const [thumb, setThumb] = useState<HTMLElement | null>(null);
  // Off the computer screen and the foot, a phone asks for no frames. A picture it asked to stop,
  // or hasn't asked for yet, is no news about the computer, which runs on.
  const shownPicture =
    stack && (picture === "suspended" || (picture === "none" && level < 2)) ? "live" : picture;
  const stageAway = stack && !(level === 2 || (level === 1 && !!thumb));
  const hud = hudFor({
    runtimeProblem: runtime.problem,
    cell,
    status,
    pending,
    picture: physicalStageCell === cell ? shownPicture : "none",
    streamed,
  });
  const manualGeometry = selectedScreen?.geometry ?? session.model.screen;
  const railByDefault = useRailExpandedByDefault(layout);
  const mobileScreen = useMobileScreen(phone);
  const panelsButton = useRef<HTMLButtonElement>(null);
  const { panels, update: updatePanels } = usePanelPreferences();
  const railView = panels.view;
  const setRailView = (view: RailView) => updatePanels({ view, chat: true });
  const chatVisible = sheets || panels.chat;
  // A phone shows Activity in a sheet over the thread.
  const [activityOpen, setActivityOpen] = useState(false);
  if (activityOpen && !sheets) setActivityOpen(false);
  // A phone shows the routines in a sheet too.
  const [routinesOpen, setRoutinesOpen] = useState(false);
  if (routinesOpen && !sheets) setRoutinesOpen(false);
  const [routineTarget, setRoutineTarget] = useState<RoutineTarget | null>(null);
  // Read once dot first rests, so its tips know whether there are routines and Open at login.
  const [tipsRead, setTipsRead] = useState(false);
  const routines = useRoutines(
    api,
    guest
      ? "off"
      : railView === "routines" ||
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
  const switchViewNow = useRef(() => {});
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
  const [palette, setPalette] = useState<PalettePage | null>(null);
  const openPalette = useHandler((page: PalettePage) =>
    setPalette((open) => (open === page && page === "actions" ? null : page)),
  );
  const barMore = useMemo(
    () =>
      !sheets && (
        <RowMenu label={t`More`} size={32}>
          <MenuItem icon="search" kbd={["Mod", "K"]} onSelect={() => openPalette("actions")}>
            {t`Search actions`}
          </MenuItem>
          <MenuItem icon="repeat" onSelect={() => showRoutines.current()}>
            {t`Routines`}
          </MenuItem>
          <MenuItem icon="layout-grid" onSelect={() => switchViewNow.current()}>
            {switchViewLabel(viewStyle.value)}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon="stop"
            disabledReason={stopAll.running ? t`Stopping…` : undefined}
            onSelect={() => void stopAll.run()}
          >
            {t`Stop everything`}
          </MenuItem>
        </RowMenu>
      ),
    [sheets, viewStyle.value, stopAll.running, stopAll.run, openPalette],
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
  const settingsBrowser = useBrowserStatus(
    api,
    cell?.state === "ready" && !cell.paused ? cell.id : null,
    settings.open,
  );
  const settingsEngine = useBrowserEngine(api, settings.open);
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
  const yours = !guest && !!takeover && takeover === heldByUser(agent.model);
  useHandOff({
    sessionId: agent.sessionId,
    fresh: agent.fresh,
    offered: yours || guest ? undefined : takeover,
    shown: !replayId && !settings.open,
    canTake: controls.canTake,
    take: controls.take,
  });
  const askDraft = useAskDraft(mine ? question : undefined);
  const answer = useRef(controls.answer);
  answer.current = controls.answer;
  const answerAsk = useCallback((request: QuestionAnswerRequest) => answer.current(request), []);
  const askCell = cell?.state === "ready" && !cell.paused ? cell.id : null;
  const uploadAsk = useMemo<AskUpload | undefined>(
    () =>
      askCell && !guest
        ? (file, signal, options) => uploadFile(api, askCell, file, signal, options)
        : undefined,
    [api, askCell, guest],
  );
  const askReason = controls.canAnswer ? undefined : t`Check the current task before answering.`;
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
  const askFields = useMemo<StageFields | undefined>(() => {
    const marks = askMarks?.filter((mark) => mark.screen === shownScreen);
    return manualGeometry && marks?.length ? { screen: manualGeometry, marks } : undefined;
  }, [askMarks, shownScreen, manualGeometry]);
  const manualLive =
    yours &&
    controls.canInput &&
    physicalStageCell?.state === "ready" &&
    !physicalStageCell.paused &&
    !(shownScreen === "browser" && browserScreen.stale);
  const manual = useManualChannel(
    api,
    manualLive ? agent.sessionId : null,
    manualLive ? (takeover?.requestId ?? null) : null,
    agent.reconcile,
  );
  const { send: sendManual } = manual;
  const routeManual = stageFront.route;
  // A right-click on a phone is for the next tap only.
  const sendToComputer = useCallback(
    (input: Parameters<typeof sendManual>[0]) => {
      sendManual(routeManual(input));
      if (input.kind === "click" && input.button === "right") setPointerMode("click");
    },
    [sendManual, routeManual],
  );
  useEffect(() => {
    if (pasteRefused) showToast({ title: pasteRefused, tone: "danger" });
  }, [pasteRefused]);
  const dotScreen = selectedScreen?.screen ?? "desktop";
  const lastScreen = useRef(dotScreen);
  const dotChose = !!selectedScreen;
  const switchingStage = stageSwitch.active;
  useEffect(() => {
    if (replayId || lastScreen.current === dotScreen) return;
    lastScreen.current = dotScreen;
    // A conversation just taken up shows the screen it was on: dot has not moved. The window coming
    // forward or going back shows the move, so it is only read out.
    const words = switchingStage ? null : screenMoveNote(dotScreen, dotChose);
    if (words) announce("screen", words);
    else withdraw("screen");
  }, [replayId, dotScreen, dotChose, switchingStage]);
  const browserProblem =
    !replayId && shownScreen === "browser" && !browserScreen.cell ? browserScreen.error : undefined;
  useEffect(() => {
    if (browserProblem) showToast({ id: "screen", title: browserProblem, tone: "danger" });
  }, [browserProblem]);
  const shownView: RailView = sheets ? "chat" : railView;
  const guardStart = (anyway = false) => {
    if (
      !controls.stopping &&
      !controls.busy &&
      controls.stopStatus.phase !== "unconfirmed" &&
      (controls.stopStatus.phase !== "stopped" || hud.action.kind === "start") &&
      !agent.model.pendingTakeover
    )
      start(anyway);
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
  const taskStop = useHandler(() => {
    const id = agent.sessionId;
    if (!id || stoppingRunRef.current) return;
    stoppingRunRef.current = id;
    setStoppingRun(id);
    void endTaskRun(api, id, new AbortController().signal)
      .then((messages) => giveBack(id, messages))
      .catch(() => {
        showToast({
          title: t`Couldn't confirm Stop. Check the task and try again.`,
          tone: "danger",
        });
      })
      .finally(() => {
        stoppingRunRef.current = null;
        setStoppingRun(null);
        agent.reconcile();
        session.check();
      });
  });
  useStopHotkey(taskStop, mine && controls.canStop && !controls.stopping && !stoppingRun);
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
        sessionId: agent.sessionId,
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
  const [screenTries, setScreenTries] = useState(0);
  const connection = useStageConnection({
    tries: screenTries,
    computer:
      cell?.state === "ready" &&
      !cell.fenced &&
      !cell.replacementPending &&
      controls.stopStatus.phase !== "stopped"
        ? cell.id
        : null,
    screen: shownScreen,
    picture,
    screenUp: !stageCell || stageCell.state === "ready",
    resting: !!replayId || !!cell?.paused || !!stageCell?.paused || stageAway,
  });
  // The displayed screen owns video visibility. Parent lifecycle controls still
  // use the desktop HUD, even when only the separate browser has a live viewer.
  const stageHud = hudFor({
    runtimeProblem: runtime.problem,
    cell: stageCell,
    status: shownScreen === "browser" && !stageCell ? "listing" : status,
    pending,
    picture: shownPicture,
    viewer: true,
    away: connection.phase === "away" ? connection : null,
  });
  const containedHud =
    controls.stopStatus.phase === "paused" || controls.stopStatus.phase === "stopped"
      ? stageHud
      : withScreenHud(hud, stageHud);
  // Which conversation and task the thread shows is not known yet.
  const threadPending =
    status === "listing" ||
    !conversation.known ||
    !session.known ||
    (status === "known" && conversation.sessions.length > 0 && !session.sessionId);
  // On opening, the page waits on everything it shows that could still change its mind: the
  // computer, setup, the conversation and its task's history. Meanwhile only dot wakes on the
  // curtain; then everything comes in at once (the curtain lifts, the rail slides in, dot flies to
  // its dock and the island fades in). Later tasks start from nothing, so never wait.
  const [opened, setOpened] = useState(false);
  const opening =
    !opened &&
    status !== "unknown" &&
    (!runtime.checked ||
      status === "listing" ||
      setupDone === undefined ||
      threadPending ||
      (!!session.sessionId &&
        (agent.history !== true || (!session.resting && agent.availability === "loading"))));
  if (!opened && !opening && status !== "unknown") setOpened(true);
  const [openingSlow, setOpeningSlow] = useState(false);
  useEffect(() => {
    if (opened) return;
    const timer = setTimeout(() => setOpeningSlow(true), OPENING_NOTICE_MS);
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
  // The page reads the task's time again only when what it shows may change by itself; its timers
  // count on their own (SessionNowContext).
  const sessionTime = useNowMs(
    session.model,
    session.version,
    (t, latest) =>
      shownTask ? nextChange(t, latest, [facts.retry?.atMs, longThinkAt(session.model)]) : null,
    session.clock,
  );
  const now = sessionTime.now;
  const stalled = useTaskStalled(agent, !replayId);
  // A conversation just taken up reads its task's history before the island says how it stands,
  // rather than an empty task's "Working" and "Task interrupted" on the way. Meanwhile it keeps the
  // word of a finished task left behind, which offers nothing to press.
  const readingTask = stageSwitch.active && agent.history !== true;
  const ownTask = shownTask && !readingTask ? taskHud(session.model, now, facts) : null;
  const finishedTask = useRef<typeof ownTask>(null);
  if (!readingTask) finishedTask.current = ownTask?.phase === "finished" ? ownTask : null;
  const task = readingTask ? finishedTask.current : ownTask;
  // From the moment a message is sent to dot at rest until the task's own first word, dot is shown
  // thinking.
  const [sent, setSent] = useState<SentTo | null>(null);
  const sendTarget = useRef<SentTo | null>(null);
  sendTarget.current = sentToRest(session.sessionId, readingTask ? null : task);
  const onSending = useCallback((on: boolean) => setSent(on ? sendTarget.current : null), []);
  // A message sent in the conversation left behind is not this one's. A new conversation's first
  // message is: taking it up is where that message goes.
  if (stageSwitch.active && sent !== null && sent.session !== null) setSent(null);
  // A conversation still reading its history, as a new one is when its first message takes it up,
  // has said nothing yet: the finished task held up meanwhile is the one left behind.
  const sentThinking =
    sent !== null && awaitingWord(sent, session.sessionId, readingTask ? null : task);
  useEffect(() => {
    if (!sent) return;
    if (!sentThinking) {
      setSent(null);
      return;
    }
    const timer = setTimeout(() => setSent(null), SENDING_HOLD_MS);
    return () => clearTimeout(timer);
  }, [sent, sentThinking]);
  const work = footWork(sentThinking ? SENT_THINKING : task);
  const foot =
    work && atWork(work.row)
      ? { ...work, label: narrationLine(work.row, work.caption, session.model, now) }
      : work;
  // The daemon refuses an Update in these cases too; the button says so before it is pressed.
  const updateWait =
    agent.snapshot?.holder === true || yours
      ? t`Hand back the computer first`
      : task && task.phase !== "finished"
        ? t`Wait for dot to finish`
        : undefined;
  const appUpdate = useAppUpdate(api, hud.phase === "live" && !updateWait, () => {
    settings.show();
    setSettingsAt((previous) => ({ section: "computer", request: previous.request + 1 }));
  });
  useUpdateNotice(cell, !guest && hud.phase === "live" && !updateWait, computerUpdate);
  useUpdateProgressNotice(cell, computerUpdate, () => {
    settings.show();
    setSettingsAt((previous) => ({ section: "computer", request: previous.request + 1 }));
  });
  const taskStatus = agent.snapshot?.status;
  const recoveryWait =
    taskStatus === "paused" &&
    !agent.snapshot?.pause &&
    !agent.model.pendingAsk &&
    !agent.model.pendingTakeover &&
    !agent.snapshot?.approval;
  const conversationReason = conversationBlockReason(!!stoppingRun);
  const computer = error ? { ...containedHud, caption: error } : containedHud;
  // A task feed out of touch for a moment says nothing; one that stays out says so in the island.
  const linkLost = useHeldFor(
    !!session.sessionId && (agent.connection === "lost" || agent.availability === "error"),
    LINK_LOST_MS,
    true,
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
    canStop: mine && controls.canStop,
    link: linkLost ? "lost" : null,
    letGo: controls.fenced || !!agent.model.pendingTakeover || !!agent.snapshot?.pendingTakeover,
  });
  const appStatus = withSending(baseStatus, sentThinking);
  // The sheets offer Shut down, which the island leaves out; on a phone, where a sheet covers the
  // island, the task's Stop too.
  const sheetStop = appStatus.actions.find(
    (action) => action.kind === "stop" || (sheets && action.kind === "stop-task"),
  );
  const stopped = stopNotice(controls.stopStatus);
  const stopNote = stopped ? { line: stopped.title, details: stopped.details } : undefined;
  const sheetStopControl = sheetStop && {
    label: sheetStop.kind === "stop" ? t`Shut down` : sheetStop.busy ? t`Stopping…` : t`Stop`,
    task: sheetStop.kind === "stop-task",
    enabled: sheetStop.enabled,
    run: sheetStop.kind === "stop" ? guardComputerStop : taskStop,
  };
  // The model is folded in place, so its steps' revision is what changes: every step of a long task
  // is not listed again for each thing dot says.
  const stepsAt = stepsRevision(session.model);
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const rows = useMemo(
    () => (session.sessionId ? timelineRows(stepRows(session.model), session.model.keyUses) : []),
    [session.sessionId, session.model, stepsAt],
  );
  const historyStepsAt = stepsRevision(historySession.model);
  // biome-ignore lint/correctness/useExhaustiveDependencies: history is folded in place too
  const historyRows = useMemo(
    () => timelineRows(stepRows(historySession.model), historySession.model.keyUses),
    [historySession.model, historyStepsAt],
  );
  const keyUses = session.model.keyUses;
  const uses = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const use of keyUses)
      if (use.decision === "allow") counts[use.secretId] = (counts[use.secretId] ?? 0) + 1;
    return counts;
  }, [keyUses]);
  const savedLogins = useSavedLogins(
    api,
    settings.open && keys.health?.savedLogins === true && !vaultLocked(keys.health),
    `${keys.health?.bootId}/${keys.health?.vault?.state}`,
  );
  const keysPanel = {
    keys,
    logins: keys.health?.savedLogins ? savedLogins : undefined,
    intakeRef: keysIntake,
    preset: keyPreset,
    reenter: keyReentry,
    uses,
    onSaved: (key: KeyRecord, request: number) => {
      const context = keyCapture.current;
      if (context?.request === request) void settings.keySaved(context.capture, key);
    },
  };
  // A shared link hears no app events: its list is read again as its own tasks come and go.
  const guestTask = guest ? `${session.sessionId}:${session.ended}:${guest.grant.tasks}` : null;
  useEffect(() => {
    if (guestTask) readConversationsAgain(api);
  }, [guestTask, api]);
  const fresh =
    conversation.known && !conversation.sessions.length && !session.sessionId && !switching;
  const newConversation: NewConversation = {
    run: () => {
      void choose(null);
      setRailView("chat");
      if (stack) nav.show("new");
    },
    reason: conversationReason ?? (fresh ? ALREADY_NEW : undefined),
  };
  const curtain = useCurtain(opening ? "checking" : appStatus.computer, !!replayId);
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  // This task holds the computer: its light, the thumbnail at the thread's foot and the live picture.
  const holding = !curtain.up && (appStatus.control || yours);
  useStopToast(controls.stopStatus, controls.recheck, curtain.up);
  const sharedLook = useSharedLook(
    api,
    session.resting ? null : session.sessionId,
    session.model.observes.findLast((look) => look.screen === "desktop")?.frameId ?? null,
    !replayId &&
      shownScreen === "desktop" &&
      !!session.screenHolder &&
      session.screenHolder !== session.sessionId,
  );
  // A conversation just taken up is settled once its thread is on show, the computer has said what
  // it runs, and the task's history (and, while it runs, its status) says which screen it shows.
  const stageCover = stageSwitch.see({
    settled:
      !switching &&
      session.answered &&
      (!session.sessionId ||
        (agent.history === true && (session.resting || agent.availability !== "loading"))),
    presented: picture === "live" && !sharedLook.waiting,
    yielded: curtain.up || !!replayId || mobileScreen.minimized || (sheets && settings.open),
  });
  // The computer as it is, which is what a conversation at rest or a new one shows: taking one up
  // keeps the picture rather than covering it.
  const plainDesktop =
    shownScreen === "desktop" && picture === "live" && !sharedLook.url && !curtain.up && !replayId;
  stageSwitchFacts.current = (to) => {
    const entry = to ? knownConversation(api, to) : undefined;
    return {
      title: to ? entry && conversationTitle(entry) : NEW_TITLE,
      same: plainDesktop && (to === null || (!!entry && !entry.live)),
    };
  };
  const stageBox = useRef<HTMLDivElement>(null);
  const fullScreen = useFullScreen({
    available: !curtain.up && !replayId && !stack,
    phone,
    frame: stageBox,
  });
  // Studio's phone shows full screen as focus mode, and Chat's computer screen is its full screen;
  // a wider screen gives the stage the whole screen.
  const full = fullScreen.on && !sheets;
  // Turning the computer on and off is the owner's.
  const computerAction = guest
    ? undefined
    : appStatus.actions.find(
        (action): action is HudAction & { kind: HudActionKind } => action.kind !== "stop-task",
      );
  const onComputer = {
    start: () => guardStart(),
    stop: guardComputerStop,
    resume: guardResume,
    retry,
  };
  const keyboard = useKeyboardUp(!stack);
  const setupKnown = !!settings.saved;
  const onboarding = useOnboarding({
    known: setupKnown,
    configured: !!settings.saved?.main,
    replaying: !!replayId,
  });
  // Followed from here so a download started in setup or on another device shows wherever it's read.
  const speechInstall = useSpeechInstall(api, onboarding.open || settings.open);
  const setupStep = onboarding.progress.step;
  const previewRoom = useMediaQuery(PREVIEW_ROOM) && layout !== "phone";
  const place = stack
    ? phonePresencePlace({
        showDot: showDot.value,
        setup: onboarding.open,
        replaying: !!replayId,
        browsing: replayId === LIBRARY && !previewRoom,
        opening,
        level,
        curtain: curtain.up,
      })
    : presencePlace({
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
      ? t`Signed in`
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
    permissions: savedAutonomy ? (presetOf(savedAutonomy)?.label ?? t`Your own choices`) : null,
    persona: settings.saved?.persona ? personaName(personaOf(settings.saved.persona).id) : null,
    computer: !!cell || listed.length > 0,
  });
  const keysState = useMemo(() => keyStatus(keys.health), [keys.health]);
  const chatgptReady = settings.chatgpt.canStart;
  const claudeReady = settings.claudeCode.canStart;
  // The conversation's own model, else the default its next task starts on.
  const taskModel = useTaskModel(
    api,
    conversation.known && !guest ? (conversation.sessions.at(-1) ?? null) : null,
  );
  const taskChoice = taskModel.choice ?? mainChoice;
  const modelChoices = useMemo(
    () =>
      guest
        ? guestModelGroups(guest.grant)
        : modelGroups(
            settings.saved,
            providerIndex,
            {
              chatgpt: { ready: chatgptReady, models: accountModels },
              claudeCode: { ready: claudeReady, models: claudeModels },
            },
            names,
            taskChoice,
          ),
    [
      guest,
      settings.saved,
      providerIndex,
      chatgptReady,
      accountModels,
      claudeReady,
      claudeModels,
      names,
      taskChoice,
    ],
  );
  // The model being saved, which the chip shows meanwhile.
  const [modelSaving, setModelSaving] = useState<ModelOption | null>(null);
  const [phoneModels, setPhoneModels] = useState(false);
  const phoneModelsAnchor = useRef<HTMLElement | null>(null);
  const taskModels = agent.snapshot?.models;
  const runtimeOf = (provider: string | undefined) =>
    provider === "chatgpt" || provider === "claude-code" ? provider : "api";
  const running = !agent.model.ended ? taskModels?.kind : undefined;
  // The chosen model runs elsewhere than this task's agent: the next message starts a task on it.
  const runtimeMoved = !!taskChoice && !!running && runtimeOf(taskChoice.provider) !== running;
  // A task at work finishes what it is doing unless a message says otherwise.
  const taskWorking =
    !!taskModels && !agent.model.ended && agent.snapshot?.status !== "idle" && !recoveryWait;
  const runningOn =
    taskModels?.kind === "api"
      ? taskModels.roles.find((role) => role.role === "main")
      : taskModels?.kind === "chatgpt" || taskModels?.kind === "claude-code"
        ? taskModels
        : undefined;
  const modelDiffers =
    !!taskChoice &&
    !!runningOn &&
    (runtimeMoved ||
      ("provider" in runningOn && runningOn.provider !== taskChoice.provider) ||
      runningOn.model !== taskChoice.model ||
      !sameModelOptions(runningOn.options, taskChoice.options));
  const modelNext = taskWorking && modelDiffers;
  // A link's follow-ups keep the task's model, so another model of its starts a task of its own.
  const modelChanged = guest ? modelDiffers : runtimeMoved;
  const planUsage = usePlanUsage(
    api,
    settings.chatgpt.canStart || settings.claudeCode.canStart,
    taskWorking,
  );
  const modelLabel = guest
    ? guestModelName(guest.grant, guest.grant.model)
    : (modelSaving?.name ?? (taskChoice ? names.name(taskChoice.provider, taskChoice.model) : ""));
  const chooseModel = useHandler(async (option: ModelOption) => {
    setModelSaving(option);
    const saved = guest
      ? await api
          .post("/api/remote-session/model", {
            index: guest.grant.models.findIndex((choice) => optionId(choice) === option.id),
            options: option.choice.options ?? null,
          })
          .then(() => guest.refresh())
          .then(
            () => true,
            () => false,
          )
      : await taskModel.choose(option.choice);
    setModelSaving(null);
    if (!saved) {
      showToast({
        title: t`Couldn't switch to ${option.name}`,
        description: t`Try again.`,
        tone: "danger",
      });
      return;
    }
    announce("model", t`dot uses ${option.name} from your next message.`);
  });
  const currentModel = modelSaving?.id ?? (taskChoice ? optionId(taskChoice) : undefined);
  const modelMenu = useMemo(
    () => ({
      groups: modelChoices,
      choice: taskChoice,
      runtime: running,
      outputLimit: (choice: import("@localdot/protocol").AgentRoleChoice) =>
        providerIndex?.providers
          .find((provider) => provider.id === choice.provider)
          ?.models.find((model) => model.id === choice.model)?.maxOutputTokens ?? 4096,
      current: currentModel,
      working: taskWorking,
      onChoose: (option: ModelOption) => void chooseModel(option),
      usage: planUsage,
    }),
    [
      modelChoices,
      taskChoice,
      running,
      providerIndex,
      currentModel,
      taskWorking,
      chooseModel,
      planUsage,
    ],
  );
  // The composer's parts, kept from one render to the next so the composer draws only for its own.
  const browseAccounts = useHandler(() => {
    settings.browseAccounts();
    planUsage.refresh();
  });
  const modelChip = useMemo(
    () =>
      taskChoice && (
        <ModelChip
          {...modelMenu}
          name={modelLabel}
          next={modelNext}
          disabledReason={
            modelSaving ? t`Saving…` : guest && !guest.grant.chooseModel ? FIXED_MODEL : undefined
          }
          onPeek={guest ? undefined : browseAccounts}
          onManage={guest ? undefined : showModels}
        />
      ),
    [guest, taskChoice, modelMenu, modelLabel, modelNext, modelSaving, browseAccounts, showModels],
  );
  const permissionMode = settings.saved?.permissionMode ?? "custom";
  const choosePermissions = useHandler((mode: typeof permissionMode) => {
    void settings.choosePermissions(mode).then((saved) => {
      if (!saved) showToast({ title: t`Couldn't save permissions`, tone: "danger" });
    });
  });
  const permissionChip = useMemo(
    () => (
      <PermissionChip value={permissionMode} busy={settings.busy} onChoose={choosePermissions} />
    ),
    [permissionMode, settings.busy, choosePermissions],
  );
  const stoppable =
    mine &&
    !!agent.sessionId &&
    !agent.model.ended &&
    agent.snapshot?.status !== "idle" &&
    agent.snapshot?.status !== "ended";
  const stopAction = useMemo(
    () =>
      stoppable
        ? {
            kind: "stop" as const,
            run: taskStop,
            disabledReason: stoppingRun ? t`Stopping…` : undefined,
          }
        : undefined,
    [stoppable, taskStop, stoppingRun],
  );
  const wide = layout === "wide";
  const views: SegmentItem[] = [
    {
      value: "chat",
      label: t`Chat`,
      attention: shownView !== "chat" && !!agent.model.pendingAsk,
    },
    ...(phone ? [] : [{ value: "activity", label: PANEL_NAME }]),
    ...(phone ? [] : [{ value: "routines", label: t`Routines` }]),
  ];
  showRoutines.current = () => {
    if (replayId) selectReplay(null);
    setRailView("routines");
  };
  // The servers dot starts in its computer, opened on the owner's devices from what it printed.
  const previews = usePreviewsState(
    api,
    viewedConversation
      ? (viewedConversation.sessions.at(-1) ?? viewedConversation.id)
      : (agent.sessionId ?? conversation.sessions.at(-1) ?? null),
    {
      openSettings: (trigger) => showSettings(trigger, "computer"),
      update: updateWait ? { ...computerUpdate, waitReason: updateWait } : computerUpdate,
    },
  );
  const activity = (
    <ActivityRail
      previews={previews}
      cellId={viewedConversation ? undefined : cell?.id}
      releaseReady={
        !viewedConversation &&
        cell?.state === "ready" &&
        !cell.paused &&
        !cell.fenced &&
        !cell.replacementPending
      }
      models={(viewedConversation ? historyAgent : agent).snapshot?.models}
      modelName={names.name}
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
        chatShown: shownView === "chat" || sheets,
      });
  const approvalView = approval && decision === "approval" && (
    <ApprovalDecision
      key={`${approval.approvalId}:${approval.generation}:${approval.revision}`}
      card={approval}
      enabled={safety.canApprove}
      pending={safety.pending === "approval"}
      onDecision={safety.answerApproval}
      loadField={safety.readApprovalField}
      layout={sheets ? "sheet" : "island"}
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
          saveKey={keys.save}
          connectApi={api}
          reason={askReason}
          upload={uploadAsk}
          receiveKey={receiveKey}
          quick={stack}
        />
      ) : undefined,
    [askDraft, askIn, answerAsk, askReason, uploadAsk, receiveKey, keys.save, api, stack],
  );
  // What the task is waiting on the user to fix, as its own log says on every device.
  const fixes = fixesToShow(agent.fixes ?? [], keys.health);
  // What dot waits on the user for, which any message of theirs moves on from.
  const dotWait: DotWait | undefined = askDraft
    ? asksPrivate(askDraft.fields)
      ? "private"
      : "question"
    : stepApproval
      ? "approval"
      : takeover && takeover.by !== "user"
        ? "computer"
        : fixWait(fixes);
  // Whichever wait the message box says it moves on from, a field for a secret may be up beside it.
  const secretField = (!!askDraft && asksPrivate(askDraft.fields)) || fixes.some(takesSecret);
  // What a task's decision must not stay behind when a notification opens it.
  const uncover = () => {
    selectReplay(null);
    if (settings.open) settings.close();
    setConversationsOpen(false);
  };
  const openSession = useOpenSession({
    known: session.known && !conversation.busy && !stoppingRun,
    sessionId: agent.sessionId,
    decision:
      approvalView && approval
        ? `approval-${approval.approvalId}`
        : askDraft && askIn
          ? `ask-${askDraft.question.askId}`
          : null,
    // While the user holds the computer a task opens to read, as picking it from the list does. A
    // routine's run, however old, opens in the routine's one conversation.
    take: async (id) => {
      const to = (await conversationOfRun(api, id)) ?? id;
      if (yours) setViewedConversation(to === currentTask ? null : { id: to, sessions: [to] });
      else if (to !== currentTask && !(await choose(to))) return false;
      setRailView("chat");
      uncover();
      if (stack) nav.show(id);
      return true;
    },
    select: (id) => {
      if (id) {
        selectReplay(id);
        return;
      }
      setViewedConversation(null);
      uncover();
      if (stack && nav.route.level === 0) nav.push({ level: 1, id: "current" });
    },
  });
  const attention = useAttention(api, openSession);
  useEffect(() => listenForSessionLinks(openSession), [openSession]);
  useEffect(
    () => listenForSettingsLinks(({ section, tip }) => goToSettings(null, section, tip)),
    [goToSettings],
  );
  // Over a phone's list no task is on screen.
  const viewing =
    replayId === LIBRARY
      ? null
      : (replayId ?? (stack && level === 0 ? null : (agent.sessionId ?? null)));
  useSeenReporting(api, attention.items, viewing);
  useAttentionToasts(attention.latest, { viewing, island: !replayId && !stack }, openSession);
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
  const currentTask = conversation.sessions.at(-1) ?? null;
  const openComputer = () => nav.push({ level: 2, id: nav.route.id ?? currentTask ?? "current" });
  const liveFacts = useMemo(
    () => ({
      // Until the task on show is read, its conversation's latest task stands for it, and it is
      // not said to be at work.
      live: session.sessionId ? (session.ended ? null : session.sessionId) : currentTask,
      idle: taskStatus === undefined || taskStatus === "idle",
      activity: foot?.label,
      needsYou,
    }),
    [session.sessionId, session.ended, currentTask, taskStatus, foot?.label, needsYou],
  );
  const takeUpConversation = (id: string, sessions?: readonly string[]) => {
    setRailView("chat");
    if (yours) {
      setViewedConversation(id === currentTask ? null : { id, sessions: sessions ?? [id] });
      return;
    }
    setViewedConversation(null);
    if (id === currentTask) return;
    // Refused, the conversation that stays current is the one to show: the address follows.
    void choose(id).then((done) => {
      const at = parsePhoneRoute(window.location.hash);
      if (!done && stack && at.level > 0 && at.id === id)
        nav.replace({ level: at.level, id: currentTask ?? "new" });
    });
  };
  const pickConversation = (id: string, sessions?: readonly string[]) => {
    takeUpConversation(id, sessions);
    if (stack) nav.show(id);
  };
  const openRunConversation = (id: string) => {
    if (replayId) selectReplay(null);
    pickConversation(id);
  };
  const overviewShown = overviewOpen && !replayId && !onboarding.open;
  const overviewList = useRecentConversations(api, overviewShown);
  const overviewRows = useMemo(
    () => conversationRows(overviewList.entries, liveFacts),
    [overviewList.entries, liveFacts],
  );
  const openOverview = useHandler(() => {
    if (fullScreen.on) fullScreen.exit();
    showOverview(true);
  });
  const closeOverview = useHandler(() => showOverview(false));
  // Once opened it stays, out of sight, so coming back finds it as it was left.
  const [overviewMounted, setOverviewMounted] = useState(overviewShown);
  if (overviewShown && !overviewMounted) setOverviewMounted(true);
  const railOverview = useMemo(
    () => ({ open: overviewShown, onOpen: openOverview }),
    [overviewShown, openOverview],
  );
  // A tile opens its conversation in an entry of its own, so Back comes back to the overview.
  const openFromOverview = useHandler((row: ConversationRow) => {
    const id = row.entry.sessionId;
    const address = new URL(window.location.href);
    address.searchParams.delete(OVERVIEW);
    if (stack) address.hash = phoneHash({ level: 1, id });
    window.history.pushState(stack ? { phone: 1 } : null, "", address);
    setOverviewOpen(false);
    if (!stack) return pickConversation(id, row.entry.sessions);
    takeUpConversation(id, row.entry.sessions);
    nav.asked.current = id;
    nav.replace({ level: 1, id });
  });
  const conversationList = {
    api,
    current: switching ? switching.to : (viewedConversation?.id ?? currentTask),
    facts: liveFacts,
    reason: yours ? undefined : conversationReason,
    onPick: pickConversation,
    onDeleted: (ids: readonly string[]) => {
      if (viewedConversation && ids.includes(viewedConversation.id)) setViewedConversation(null);
      conversation.reload();
    },
    onReplay: () => selectReplay(LIBRARY),
  };
  // The current conversation, asked about from the palette before it is deleted.
  const [deletingCurrent, setDeletingCurrent] = useState<{
    sessionId: string;
    sessions: readonly string[];
  } | null>(null);
  const deleteFrom = useRef<HTMLElement | null>(null);
  // The conversations rail, beside the stage while Watch shows on anything wider than a phone.
  const railShown = !sheets && !replayId && !full && !onboarding.open;
  const railExpanded = panels.sessions ?? railByDefault;
  const pickFromRail = useHandler(pickConversation);
  const newFromRail = useHandler(newConversation.run);
  const deletedFromRail = useHandler(conversationList.onDeleted);
  const expandRail = useHandler((sessions: boolean) => updatePanels({ sessions }));
  const askOver = (layout: "island" | "sheet") =>
    askDraft && (
      <AskForm
        key={askDraft.question.askId}
        draft={askDraft}
        layout={layout}
        answer={answerAsk}
        saveKey={keys.save}
        connectApi={api}
        reason={askReason}
        upload={uploadAsk}
        receiveKey={receiveKey}
      />
    );
  const grown =
    sheets || !decision
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
  const takeState: TakeSlot = takeSlot(appStatus, {
    decision: stepDecision,
    blocked: takeBlocked,
    taking: controls.taking,
  });
  const confirming = agent.snapshot?.manualControl === "unconfirmed";
  const handBack = useHandBack({ takeover, controls, drained: manual.drained });
  const inputBlocked = manualLive ? undefined : t`Wait for the computer to be ready`;
  // A paused computer keeps its last picture, with no curtain, so in Chat a notice offers its Resume.
  const pausedNotice = stack && level < 2 && appStatus.computer === "frozen";
  const noticed = curtain.up || pausedNotice;
  // The curtain speaks while it is up; under it the band is quiet. On a phone, where the decision
  // is a sheet below, dot asks it aloud.
  const narration = noticed
    ? ""
    : sheets && approvalView && approval
      ? decisionWords(approval).line
      : yours && confirming
        ? CONFIRMING_LINE
        : yours && sheets
          ? PHONE_CONTROL_LINE
          : stalled
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
  const speaker = (sheets && approvalView) || yours ? "dot" : appStatus.caption.speaker;
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
  const voice = VOICES[taskDot ?? settings.saved?.persona ?? DEFAULT_PERSONA];
  const idle = useIdleLine({
    resting,
    // The picture coming back, after Replay or a dropped stream, until the curtain has lifted off
    // it, is no task: dot keeps its line for when the stage is back.
    suspended: !!replayId || onboarding.open || pictureAway(appStatus.computer) || curtain.lifting,
    held: pageHidden || overBand || settings.open || !!guest,
    voice,
    signals: {
      touch: touch || sheets,
      view: viewStyle.value,
      viewsTried: viewStyle.tried,
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
      case "view":
        return switchViewNow.current();
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
    !curtain.up && !replayId && !stack,
    !!question || mobileScreen.minimized,
    fullScreen.on && phone,
  );
  const touchStill = useStill(focus);
  const edgeStill = useEdgeStill(full);
  // A decision grown out of the island fades with it, so the island stays while one is out: an
  // app's connection card while the user holds the computer has no attention of its own.
  const still = (touchStill || edgeStill) && !islandAttention(appStatus) && !grown;
  useFullScreenKeys({
    enabled: !sheets && !curtain.up && !replayId,
    apple: isApple(),
    full,
    yours,
    enter: fullScreen.enter,
    exit: fullScreen.exit,
  });
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
  useViewportFit(page, !stack);
  useChatFit(page, stack);
  // The top bar's parts, kept from one render to the next so the bar draws only when they change.
  const saved = settings.saved;
  const brand = useMemo(
    () =>
      saved ? (
        <LocalDotSwitcher
          name={saved.name}
          others={otherLocalDots.list}
          here={localDots}
          onOpen={otherLocalDots.open}
          onManage={(trigger) => goToSettings(trigger, "dot")}
          onAddHere={(trigger) => goToSettings(trigger, "computer")}
        />
      ) : undefined,
    [saved, otherLocalDots, localDots, goToSettings],
  );
  const chooseMode = useHandler((mode: "watch" | "replay") =>
    selectReplay(mode === "watch" ? null : LIBRARY),
  );
  const chooseModeAgain = useHandler(() => {
    if (playing) selectReplay(LIBRARY);
  });
  const openKeys = useHandler(() => showKeys(keysButton.current));
  const toggleChat = useHandler(() =>
    updatePanels({ chat: !chatVisible, ...(!chatVisible ? { view: "chat" } : {}) }),
  );
  const panelsToggle = useMemo(
    () =>
      !sheets &&
      !replayId &&
      !overviewShown && (
        <ChatToggle buttonRef={panelsButton} chat={chatVisible} onChat={toggleChat} />
      ),
    [sheets, replayId, overviewShown, chatVisible, toggleChat],
  );
  const aside = useAside(api, agent.sessionId ?? null);
  const usageShown = aside.aside?.kind === "usage";
  const watchUsage = planUsage.watch;
  useEffect(() => (usageShown ? watchUsage() : undefined), [usageShown, watchUsage]);
  usePaletteKeys(openPalette, !onboarding.open && !guest);
  const nothing = () => {};
  const showView = (view: "chat" | "activity" | "routines") => {
    if (replayId) selectReplay(null);
    if (!sheets) return setRailView(view);
    setActivityOpen(view === "activity");
    setRoutinesOpen(view === "routines");
  };
  const otherDots = useMemo(
    () => [
      ...(localDots.dots ?? [])
        .filter((dot) => !dot.self)
        .map((dot) => ({ id: dot.id, name: dot.name, open: () => switchToDot(localDots, dot) })),
      ...otherLocalDots.list.map((link) => ({
        id: link.url,
        name: link.name,
        open: () => otherLocalDots.open(link.url),
      })),
    ],
    [localDots, otherLocalDots],
  );
  const commands = useActions({
    api,
    phone: sheets,
    sessionId: agent.sessionId ?? null,
    stop: {
      reason: stopAction?.disabledReason ?? (stopAction ? undefined : t`Nothing is running`),
      run: taskStop,
    },
    continue: safety.canResume
      ? { run: () => void safety.resume() }
      : agent.interrupted && !controls.fenced
        ? {
            reason:
              cell?.state === "ready" && !cell.paused ? undefined : t`Turn on your computer first`,
            run: () => void carryOn(),
          }
        : agent.model.state?.state === "idle" && agent.model.state.reason === STALL.actionLimit
          ? { run: () => void continueTask() }
          : controls.canResumeTask
            ? { run: () => void (modelDiffers && recoveryWait ? carryOn() : controls.resume()) }
            : { reason: t`Nothing is paused`, run: nothing },
    take: { reason: yours ? t`You have the computer` : takeBlocked, run: take },
    handBack: {
      reason: yours ? handBack.slot.reason : t`dot has the computer`,
      run: () => void handBack.run(),
    },
    research: researchWait(agent),
    aside,
    newConversation,
    conversations: {
      reason: conversationList.reason,
      current: currentTask,
      facts: liveFacts,
      pick: pickConversation,
      renamed: conversation.reload,
      remove: (trigger) => {
        if (!currentTask) return;
        deleteFrom.current = trigger;
        setDeletingCurrent({ sessionId: currentTask, sessions: conversation.sessions });
      },
    },
    replay: {
      reason: hasRecordings ? undefined : t`No recordings yet`,
      run: () =>
        selectReplay(
          agent.sessionId && (agent.model.ended || task?.phase === "finished")
            ? agent.sessionId
            : LIBRARY,
        ),
    },
    watch: {
      reason: replayId ? undefined : t`You're watching already`,
      run: () => selectReplay(null),
    },
    overview: {
      reason: overviewShown ? t`The overview is on show already` : undefined,
      run: openOverview,
    },
    models: {
      groups: modelChoices,
      current: currentModel,
      reason: !mainChoice
        ? t`Choose a model in Settings first`
        : modelSaving
          ? t`Saving…`
          : undefined,
      choose: chooseModel,
    },
    persona: {
      value: settings.saved?.persona ?? DEFAULT_PERSONA,
      choose: (persona) => void settings.choosePersona(persona),
    },
    plans: settings.chatgpt.canStart || settings.claudeCode.canStart,
    refreshUsage: planUsage.refresh,
    report: (trigger, title) =>
      report.start(trigger, {
        title: title ?? (agent.sessionId ? t`This task` : "localDot"),
        context: agent.sessionId
          ? { kind: "task", sessionId: agent.sessionId }
          : { kind: "general" },
      }),
    view: showView,
    files: {
      reason:
        agent.model.results.length || agent.model.changes.length ? undefined : t`No files yet`,
      run: () => {
        showView("activity");
        showActivityTab("files");
      },
    },
    previews: {
      reason: agent.sessionId ? undefined : t`Start a task first`,
      run: () => {
        showView("activity");
        showActivityTab("previews");
      },
    },
    chatPanel: sheets ? undefined : { shown: chatVisible, toggle: toggleChat },
    fullScreen: {
      on: stack ? level === 2 : fullScreen.on,
      reason: curtain.up || replayId ? t`Turn on your computer first` : undefined,
      run: stack ? openComputer : fullScreen.on ? fullScreen.exit : fullScreen.enter,
    },
    settings: (trigger, section) => goToSettings(trigger, section),
    appearance,
    viewStyle: { label: switchViewLabel(viewStyle.value), run: () => switchViewNow.current() },
    otherDots,
    stopAll: { reason: stopAll.running ? t`Stopping…` : undefined, run: () => void stopAll.run() },
    newRoutine: (trigger) => newRoutine(trigger ?? undefined),
    shortcuts: () => setPalette("shortcuts"),
  });
  const dotChooser = (
    <DotChooser
      open={choosingDot}
      anchor={dotAnchor}
      value={settings.saved?.persona ?? DEFAULT_PERSONA}
      accessory={accessory}
      onChange={(persona) => void settings.choosePersona(persona)}
      auto={{
        on: settings.saved?.autoPersona === true,
        onChange: (on) => void settings.chooseAutoPersona(on),
        disabledReason: autoDotReason(settings.saved?.main),
      }}
      onClose={() => setChoosingDot(false)}
    />
  );
  // Dot's web browser isn't up: there is no stream to retry, while the desktop has its own.
  const browserDown = shownScreen === "browser" && physicalStageCell?.state !== "ready";
  const curtainView = (
    <Curtain
      phase={curtain.phase}
      runtimeProblem={runtime.problem}
      onRuntimeRetry={runtime.check}
      first={!cell && listed.length === 0}
      waking={pending === "start" || pending === "create"}
      updating={!!cell?.updating}
      updateLine={computerUpdate.line}
      updateNote={computerUpdate.note}
      updateBounds={
        cell?.updateProgress
          ? stageBounds(cell.updateProgress.stage, cell.updateProgress.share)
          : null
      }
      updateFailure={computerUpdate.failure?.message}
      caption={computer.caption}
      notice={error ?? stoppedOff(controls.stopStatus)}
      onReload={opening && openingSlow ? () => window.location.reload() : undefined}
      action={computerAction}
      onAction={() => computerAction && onComputer[computerAction.kind]()}
      startAnyway={startAnyway && !guest ? () => guardStart(true) : undefined}
      replace={
        cell?.fenced && !guest
          ? {
              enabled: safety.canReplace,
              busy: safety.replacing,
              note: replacementNotice(safety.replacement, safety.error),
              run: () => void safety.replace(),
            }
          : undefined
      }
      freshStart={guest ? undefined : freshStart.curtain}
      operation={operation}
      ready={curtain.lifting}
      showDot={showDot.value}
      stuck={
        connection.phase === "first" && connection.long
          ? {
              browser: browserDown,
              retry() {
                setScreenTries((tries) => tries + 1);
                if (browserDown) stageFront.pick("desktop");
                else stage.current?.retryStream();
              },
            }
          : undefined
      }
    />
  );
  // The conversation on show, by the entry the list read for it.
  const shownId = viewedConversation?.id ?? (switching ? switching.to : currentTask);
  const shown = usePhoneConversation(
    api,
    shownId,
    switching ? NO_SESSIONS : (viewedConversation?.sessions ?? conversation.sessions),
    liveFacts,
    shownId && shownId === session.sessionId ? taskDot : undefined,
    worn,
  );
  // What dot wears on show, the conversation's own look as its row wears it, and whether all that
  // decides it has answered: this localDot's settings, which conversation and task are on show,
  // what the task works as and the list's entry for it, with the address it was reached by.
  const dotLook = onboarding.open ? worn : shown.look;
  const dotAddress = stack && nav.route.level > 0 ? (nav.route.id ?? null) : null;
  const taskDotKnown =
    !threadPending && (!session.sessionId || !!worksAs || agent.history === true);
  const shownAsAddressed =
    !dotAddress ||
    dotAddress === "current" ||
    (dotAddress === "new"
      ? !shownId
      : shownId === dotAddress || conversation.sessions.includes(dotAddress));
  const shownDotKnown =
    conversation.known &&
    !shown.listing &&
    shownAsAddressed &&
    (!!shown.entry || !shownId || taskDotKnown);
  const recordingDotKnown = useHasReplayPresence();
  const openingOnRecording = !!replayId && replayId !== LIBRARY;
  const dotArrival = useDotArrival({
    view: viewStyle.value,
    address: dotAddress,
    task: shownId ?? null,
    look: dotLook,
    remember: !openingOnRecording,
    known:
      ownDotKnown && (openingOnRecording ? recordingDotKnown : onboarding.open || shownDotKnown),
  });
  const [flyer] = useState(() => new Flyer());
  const flightFrom = useRef<HTMLElement | null>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const monitorButton = useRef<HTMLButtonElement>(null);
  const tuck = useDotTuck({ showDot, flyer, more: moreButton, look: shown.look });
  const [listHidden, setListHidden] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [dotMenu, setDotMenu] = useState(false);
  const [dressing, setDressing] = useState<ConversationEntry | null>(null);
  // Going back leaves what had opened over the screen it left: Safari's own Back knows of no sheet.
  const levelShown = useRef(level);
  useEffect(() => {
    if (level < levelShown.current) {
      setActivityOpen(false);
      setDetailsOpen(false);
      setPhoneModels(false);
      setDotMenu(false);
      setDressing(null);
    }
    levelShown.current = level;
  }, [level]);
  // A link has no list to be on.
  // A link opens on its latest conversation, with its list under it.
  const guestLands = useRef(!!guest && stack && !split && nav.route.level === 0);
  useEffect(() => {
    if (!guestLands.current) return;
    guestLands.current = false;
    nav.enter("current");
  }, [nav]);
  usePhoneAddress({
    on: stack,
    nav,
    known: conversation.known,
    sessions: conversation.sessions,
    current: currentTask,
    settling: !!switching || choosing || !!viewedConversation,
    // A link can't take up another conversation: it stays on the one on show.
    takeUp: takeUpConversation,
    startNew: () => void choose(null),
  });
  // Taking the computer goes to it.
  const wasYours = useRef(yours);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the computer changing hands moves here.
  useEffect(() => {
    if (stack && yours && !wasYours.current && nav.route.level === 1) openComputer();
    wasYours.current = yours;
  }, [stack, yours]);
  const taskTime =
    appStatus.timer || appStatus.elapsedS !== null ? (
      <TaskTime timer={appStatus.timer} elapsedS={appStatus.elapsedS} />
    ) : undefined;
  // The conversation's foot has no island to say how dot stands, so while it thinks with nothing
  // to say yet it says that, and a message just sent takes the greeting away at once.
  const footLine = appStatus.row === "thinking" && !bandLine ? THINKING_LINE : bandLine;
  const phoneBand = (
    <NarratorBand
      // dot's question is on show in the thread, nothing in it hidden; the foot says whose move it is.
      line={askDraft && narration === asked ? t`Your call.` : footLine}
      speaker={bandSpeaker}
      forUser={hearing || sentThinking || !atWork(appStatus.row)}
      showDot={showDot.value}
      idle={!hearing && !!idle}
      action={
        hearing || !tipAction
          ? undefined
          : { label: tipAction.label, run: (trigger) => openTip(tipAction, trigger) }
      }
      dot={
        settings.saved
          ? {
              label: t`Your dot`,
              open: dotMenu,
              onPress: (trigger) => {
                dotAnchor.current = trigger;
                setDotMenu(true);
              },
            }
          : undefined
      }
    />
  );
  const stopTask = appStatus.actions.find((action) => action.kind === "stop-task");
  const setView = (next: ViewStyle) => {
    if (next === viewStyle.value) return;
    keepDraftNow();
    changeCalmly(() => {
      if (next === "chat") nav.enter(viewedConversation?.id ?? "current");
      else nav.leave();
      viewStyle.change(next);
    });
  };
  switchViewNow.current = () => setView(otherView(viewStyle.value));
  const switchViewItem = {
    label: switchViewLabel(viewStyle.value),
    run: () => switchViewNow.current(),
  };
  const replayTarget =
    agent.sessionId && (agent.model.ended || task?.phase === "finished")
      ? agent.sessionId
      : LIBRARY;
  const handOffNote = !guest && !switching && !viewedConversation && (
    <>
      {takeover && takeover.by !== "user" && (
        <div className="thread-handoff" role="status">
          <strong>{yours ? t`Your turn` : t`dot needs your help`}</strong>
          <p>{takeover.note || t`Complete the step on the computer, then choose Hand back.`}</p>
          {stack && !yours && (
            <Button
              variant="primary"
              icon="hand"
              busy={takeState.busy}
              disabledReason={takeState.reason}
              onClick={take}
            >
              {t`Take control`}
            </Button>
          )}
        </div>
      )}
      {yours && agent.sessionId && takeover && selectedScreen?.screen === "browser" && (
        <BrowserSignIn api={api} sessionId={agent.sessionId} requestId={takeover.requestId} />
      )}
    </>
  );
  const computerNotice = stack && noticed && !opening && curtain.phase !== "connecting" && (
    <ComputerNotice
      caption={computer.caption}
      // Replace computer is on its screen: Try again stays held however long this lasts.
      action={cell?.fenced ? undefined : computerAction}
      failed={curtain.phase === "failed"}
      onAction={(kind) => onComputer[kind]()}
      onDetails={openComputer}
    />
  );
  // What a link's guest can't decide: an approval, a hand-over, or a question asked of the owner.
  const ownerWait =
    !!guest &&
    !!agent.snapshot &&
    !agent.model.ended &&
    (stepApproval ||
      !!takeover ||
      !!agent.snapshot.holder ||
      !!agent.snapshot.manualControl ||
      agent.snapshot.status === "paused" ||
      (!!question && !mine));
  const startsTask = !mine || !!agent.model.ended;
  const usedUp =
    !!guest && guest.grant.maxTasks !== null && guest.grant.tasks >= guest.grant.maxTasks;
  const linkReason = ownerWait
    ? t`Waiting for the owner`
    : !mine && taskWorking
      ? t`Another task is running`
      : startsTask && usedUp
        ? t`This link has used all its tasks`
        : undefined;
  const composerLink = useMemo(
    () => (guest ? { own: mine, reason: linkReason } : undefined),
    [guest, mine, linkReason],
  );
  const startedTask = useHandler(() => {
    session.check();
    void guest?.refresh();
  });
  const phoneDock = (
    <>
      {level < 2 && !fixes.some((open) => open.blocker.kind === "computer") && computerNotice}
      {handOffNote}
      {approvalView && !guest && <div className="phone-decision">{approvalView}</div>}
      {ownerWait && (
        <div className="thread-handoff" role="status">
          <strong>{t`Waiting for the owner`}</strong>
          <p>{t`This task needs the computer owner’s input or approval. It has not finished.`}</p>
        </div>
      )}
    </>
  );
  const openPhoneModels = () => {
    settings.browseAccounts();
    phoneModelsAnchor.current = moreButton.current;
    setPhoneModels(true);
  };
  const [guestSettings, setGuestSettings] = useState(false);
  const phoneMenu = (
    <ConversationMenuItems
      onChatSettings={guest?.grant.settings ? () => setGuestSettings(true) : undefined}
      dotHidden={!showDot.value}
      look={shown.look}
      seed={shown.seed}
      onShowDot={tuck.show}
      onWorkspace={() => setActivityOpen(true)}
      hasRecordings={hasRecordings}
      onReplay={() => selectReplay(replayTarget)}
      model={
        mainChoice
          ? {
              label: modelNext ? t`Next message: ${modelLabel}` : t`Model: ${modelLabel}`,
              reason: modelSaving ? t`Saving…` : undefined,
              open: openPhoneModels,
            }
          : undefined
      }
      entry={shown.entry}
      onPin={() => {
        if (shown.entry)
          void organizeConversation(api, shown.entry.sessionId, { pinned: !shown.entry.pinned });
      }}
      onRename={() => setDetailsOpen(true)}
      researchReason={researchWait(agent)}
      sendsAfter={taskWorking && !agent.snapshot?.holder && !dotWait}
      onSearch={() => openPalette("actions")}
      switchView={switchViewItem}
      newReason={newConversation.reason}
      onNew={newConversation.run}
      stop={stopTask}
      onStop={taskStop}
    />
  );
  const statusWord = (
    <>
      <span data-testid="hud-status">{appStatus.label}</span>
      {taskTime && (
        <span data-testid="hud-elapsed">
          {" · "}
          {taskTime}
        </span>
      )}
    </>
  );
  // Until the history is read, the list's name for the conversation on show stands for it.
  const listedTitle = shown.entry ? conversationTitle(shown.entry) : undefined;
  const phoneTitle = watchTitle ?? listedTitle ?? (nav.route.id === "new" ? NEW_TITLE : "");
  const stageFrame = (
    <ErrorBoundary>
      <StageFrame
        boxRef={stageBox}
        onPictureDoubleClick={!sheets && !yours ? fullScreen.enter : undefined}
        light={appStatus.control ? "dot" : yours ? "you" : "none"}
        live={stageHud.live || stageHud.phase === "reconnecting" || stageHud.phase === "suspended"}
        frozen={!!stageHud.paused}
        curtain={!stack && <Presence show={curtain.up}>{curtainView}</Presence>}
        island={
          !stack && (
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
              <AppUpdateOverlay update={appUpdate} />
              {/* A phone has no top bar: New conversation waits in the top corner, beside the
                  island, whenever there is something to start afresh from, and the conversations
                  in the other, lit when one of them needs the user. */}
              {phone && !newConversation.reason && (
                <span className="island-new">
                  <NewConversationButton {...newConversation} />
                </span>
              )}
              {phone && (
                <span className="island-conversations">
                  <ConversationsBubble
                    api={api}
                    facts={liveFacts}
                    current={conversationList.current}
                    attention={[...needsYou].some((id) => id !== currentTask)}
                    onOpen={() => setConversationsOpen(true)}
                  />
                </span>
              )}
            </>
          )
        }
        band={
          !stack && (
            <>
              <NarratorBand
                line={focus && idle && !hearing ? narration : bandLine}
                speaker={focus && idle && !hearing ? speaker : bandSpeaker}
                reveal={!!asked && narration === asked}
                forUser={hearing || !atWork(appStatus.row)}
                showDot={showDot.value}
                idle={!hearing && !!idle}
                action={
                  hearing || !tipAction
                    ? undefined
                    : {
                        label: tipAction.label,
                        run: (trigger) => openTip(tipAction, trigger),
                      }
                }
                dot={
                  settings.saved
                    ? {
                        label: t`Change your dot, now ${personaName(personaOf(taskDot ?? settings.saved.persona).id)}`,
                        open: choosingDot,
                        onPress: (trigger) => {
                          dotAnchor.current = trigger;
                          setChoosingDot(true);
                        },
                      }
                    : undefined
                }
                onHover={setOverBand}
              />
              {dotChooser}
              {full && !focus && (
                <div className="fullscreen-stream-controls">
                  {yours && !phone && (
                    <ControlStrip
                      send={sendToComputer}
                      blocked={inputBlocked}
                      full
                      onFullScreen={fullScreen.toggle}
                    />
                  )}
                  <StreamMenu stream={streamChoice} display={displayControl} />
                </div>
              )}
              {yours && !phone && !full && (
                <ControlStrip
                  send={sendToComputer}
                  blocked={inputBlocked}
                  full={full}
                  onFullScreen={fullScreen.toggle}
                />
              )}
            </>
          )
        }
        side={
          focus && (
            <FocusControls
              display={displayControl}
              stream={streamChoice}
              take={takeState}
              pause={shape === "task" ? pause : null}
              stop={stopTask}
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
          {...(agent.sessionId ? { session: agent.sessionId } : {})}
          parent={cell}
          front={stageFront}
          browserEngine={runningEngine(stageEngine.status)}
          selection={selectedScreen}
          api={api}
          reconnects={reconnects + browserScreen.reconnects}
          listed={listed}
          onPicture={onPicture}
          connection={connection}
          covered={
            stageAway ||
            overviewShown ||
            (!replayId && mobileScreen.minimized) ||
            (sheets && settings.open)
          }
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
        <WorkView
          key={agent.sessionId ?? "empty"}
          api={api}
          sessionId={agent.sessionId ?? ""}
          candidate={currentWork}
          display={displayControl}
          hideControls={full || focus}
          restoring={opening || curtain.up || !!stageCover}
          enabled={
            !!agent.sessionId &&
            !replayId &&
            !takeover &&
            !agent.snapshot?.holder &&
            !agent.snapshot?.manualControl &&
            !decision &&
            !approval &&
            !question &&
            !curtain.up &&
            !mobileScreen.minimized &&
            !agent.model.safetyPaused?.paused &&
            !agent.model.budget &&
            !agent.model.retrying
          }
        />
        <SharedScreen look={sharedLook} />
        {!stack && !yours && !full && !focus && stageHud.live && (
          <StageExpand
            phone={phone}
            onEnter={fullScreen.enter}
            onMinimize={phone ? () => mobileScreen.setMinimized(true) : undefined}
          />
        )}
        <SwitchCover state={stageCover} onShowComputer={endStageSwitch} />
      </StageFrame>
    </ErrorBoundary>
  );
  const chatThread = (
    <ChatThread
      previews={guest ? null : previews}
      visible={shownView === "chat" && (!stack || level > 0)}
      suggestions={voice.suggestions}
      agent={switching ? undefined : viewedConversation ? historyAgent : agent}
      words={
        switching ? undefined : viewedConversation ? historySession.agentFeed : session.agentFeed
      }
      api={api}
      rows={viewedConversation ? historyRows : rows}
      scale={cell?.scale ?? 2}
      reveal={reveal}
      names={names}
      dotLook={shown.lookAs}
      computerReady={cell?.state === "ready" && !cell.paused}
      computerUpdating={!!cell?.updating && cell.state !== "ready"}
      live={
        !viewedConversation && foot && !session.ended
          ? sentThinking
            ? { ...foot, ahead: true }
            : foot
          : null
      }
      onReplay={
        !canReplay
          ? undefined
          : viewedConversation
            ? () => selectReplay(viewedConversation.id)
            : agent.sessionId && (agent.model.ended || task?.phase === "finished")
              ? () => selectReplay(agent.sessionId)
              : undefined
      }
      onReplayTask={canReplay ? (id, atMs) => selectReplay(id, "navigate", atMs) : undefined}
      sessions={switching ? NO_SESSIONS : (viewedConversation?.sessions ?? conversation.sessions)}
      more={!switching && conversation.more}
      withdrawn={conversation.withdrawn}
      pending={
        switching
          ? switching.to !== null
          : viewedConversation
            ? !historyAgent.history
            : threadPending
      }
      pinned={sheets}
      chat={stack}
      lead={
        stack
          ? // Adding goes into the message field, which a conversation opened to read hasn't got.
            !viewedConversation && !guest && <PhoneAdd researchReason={researchWait(agent)} />
          : phone && (
              <IconButton
                className="toolbar-button"
                size={36}
                round
                icon="list"
                label={PANEL_NAME}
                onClick={() => setActivityOpen(true)}
              />
            )
      }
      trail={
        phone && (
          <MoreMenu
            onOpen={localDots.refresh}
            items={[
              {
                label: t`Search actions`,
                icon: "search",
                run: () => openPalette("actions"),
              },
              // The computer's controls take Activity's place in the toolbar.
              ...(yours
                ? [
                    {
                      label: PANEL_NAME,
                      icon: "list" as const,
                      run: () => setActivityOpen(true),
                    },
                  ]
                : []),
              {
                label: t`New conversation`,
                icon: "compose",
                disabledReason: newConversation.reason,
                run: newConversation.run,
              },
              {
                label: t`Conversations`,
                icon: "message-circle",
                run: () => setConversationsOpen(true),
              },
              {
                label: t`Research a question`,
                icon: "globe",
                disabledReason: researchWait(agent),
                run: requestResearch,
              },
              ...(taskWorking && !agent.snapshot?.holder
                ? [
                    {
                      label: t`Send after this task`,
                      icon: "arrow-down" as const,
                      run: sendAfter,
                    },
                  ]
                : []),
              ...(mainChoice
                ? [
                    {
                      label: modelNext ? t`Next message: ${modelLabel}` : t`Model: ${modelLabel}`,
                      icon: "cpu" as const,
                      disabledReason: modelSaving ? t`Saving…` : undefined,
                      run: (trigger: HTMLButtonElement) => {
                        settings.browseAccounts();
                        phoneModelsAnchor.current = trigger;
                        setPhoneModels(true);
                      },
                    },
                  ]
                : []),
              {
                label: t`Overview`,
                icon: "layout-dashboard",
                startsGroup: true,
                run: openOverview,
              },
              {
                label: t`Replay`,
                icon: "history",
                disabledReason: hasRecordings ? undefined : t`No recordings yet`,
                run: () => selectReplay(LIBRARY),
              },
              {
                label: t`Routines`,
                icon: "repeat",
                run: () => setRoutinesOpen(true),
              },
              {
                label: t`Settings`,
                icon: "settings",
                run: (trigger) => showSettings(trigger),
              },
              { label: t`Keys`, icon: "key-round", run: (trigger) => showKeys(trigger) },
              {
                label: switchViewLabel(viewStyle.value),
                icon: "layout-grid",
                run: () => switchViewNow.current(),
              },
              ...(localDots.dots && localDots.dots.length > 1
                ? localDots.dots.filter((dot) => !dot.self)
                : []
              ).map((dot, index) => ({
                label: t`Switch to ${dot.name}`,
                icon: "monitor" as const,
                startsGroup: index === 0,
                run: () => switchToDot(localDots, dot),
              })),
              ...otherLocalDots.list.map((link, index) => ({
                label: t`Switch to ${link.name}`,
                icon: "monitor" as const,
                startsGroup: index === 0,
                run: () => otherLocalDots.open(link.url),
              })),
              {
                label: mobileScreen.minimized ? t`Show screen` : t`Minimize screen`,
                icon: mobileScreen.minimized ? "monitor" : "chevron-up",
                run: () => mobileScreen.setMinimized(!mobileScreen.minimized),
              },
              {
                label: t`Full screen`,
                icon: "expand",
                disabledReason: curtain.up || replayId ? t`Turn on your computer first` : undefined,
                run: () => {
                  mobileScreen.setMinimized(false);
                  fullScreen.enter();
                },
              },
              {
                label: t`Stop everything`,
                icon: "stop",
                startsGroup: true,
                disabledReason: stopAll.running ? t`Stopping…` : undefined,
                run: () => void stopAll.run(),
              },
            ]}
          />
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
            // dot waits on this hand-over, so a message comes first: full screen is in the More menu.
            {...(dotWait ? { message: true } : { onFullScreen: fullScreen.enter })}
          />
        )
      }
      foot={
        stack &&
        !viewedConversation && (
          <DotStrip
            live={!!foot && (sentThinking || !session.ended)}
            hidden={!showDot.value}
            band={level < 2 && phoneBand}
            status={level < 2 && statusWord}
            thumb={
              holding && showDot.value && level > 0 && !switching
                ? {
                    light: appStatus.control ? "dot" : "you",
                    time: taskTime,
                    slotRef: setThumb,
                    onOpen: openComputer,
                  }
                : undefined
            }
            time={foot && !session.ended && !holding ? taskTime : undefined}
          />
        )
      }
      dock={stack ? phoneDock : undefined}
      dockTo={stack && level === 2 && !curtain.up ? dock : null}
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
        !sheets && (
          <>
            <div className="rail-cover-activity" data-shown={shownView === "activity" || undefined}>
              <Held hidden={shownView !== "activity"}>{activity}</Held>
            </div>
            <div className="rail-cover-routines" data-shown={shownView === "routines" || undefined}>
              <Held hidden={shownView !== "routines"}>
                <RoutinesPanel routines={routines} onOpen={openRoutine} onNew={newRoutine} />
              </Held>
            </div>
          </>
        )
      }
      recovery={
        !guest &&
        !switching &&
        !viewedConversation && (
          <>
            {!stack && handOffNote}
            {fixes.length > 0 && agent.sessionId && !controls.fenced && (
              <FixCards
                blockers={fixes}
                deps={{
                  api,
                  sessionId: agent.sessionId,
                  keys,
                  models: {
                    groups: modelChoices,
                    current: currentModel,
                    differs: modelDiffers,
                    remember: (option) => taskModel.choose(option.choice),
                  },
                  stall:
                    agent.model.state?.state === "paused"
                      ? {
                          ...(agent.model.state.reason ? { reason: agent.model.state.reason } : {}),
                          ...(agent.model.state.detail ? { detail: agent.model.state.detail } : {}),
                          ...(agent.model.state.autoContinue
                            ? { autoContinue: agent.model.state.autoContinue }
                            : {}),
                        }
                      : undefined,
                  planResets: planResets(agent.model),
                  local:
                    taskModels?.kind === "api" &&
                    taskModels.roles.some(
                      (role) =>
                        role.role === "main" && ["ollama", "lmstudio"].includes(role.provider),
                    ),
                  retry: {
                    run: controls.resume,
                    reason: controls.canResumeTask
                      ? undefined
                      : t`The task can't continue right now.`,
                  },
                  computer: {
                    action: computerAction,
                    run: (kind) => onComputer[kind](),
                  },
                  runtimeChanged: runtime.check,
                  onOpenKeys: (trigger) => showSettings(trigger, "keys"),
                }}
              />
            )}
            {!fixes.some((open) => open.required) && (
              <TaskRecovery
                agent={agent}
                controls={controls}
                onSettings={showSettings}
                onReenterKey={reenterKey}
                onContinue={continueTask}
                onCarryOn={cell?.state === "ready" && !cell.paused ? carryOn : undefined}
                computer={
                  computerAction && computerAction.kind !== "stop"
                    ? {
                        label: computerAction.kind === "resume" ? t`Resume` : t`Turn on`,
                        reason: computerAction.enabled ? undefined : t`Wait a moment`,
                        run: () => onComputer[computerAction.kind](),
                      }
                    : undefined
                }
                onDontContinue={async () => {
                  if (!agent.sessionId) return false;
                  try {
                    await api.post(`/api/agent/sessions/${agent.sessionId}/auto-continue/cancel`);
                    return true;
                  } catch {
                    return false;
                  }
                }}
                onResumeSelected={modelDiffers && recoveryWait ? carryOn : undefined}
                resumeBlocked={modelSaving ? t`Saving the selected model…` : undefined}
                onReport={report.start}
              />
            )}
            {aside.aside && (
              <SideNote
                aside={aside.aside}
                plans={PlanProvider.options.filter((plan) =>
                  plan === "chatgpt" ? settings.chatgpt.canStart : settings.claudeCode.canStart,
                )}
                usage={planUsage.reply}
                modelName={names.name}
                onDismiss={aside.dismiss}
                onRetry={aside.retry}
                onStop={aside.stop}
                onModels={showModels}
                onSpending={(trigger) => showSettings(trigger, "spending")}
              />
            )}
          </>
        )
      }
      ask={switching || viewedConversation ? undefined : askThread}
      composer={
        viewedConversation ? (
          <div className="thread-recovery-actions">
            <Button variant="quiet" onClick={() => setViewedConversation(null)}>
              {t`Back to current conversation`}
            </Button>
            {!yours && (
              <Button onClick={() => void choose(viewedConversation.id)}>
                {t`Continue this conversation`}
              </Button>
            )}
          </div>
        ) : (
          <Composer
            api={api}
            cell={cell}
            onSending={onSending}
            known={status === "known"}
            pending={pending !== null}
            controlBlocked={
              controls.fenced || controls.stopping || !!cell?.fenced || !!cell?.replacementPending
            }
            agent={agent}
            keysOpen={settings.open}
            receiveKey={receiveKey}
            configured={setupDone}
            onSettings={showModels}
            onTaskStarted={startedTask}
            link={composerLink}
            layout={sheets ? "pill" : "card"}
            placeholder={stack && level === 2 ? t`Steer dot` : undefined}
            waitingOn={dotWait}
            secretField={secretField}
            modelChanged={modelChanged}
            sendModel={guest ? undefined : taskModel.ref}
            modelAfter={modelNext && taskModel.ref ? modelLabel : undefined}
            permissions={guest ? undefined : permissionChip}
            taskAction={stopAction}
            stopping={stoppingRun}
            model={modelChip}
            actions={guest ? undefined : commands.actions}
          />
        )
      }
    />
  );
  const phoneStack = stack && (
    <PhoneStack
      nav={nav}
      split={split}
      listHidden={listHidden}
      flyer={flyer}
      flightFrom={flightFrom}
      showDot={showDot.value}
      lookOf={(id) => {
        const entry = shown.entryOf(id);
        return entry ? conversationLook(entry) : undefined;
      }}
      list={
        <PhoneList
          api={api}
          current={shownId ?? null}
          facts={liveFacts}
          attention={attention.items}
          reason={conversationList.reason}
          selecting={split}
          onOpen={(row, from) => {
            flightFrom.current = from;
            pickConversation(row.entry.sessionId, row.entry.sessions);
          }}
          onNew={() => {
            if (fresh) nav.show("new");
            else newConversation.run();
          }}
          newReason={conversationReason}
          onReplay={() => selectReplay(LIBRARY)}
          onOverview={openOverview}
          onDeleted={conversationList.onDeleted}
          computer={{
            name: settings.saved?.name || t`This computer`,
            onOpen: localDots.refresh,
            menu: (
              <ComputerMenuItems
                name={settings.saved?.name || t`This computer`}
                others={otherDots}
                onManage={() => goToSettings(null, "dot")}
                onRoutines={() => setRoutinesOpen(true)}
                hasRecordings={hasRecordings}
                onReplay={() => selectReplay(LIBRARY)}
                onSettings={() => goToSettings(null)}
                onKeys={() => showKeys(null)}
                onSearch={() => openPalette("actions")}
                switchView={switchViewItem}
                stoppingAll={stopAll.running}
                onStopAll={() => void stopAll.run()}
              />
            ),
          }}
          notice={level === 0 && computerNotice}
        />
      }
      bar={
        <PhoneBar
          title={phoneTitle}
          status={
            showDot.value
              ? undefined
              : {
                  kind: shown.row?.status ?? "none",
                  text: <span className="num">{statusWord}</span>,
                }
          }
          back={
            split
              ? {
                  label: t`Show or hide the list`,
                  icon: "panel-left",
                  onPress: () => setListHidden((was) => !was),
                }
              : {
                  label: t`Back to conversations`,
                  icon: "chevron-left",
                  attention: [...needsYou].some((id) => id !== currentTask),
                  onPress: nav.back,
                }
          }
          onDetails={() => setDetailsOpen(true)}
          lamp={holding}
          monitorRef={monitorButton}
          onComputer={openComputer}
          moreRef={moreButton}
          menu={phoneMenu}
        />
      }
      thread={
        <aside className="phone-thread" aria-label={t`Conversation`}>
          <ErrorBoundary>{chatThread}</ErrorBoundary>
          <ModelMenu
            {...modelMenu}
            open={phoneModels}
            onClose={() => setPhoneModels(false)}
            anchor={phoneModelsAnchor}
            side="bottom"
            align="end"
            dim
            onManage={guest ? undefined : showModels}
          />
        </aside>
      }
      computer={
        <ComputerScreen
          open={level === 2}
          drawnByBrowser={nav.drawnByBrowser}
          thumb={thumb}
          monitor={monitorButton}
          picture={stageFrame}
          curtain={curtain.up && !opening ? curtainView : undefined}
          yours={yours}
          title={phoneTitle}
          status={statusWord}
          band={level === 2 && showDot.value && phoneBand}
          steps={
            level === 2 && (
              <StepPreviewScope
                api={api}
                sessionId={agent.sessionId ?? null}
                results={agent.model.results}
                scale={cell?.scale ?? 2}
              >
                <LatestSteps
                  rows={rows}
                  model={agent.model}
                  live={!!foot && !session.ended}
                  nowMs={now}
                  sessionId={agent.sessionId ?? undefined}
                />
              </StepPreviewScope>
            )
          }
          controls={
            guest ? (
              stopTask && (
                <Button
                  icon="stop"
                  busy={stopTask.busy}
                  disabledReason={stopTask.enabled ? undefined : t`Wait a moment`}
                  onClick={taskStop}
                >
                  {t`Stop`}
                </Button>
              )
            ) : yours ? (
              <ControlTools
                send={sendToComputer}
                blocked={inputBlocked}
                typing={typing}
                onKeyboard={(on) => stage.current?.keyboard(on)}
                rightClick={pointerMode === "right"}
                onRightClick={(on) => setPointerMode(on ? "right" : "click")}
                handBack={handBack.slot}
                onHandBack={() => void handBack.run()}
                {...(handBack.declinable
                  ? { decline: handBack.declineSlot, onDecline: () => void handBack.decline() }
                  : {})}
              />
            ) : (
              <TaskControls
                stop={stopTask}
                pause={pause}
                onPause={() => void safety.requestPause()}
                onContinue={() => void safety.resume()}
                onStop={taskStop}
                take={takeState}
                onTake={take}
                stream={streamChoice}
                display={displayControl}
                resume={computerAction?.kind === "resume" ? computerAction : undefined}
                onResume={onComputer.resume}
                shutDown={
                  appStatus.computer === "frozen"
                    ? appStatus.actions.find((action) => action.kind === "stop")
                    : undefined
                }
                onShutDown={onComputer.stop}
              />
            )
          }
          dockRef={setDock}
          menu={phoneMenu}
          onBack={nav.back}
        />
      }
      over={
        <>
          <div className="phone-notices" ref={toastAnchor}>
            <SafetyNotes safety={safety} agent={agent} visible={sheetsClosed} />
          </div>
          <Toaster anchor={toastAnchor} />
          <AppUpdateOverlay update={appUpdate} />
          <PhoneBanner
            latest={attention.latest}
            viewing={viewing}
            quiet={level === 0 || !!replayId}
            nameOf={(id) => {
              const entry = shown.entryOf(id);
              return entry && { title: conversationTitle(entry), look: conversationLook(entry) };
            }}
            onOpen={openSession}
          />
          {tuck.coach && (
            <CoachMark anchor={moreButton} title={t`dot is tucked away`} onDone={tuck.coachDone}>
              {t`Bring it back any time from this menu.`}
            </CoachMark>
          )}
          <Menu
            open={dotMenu}
            onClose={() => setDotMenu(false)}
            anchor={dotAnchor}
            side="top"
            align="start"
            label={t`Your dot`}
          >
            <MenuItem
              icon="smile"
              onSelect={() => {
                if (shown.entry) setDressing(shown.entry);
                else setChoosingDot(true);
              }}
            >
              {t`Change dot`}
            </MenuItem>
            <MenuItem icon="eye-off" onSelect={tuck.hide}>
              {t`Hide dot`}
            </MenuItem>
          </Menu>
          <LookChooser
            entry={dressing}
            anchor={dotAnchor}
            onChange={(entry, look) => {
              void organizeConversation(api, entry.sessionId, { look }).catch(() =>
                showToast({ title: t`That change couldn't be saved`, tone: "danger" }),
              );
            }}
            onClose={() => setDressing(null)}
          />
          {dotChooser}
          <ConversationDetails
            open={detailsOpen}
            onClose={() => setDetailsOpen(false)}
            title={phoneTitle}
            status={shown.row ? STATUS_LABEL[shown.row.status] : appStatus.label}
            look={shown.look}
            seed={shown.seed}
            onRename={
              shown.entry && !guest
                ? (name) => {
                    void renameConversation(api, shown.entry?.sessionId ?? "", name).then(
                      () => {
                        readConversationsAgain(api);
                        session.check();
                      },
                      () => showToast({ title: t`The new name couldn't be saved`, tone: "danger" }),
                    );
                  }
                : undefined
            }
            rows={[
              ...(guest
                ? []
                : [{ label: PANEL_NAME, icon: "list" as const, run: () => setActivityOpen(true) }]),
              ...(canReplay
                ? [
                    {
                      label: t`Replay`,
                      icon: "history" as const,
                      disabledReason: hasRecordings ? undefined : t`No recordings yet`,
                      run: () => selectReplay(replayTarget),
                    },
                  ]
                : []),
              ...(guest?.grant.settings
                ? [
                    {
                      label: t`Chat settings`,
                      icon: "settings" as const,
                      run: () => setGuestSettings(true),
                    },
                  ]
                : []),
              ...(mainChoice
                ? [
                    {
                      label: t`Model`,
                      icon: "cpu" as const,
                      note: modelLabel,
                      disabledReason: modelSaving ? t`Saving…` : undefined,
                      run: openPhoneModels,
                    },
                  ]
                : []),
            ]}
          />
          {/* The page's entrance: dot wakes on the curtain until everything it shows is read. */}
          <Presence show={opening}>
            <div className="phone-entrance">{curtainView}</div>
          </Presence>
        </>
      }
    />
  );
  const theatre = (
    <SessionNowContext.Provider value={sessionTime.at}>
      <div
        ref={page}
        className={appStatus.control && !replayId ? "app control" : "app"}
        style={{ "--dot-crown": crown(dotArrival.look ?? dotLook) } as CSSProperties}
        data-layout={layout}
        data-stack={(stack && !wideReplay) || undefined}
        data-view={viewStyle.value}
        data-guest={guest ? "" : undefined}
        data-sessions={railShown ? (railExpanded ? "expanded" : "collapsed") : undefined}
        data-screen-minimized={(!replayId && mobileScreen.minimized) || undefined}
        // Replay's rail takes the chat's column whether or not Watch shows the chat.
        data-chat-hidden={(!chatVisible && !replayId) || undefined}
        data-activity-hidden={wide || undefined}
        data-replaying={replayId ? "" : undefined}
        data-overview={overviewShown ? "" : undefined}
        data-focus={focus ? "" : undefined}
        data-full={full ? "" : undefined}
        data-still={still ? "" : undefined}
        data-keyboard={keyboard ? "" : undefined}
        data-setup={onboarding.open ? "" : undefined}
        data-entering={opening ? "" : undefined}
      >
        {(!stack || wideReplay) && (
          <TopBar
            guest={!!guest}
            brand={brand}
            title={
              replayId === LIBRARY
                ? t`Replay`
                : replayId
                  ? (shownRecording?.title ?? RECORDED_TASK)
                  : overviewShown
                    ? t`Overview`
                    : (watchTitle ?? listedTitle)
            }
            note={
              shownRecording?.note ??
              (!replayId && agent.model.origin?.kind === "routine" ? t`Routine` : undefined)
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
            onMode={chooseMode}
            onModeAgain={chooseModeAgain}
            keys={keysState}
            keysOpen={settings.open && settingsAt.section === "keys"}
            onKeys={openKeys}
            keysRef={keysButton}
            settingsOpen={settings.open}
            onSettings={showSettings}
            settingsRef={settingsButton}
            more={guest ? undefined : barMore}
            panels={guest ? undefined : panelsToggle}
          />
        )}
        <div
          className="watch"
          hidden={!!replayId || (sheets && overviewShown)}
          inert={!!replayId || (sheets && overviewShown)}
        >
          {stack ? (
            phoneStack
          ) : (
            <>
              {railShown && (
                <SessionRail
                  api={api}
                  current={overviewShown ? null : conversationList.current}
                  facts={liveFacts}
                  reason={conversationList.reason}
                  expanded={railExpanded}
                  onExpandedChange={expandRail}
                  onPick={pickFromRail}
                  onNew={newFromRail}
                  newReason={newConversation.reason}
                  onDeleted={deletedFromRail}
                  overview={railOverview}
                />
              )}
              {railShown && railExpanded && (wide || layout === "laptop") && (
                <ResizeHandle
                  panel={SESSIONS_WIDTH}
                  property="--sessions-w"
                  label={t`Conversations width`}
                  side="right"
                  beside={chatVisible ? CHAT_WIDTH : 0}
                  first
                  className="rail-resize-sessions"
                />
              )}
              {mobileScreen.minimized && (
                <div className="mobile-screen-restore">
                  <Button icon="monitor" onClick={() => mobileScreen.setMinimized(false)}>
                    {t`Show screen`}
                  </Button>
                </div>
              )}
              <main
                ref={mobileScreen.ref}
                className="stage-col"
                aria-label={t`Computer`}
                inert={mobileScreen.minimized}
              >
                {stageFrame}
              </main>
              {chatVisible && (wide || layout === "laptop") && (
                <ResizeHandle
                  panel={CHAT_WIDTH}
                  property="--rail-w"
                  label={t`Conversation width`}
                  beside={railShown ? (railExpanded ? SESSIONS_WIDTH : SESSIONS_FOLDED) : 0}
                  className="rail-resize-chat"
                />
              )}
              <RailPanel
                label={t`Conversation`}
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
                  {chatThread}
                  {phone && (
                    <ModelMenu
                      {...modelMenu}
                      open={phoneModels}
                      onClose={() => setPhoneModels(false)}
                      anchor={phoneModelsAnchor}
                      side="top"
                      align="end"
                      dim
                      onManage={guest ? undefined : showModels}
                    />
                  )}
                </ErrorBoundary>
              </RailPanel>
            </>
          )}
        </div>
        {overviewMounted && (
          <ErrorBoundary className="overview-failed">
            <main className="overview-col" aria-label={t`Overview`} hidden={!overviewShown}>
              <Overview
                api={api}
                rows={overviewRows}
                shown={overviewShown}
                current={conversationList.current}
                reason={conversationList.reason}
                heading={
                  sheets ? (
                    <div className="overview-heading">
                      <IconButton
                        icon="chevron-left"
                        size={36}
                        label={stack ? t`Conversations` : t`Back`}
                        onClick={closeOverview}
                      />
                      <h1 className="overview-heading-title">{t`Overview`}</h1>
                    </div>
                  ) : undefined
                }
                onOpen={openFromOverview}
              />
            </main>
          </ErrorBoundary>
        )}
        {replayId && (
          <ErrorBoundary className="replay-failed">
            <ReplayView
              api={api}
              sessionId={playing}
              onSelect={selectReplay}
              backLabel={
                !window.history.state?.fromWatch
                  ? t`Replay`
                  : stack && level === 0
                    ? t`Conversations`
                    : t`Conversation`
              }
              onLibrary={() => selectReplay(window.history.state?.fromWatch ? null : LIBRARY)}
              onGoLive={() => selectReplay(null)}
              liveLabel={!stack ? t`Watch` : level === 0 ? t`Conversations` : t`Conversation`}
              modelName={names.name}
              onDeleted={(id) => {
                deletedRecordings.current.add(id);
                if (id === newestReplayId) setNewestReplayId(null);
                historyOwner.current++;
                setHistoryRevision(historyOwner.current);
                if (id === replayId) selectReplay(LIBRARY, "replace");
              }}
              onTitle={setRecorded}
              continueTask={guest ? undefined : replayContinue}
              exportJob={exportJob}
              hostExports={hostExports}
              visible={!settings.open && !safety.approval}
              showDot={showDot.value}
              dotLook={(id, dot) => {
                const entry = shown.entryOf(id);
                return entry ? conversationLook(entry, dot) : taskOutfit(id, dot);
              }}
            />
          </ErrorBoundary>
        )}
        <ErrorBoundary floating>
          <Held hidden={!settings.open}>
            <SettingsSheet
              section={settingsAt.section}
              sectionRequest={settingsAt.request}
              tip={settingsAt.tip}
              appearance={appearance}
              showDot={showDot}
              view={{ ...viewStyle, change: setView }}
              persona={{
                value: settings.draft?.persona ?? settings.saved?.persona ?? DEFAULT_PERSONA,
                onChange: settings.changePersona,
                auto: {
                  on: settings.draft?.autoPersona ?? settings.saved?.autoPersona === true,
                  onChange: settings.changeAutoPersona,
                  disabledReason: autoDotReason(
                    settings.draft ? settings.draft.choices.main : settings.saved?.main,
                  ),
                },
              }}
              look={{
                name: settings.draft?.name ?? settings.saved?.name ?? "",
                accessory: settings.draft ? settings.draft.accessory : settings.saved?.accessory,
                problem: settings.validation?.find((line) => line === NAME_PROBLEM),
                onName: (name) => settings.changeLook({ name }),
                onAccessory: (accessory) => settings.changeLook({ accessory }),
                others: settings.draft?.localDots ?? settings.saved?.localDots ?? [],
                known: otherLocalDots.list,
                onOthers: (localDots) => settings.changeLook({ localDots }),
                onForget: forgetLocalDot,
              }}
              voice={{
                prefs: voicePrefs.value,
                saved: voicePrefs.saved,
                change: voicePrefs.change,
                route: voiceRoute(voiceSupport.support, voicePrefs.value.online, voiceLanguage),
                browser: voiceBrowser,
                downloading: voiceSupport.downloading,
                download: voiceSupport.download,
                speech: speechInstall,
              }}
              stopNote={stopNote}
              stream={streamChoice}
              stop={sheetStopControl}
              stopAll={settingsStopAll}
              startAtLogin={settingsLogin}
              appUpdate={appUpdate}
              remoteApi={api}
              dots={localDots}
              report={report}
              update={updateWait ? { ...computerUpdate, waitReason: updateWait } : computerUpdate}
              freshStart={
                freshStart.available ? { ...freshStart, waitReason: updateWait } : undefined
              }
              open={settings.open}
              keysPanel={keysPanel}
              choices={settings.draft?.choices ?? {}}
              chatgpt={settings.chatgpt}
              claudeCode={settings.claudeCode}
              subscriptionModels={settings.subscriptionModels}
              providers={settings.index?.providers ?? []}
              keys={settings.index ? pickerKeys(settings.index) : []}
              keyLayer={settings.index?.keyLayer ?? "unknown"}
              fastFailure={settings.index?.fastFailure}
              catalog={
                settings.phase === "refreshing" || settings.index?.catalog?.refreshing
                  ? "refreshing"
                  : settings.phase === "loading"
                    ? "loading"
                    : settings.phase === "error"
                      ? "offline"
                      : !settings.index?.catalog
                        ? "empty"
                        : settings.index.catalog.stale ||
                            Date.now() - Date.parse(settings.index.catalog.fetchedAt) > 300_000
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
              library={
                settings.draft
                  ? {
                      draft: settings.draft,
                      index: settings.index,
                      keys: settings.index ? pickerKeys(settings.index) : [],
                      providers: settings.index?.providers ?? [],
                      modelName: names.name,
                      onModels: settings.changeModels,
                      onRole: settings.takeRole,
                      list: (keyId, signal) => loadKeyModels(api, keyId, signal),
                      keyStore: keys,
                      plans: {
                        chatgpt: settings.chatgpt,
                        claudeCode: settings.claudeCode,
                        browse: settings.browseAccounts,
                      },
                    }
                  : undefined
              }
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
              autoContinue={
                settings.draft
                  ? { on: settings.draft.autoContinue, change: settings.autoContinue }
                  : undefined
              }
              onOpenTask={(id) => {
                settings.close();
                selectReplay(id);
              }}
              notifications={settingsNotifications}
              accounts={settingsAccounts}
              engine={settingsEngine}
              browser={settingsBrowser}
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
                      api,
                      keyId: keys.keys
                        .filter(isJevKey)
                        .map((key) => key.id)
                        .sort()[0],
                      fullAccess: settings.saved?.permissionMode === "full",
                      manageJevKey: (trigger) => goToSettings(trigger, "keys"),
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
          </Held>
        </ErrorBoundary>
        {phone && (
          <ErrorBoundary floating>
            <DecisionSheetPresence
              show={!!approvalView || askIn === "sheet"}
              label={appStatus.label}
              elapsedS={appStatus.elapsedS}
              timer={appStatus.timer}
            >
              {approvalView || askOver("sheet")}
            </DecisionSheetPresence>
          </ErrorBoundary>
        )}
        {sheets && (
          <Sheet
            open={routinesOpen}
            onClose={() => setRoutinesOpen(false)}
            title={t`Routines`}
            doneLabel={t`Done`}
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
          <Held hidden={!routineTarget}>
            <RoutineSheet
              routines={routines}
              target={routineTarget}
              onClose={() => setRoutineTarget(null)}
              onWatch={(sessionId) => {
                setRoutineTarget(null);
                selectReplay(sessionId);
              }}
              onConversation={(sessionId) => {
                setRoutineTarget(null);
                void conversationOfRun(api, sessionId).then((latest) =>
                  openRunConversation(latest ?? sessionId),
                );
              }}
              returnFocus={routineOrigin}
            />
          </Held>
        </ErrorBoundary>
        <DeleteConversationDialog
          api={api}
          conversations={deletingCurrent && [deletingCurrent]}
          anchor={deleteFrom}
          onClose={() => setDeletingCurrent(null)}
          onDeleted={conversationList.onDeleted}
        />
        {phone && (
          <Sheet
            open={conversationsOpen}
            onClose={() => setConversationsOpen(false)}
            title={t`Conversations`}
            doneLabel={t`Done`}
            detents={LIST_DETENTS}
            flush
            className="conversations-sheet"
          >
            <ConversationList
              {...conversationList}
              layout="sheet"
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
        {sheets && (
          <Sheet
            open={activityOpen}
            onClose={() => setActivityOpen(false)}
            title={PANEL_NAME}
            className="activity-dialog"
            doneLabel={t`Done`}
            flush
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
              phone={layout === "phone"}
              keys={keys}
              index={settings.index}
              modelsLoading={settings.phase === "loading" || settings.phase === "refreshing"}
              onRefreshModels={settings.refreshModels}
              onCheckModels={settings.checkModels}
              saved={settings.saved}
              onSaved={settings.reload}
              turnOn={
                computerAction && computerAction.kind !== "stop"
                  ? {
                      run: () => onComputer[computerAction.kind](),
                      reason: computerAction.enabled ? undefined : t`Wait a moment`,
                    }
                  : null
              }
              showDot={showDot.value}
              view={viewStyle}
              speech={speechInstall}
              language={voiceLanguage}
            />
          </ErrorBoundary>
        </Presence>
        {showDot.value && dotArrival.look && (
          <ErrorBoundary quiet>
            <PresenceLayer
              place={mobileScreen.minimized && !replayId && !onboarding.open ? null : place}
              arrived={dotArrival.settled}
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
                      look: dotArrival.look,
                    }
                  : hearing
                    ? {
                        ...dotFeed(appStatus, null, now),
                        state: "listening",
                        tool: null,
                        look: dotArrival.look,
                      }
                    : {
                        ...dotFeed(appStatus, session.sessionId ? session.model : null, now),
                        look: dotArrival.look,
                      }
              }
              line={onboarding.open || bandSpeaker !== "dot" || hearing ? "" : bandLine}
            />
          </ErrorBoundary>
        )}
        {guest && (
          <GuestSettingsSheet
            guest={guest}
            open={guestSettings}
            onClose={() => setGuestSettings(false)}
          />
        )}
        <PreviewNotice previews={previews} />
        <CommandPalette
          open={palette !== null}
          page={palette ?? "actions"}
          actions={commands.actions}
          suggested={commands.suggested}
          onClose={() => setPalette(null)}
        />
        <Announcer />
      </div>
    </SessionNowContext.Provider>
  );
  return <PlainSteps.Provider value={stack}>{theatre}</PlainSteps.Provider>;
}
