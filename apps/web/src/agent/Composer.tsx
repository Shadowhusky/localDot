import {
  type GivenBack,
  KEY_SCAN_CHARS,
  keyLikePresent,
  STALL,
  type TaskModelRef,
  ULID_PATTERN,
} from "@localdot/protocol";
import {
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  type Action,
  type ActionInput,
  onComposerFill,
  rememberAction,
} from "../actions/actions.ts";
import { useCommandMenu } from "../actions/CommandMenu.tsx";
import type { CellSummary } from "../cells/types.ts";
import {
  linkFor,
  onReviseRequest,
  prefill,
  type ReviseDraft,
} from "../deliverables/revise-draft.ts";
import { t, tr } from "../i18n/index.ts";
import type { KeyIntake } from "../keys/KeyForm.tsx";
import type { ApiClient } from "../lib/api.ts";
import { announce } from "../ui/Announcer.tsx";
import { Button } from "../ui/Button.tsx";
import { Collapse } from "../ui/Disclosure.tsx";
import { FileButton } from "../ui/FileButton.tsx";
import { focusWithoutScroll } from "../ui/focus.ts";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Menu, MenuItem } from "../ui/Menu.tsx";
import { useMediaQuery } from "../ui/media.ts";
import { triggerProps } from "../ui/Popover.tsx";
import { TextArea, type TextAreaProps } from "../ui/TextArea.tsx";
import { resizeTextArea } from "../ui/textarea-size.ts";
import "../ui/composer-layout.css";
import { useVoice } from "../voice/useVoice.ts";
import { VoiceButton, VoiceStrip } from "../voice/VoiceControls.tsx";
import { AttachmentChips } from "./Attachments.tsx";
import { splitAttachments, withAttachments } from "./attachments.ts";
import { editQueuedMessage } from "./control-api.ts";
import { PendingMessage } from "./DeliveryState.tsx";
import { KeyFound } from "./KeyFound.tsx";
import { Outbox } from "./outbox.ts";
import {
  LONG_TEXT,
  type LongText,
  longTextFile,
  pastedFiles,
  TEXT_BOUND,
  withoutKeyLike,
} from "./paste.ts";
import { onGiveBack, onQueuedEdit, onSendAfter } from "./queued-draft.ts";
import { ResearchLine, ResearchToggle } from "./ResearchToggle.tsx";
import { RevisingChip } from "./RevisingChip.tsx";
import { looksLikeResearch, onResearchRequest, researchWait } from "./research.ts";
import type { AgentSessionView } from "./useAgentSession.ts";
import { useComposerFold } from "./useComposerFold.ts";
import { type KeyGuard, useKeyGuard } from "./useKeyGuard.ts";
import { useUploads } from "./useUploads.ts";
import { DeliveryFailure, deliverText, type MessageMode, type TextDelivery } from "./write-api.ts";

// dot waits on its model for these, and anything the user says sends it back to the model.
const TRIES_AGAIN = new Set<string | undefined>([
  STALL.modelBusy,
  STALL.modelRefused,
  STALL.modelUnavailable,
]);

const LIMIT = 8000;
const NO_ACTIONS: readonly Action[] = [];
// A phone: Return starts a new line there, and Send sends.
const TOUCH = "(hover: none) and (pointer: coarse)";
// An accepted message holds its place in the thread this long at most while its own row arrives.
const LANDING_MS = 10_000;
// dot weighs whether a message needs research once typing pauses, never on each keystroke.
const SUGGEST_MS = 600;

export interface ComposerProps {
  api: ApiClient;
  cell: CellSummary | null;
  known: boolean;
  pending: boolean;
  controlBlocked?: boolean;
  agent: AgentSessionView;
  keysOpen: boolean;
  receiveKey: KeyIntake["receive"];
  configured?: boolean;
  onSettings?(trigger: HTMLElement): void;
  onTaskStarted?(): void;
  // A message is on its way (true) or failed to arrive (false), before the task says anything.
  onSending?(on: boolean): void;
  // What dot waits on the user for: a message moves on from it, and reaches dot straight away.
  waitingOn?: DotWait;
  // A field for a secret is up in this conversation, whatever else dot waits on: what is typed here
  // may be meant for it, so nothing goes without one more step and none of it is kept.
  secretField?: boolean;
  // A card in the rail, or one rounded field in a phone's toolbar with its controls inside it.
  layout?: "card" | "pill";
  // What the field says while empty, when it isn't the usual words.
  placeholder?: string;
  // The model chip, in a card's row.
  model?: ReactNode;
  taskAction?: { kind: "stop" | "continue"; run(): void; disabledReason?: string };
  // The task this device is stopping: what its Stop gives back comes into the draft.
  stopping?: string | null;
  permissions?: ReactNode;
  // The model chosen runs elsewhere than this task's agent: a message at rest starts a task on it.
  modelChanged?: boolean;
  // The model chosen for this task, which each message carries.
  sendModel?: TaskModelRef;
  // Named when the task at work is on another model: moving it there would end what it is running,
  // so a message for that model waits for the task to finish.
  modelAfter?: string;
  // What "/" lists: the actions with a command name.
  actions?: readonly Action[];
  // A shared link's limits: its messages go to its own task or start one, and it attaches nothing.
  link?: { own: boolean; reason?: string };
}
// `private`: a question with something that must not go in a message, such as a password.
export type DotWait = "question" | "private" | "approval" | "computer" | "fix" | "private-fix";
// A secret field is up, and a secret typed here by mistake would be a message: it takes one more step.
const WAITS_FOR_A_SECRET: ReadonlySet<DotWait | undefined> = new Set(["private", "private-fix"]);
const HELD = t`Not sent. dot reads what you send here, and it stays in the conversation.`;
const SEND_HELD = t`Send as a message — dot will read this`;
const MOVES_ON: Readonly<Record<DotWait, string>> = {
  question: tr("Sending moves on from dot's question"),
  private: tr("Sending moves on from dot's question. Messages aren't kept secret"),
  approval: tr("Sending moves on without approving"),
  computer: tr("Sending hands the computer back"),
  fix: tr("Sending moves on without fixing this"),
  "private-fix": tr("Sending moves on without fixing this. Messages aren't kept secret"),
};
// The same, while a field for a secret is up elsewhere: the message itself isn't kept secret.
const MOVES_ON_UNSECRET: Readonly<Record<DotWait, string>> = {
  question: tr("Sending moves on from dot's question. Messages aren't kept secret"),
  private: tr("Sending moves on from dot's question. Messages aren't kept secret"),
  approval: tr("Sending moves on without approving. Messages aren't kept secret"),
  computer: tr("Sending hands the computer back. Messages aren't kept secret"),
  fix: tr("Sending moves on without fixing this. Messages aren't kept secret"),
  "private-fix": tr("Sending moves on without fixing this. Messages aren't kept secret"),
};
export interface Delivery {
  readonly id: number;
  readonly request: TextDelivery;
  readonly revision: number;
  readonly draftText: string;
  readonly attachmentIDs: readonly number[];
  // Where the attached files are on the computer.
  readonly files: readonly string[];
  // The file the composer was revising when this was sent.
  readonly revising: ReviseDraft | null;
  // When it was sent, as its row will say: while dot worked, or for after the task.
  readonly tag?: string;
  // Your messages the thread already had, so the arrival of this one can be told apart.
  readonly known: ReadonlySet<string>;
  readonly session?: string;
  // Wall-clock ms it was sent at.
  readonly at: number;
  readonly phase: "sending" | "accepted" | "refused" | "uncertain";
}
const readyCell = (props: ComposerProps) =>
  props.known &&
  !props.pending &&
  !props.controlBlocked &&
  props.cell?.state === "ready" &&
  !props.cell.paused &&
  ULID_PATTERN.test(props.cell.id);
function modeFor(props: ComposerProps, selected: "steer" | "followup"): MessageMode {
  if (props.link && !props.link.own) return "new";
  if (
    !props.waitingOn &&
    props.agent.snapshot?.status === "paused" &&
    !props.agent.snapshot.pause &&
    !props.agent.model.pendingAsk &&
    !props.agent.model.pendingTakeover &&
    !props.agent.snapshot.approval
  )
    return "new";
  if (!props.agent.sessionId || props.agent.model.ended || props.agent.snapshot?.holder)
    return "new";
  if (props.agent.snapshot?.status === "idle") return "followup";
  return props.waitingOn ? "steer" : selected;
}
// Why nothing can be sent to the computer now, in the order someone would fix it.
function computerReason(props: ComposerProps): string | undefined {
  if (!props.known) return t`Checking your computer…`;
  if (props.pending) return t`Wait for your computer.`;
  const state = props.cell?.state;
  if (state === "starting") return t`Your computer is starting.`;
  if (state === "stopping") return t`Your computer is shutting down.`;
  if (state !== "ready" || !props.cell || !ULID_PATTERN.test(props.cell.id))
    return t`Turn on your computer first.`;
  if (props.cell.paused) return t`Resume your computer first.`;
  if (props.controlBlocked) return t`You can send once the task is ready.`;
  return undefined;
}
// Why nothing can be sent now, as Send says it.
// The browser's own online flag isn't asked: it guesses about the internet, while localDot is often
// on this computer or the tailnet, and a send that can't reach it keeps the message anyway.
function blockedReason(props: ComposerProps, mode: MessageMode) {
  return (
    computerReason(props) ??
    props.link?.reason ??
    (mode !== "new" && !props.agent.fresh ? t`Reconnecting to the task…` : undefined)
  );
}
const userIds = (props: ComposerProps) =>
  new Set(
    [...props.agent.model.messages.values()].flatMap((message) =>
      message.role === "user" ? [message.id] : [],
    ),
  );
const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  !!target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])");
const carriesFiles = (event: { dataTransfer: DataTransfer | null }) =>
  event.dataTransfer?.types.includes("Files") === true;

// The words being written outlast a reload, never a key: the guard's catch clears them.
const DRAFT_KEY = "localdot.composer-draft.v1";
const DRAFT_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
function readDraft(): string {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null") as {
      text?: unknown;
      at?: unknown;
    } | null;
    return typeof saved?.text === "string" &&
      typeof saved.at === "number" &&
      Date.now() - saved.at < DRAFT_DAYS_MS
      ? saved.text
      : "";
  } catch {
    return "";
  }
}
// While dot waits for a secret, what is typed may be that secret, so none of it is kept on disk.
let draftsHeld = false;
// What a composer gone mid-wait held, for the one that follows it.
let waitDraft = "";
function keepDraft(text: string): void {
  try {
    if (text.trim() && !draftsHeld)
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ text, at: Date.now() }));
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* A blocked store keeps the draft for this page only. */
  }
}
// What was typed in the last moments, kept at once when another composer is about to take over, as
// when the view style changes, since it reads the draft as it comes.
let unkeptDraft: (() => void) | null = null;
export function keepDraftNow(): void {
  unkeptDraft?.();
  unkeptDraft = null;
}
type FieldEvents = Pick<
  TextAreaProps,
  "onInput" | "onPaste" | "onKeyDown" | "onCompositionStart" | "onCompositionEnd"
>;
// The text lives here and only here. It renders when what it says changes, never per keystroke
// and never with the task's updates.
const ComposerField = memo(function ComposerField({
  label,
  placeholder,
  unavailable,
  listening,
  describedBy,
  menu,
  active,
  limit,
  events,
}: {
  label: string;
  placeholder: string;
  unavailable: boolean;
  // While the user talks, the words land here and the field waits for them.
  listening: boolean;
  describedBy?: string;
  // The command list the field drives, and its row in reach of Enter.
  menu?: string;
  active?: string;
  // Typing stops here, rather than the words moving out to a file.
  limit?: number;
  events: FieldEvents;
}) {
  return (
    <TextArea
      bare
      className="composer-field"
      aria-label={label}
      placeholder={placeholder}
      maxRows={8}
      autoComplete="off"
      readOnly={unavailable || listening}
      aria-disabled={unavailable || undefined}
      aria-busy={listening || undefined}
      aria-describedby={describedBy}
      aria-autocomplete="list"
      aria-controls={menu}
      aria-activedescendant={active}
      maxLength={limit}
      {...events}
    />
  );
});

// What the composer reads of the task and the computer. The rest of the task (dot's words, steps,
// usage and heartbeats) changes many times a second while dot works and leaves the composer as
// drawn, so a read of anything else from `agent` or `cell` belongs here too.
function sameTask(was: AgentSessionView, now: AgentSessionView): boolean {
  if (was === now) return true;
  const yours = (task: AgentSessionView) =>
    [...task.model.messages.values()].filter((message) => message.role === "user");
  const before = yours(was);
  const after = yours(now);
  return (
    was.sessionId === now.sessionId &&
    was.snapshot === now.snapshot &&
    was.fresh === now.fresh &&
    was.reconcile === now.reconcile &&
    was.model.ended === now.model.ended &&
    was.model.pendingAsk === now.model.pendingAsk &&
    was.model.pendingTakeover === now.model.pendingTakeover &&
    was.model.state?.reason === now.model.state?.reason &&
    before.length === after.length &&
    before.every((message, index) => message === after[index])
  );
}
const sameCell = (was: CellSummary | null, now: CellSummary | null) =>
  was === now ||
  (!!was && !!now && was.id === now.id && was.state === now.state && was.paused === now.paused);
function sameComposerProps(was: ComposerProps, now: ComposerProps): boolean {
  const keys = new Set([...Object.keys(was), ...Object.keys(now)]) as Set<keyof ComposerProps>;
  for (const key of keys)
    if (
      key === "agent"
        ? !sameTask(was.agent, now.agent)
        : key === "cell"
          ? !sameCell(was.cell, now.cell)
          : key === "link"
            ? was.link?.own !== now.link?.own || was.link?.reason !== now.link?.reason
            : was[key] !== now[key]
    )
      return false;
  return true;
}

export const Composer = memo(function Composer(props: ComposerProps) {
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [voiceSubmitting, setVoiceSubmitting] = useState(false);
  const voiceSubmission = useRef(false);
  // A file the message revises, from Revise on a file dot handed over.
  const [revising, setRevising] = useState<ReviseDraft | null>(null);
  const revisingNow = useRef(revising);
  revisingNow.current = revising;
  const shownRevising = useRef(revising);
  if (revising) shownRevising.current = revising;
  const [blank, setBlank] = useState(true);
  const blankNow = useRef(blank);
  const problemShown = useRef(problem);
  const [menu, setMenu] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Research mode for the next task, and dot's suggestion to turn it on.
  const [research, setResearch] = useState(false);
  const researchNow = useRef(research);
  researchNow.current = research;
  const [suggested, setSuggested] = useState(false);
  const suggestion = useRef(0);
  const form = useRef<HTMLFormElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const drags = useRef(0);
  const field = () => form.current?.querySelector("textarea") ?? null;
  const current = useRef(props);
  const guard = useKeyGuard(true);
  const guardOwner = useRef<KeyGuard>(guard);
  const keyNotice = useId();
  const revision = useRef(0);
  const nextId = useRef(0);
  const pending = useRef<Delivery | null>(null);
  const identity = useRef({
    api: props.api,
    cellId: props.cell?.id,
    sessionId: props.agent.sessionId,
  });
  const composing = useRef(false);
  // A message held back while dot waits for a secret, and the words the user has said may go.
  const [held, setHeld] = useState(false);
  const heldShown = useRef(held);
  // The user said to send this as a message: it isn't held again on its way.
  const sendConfirmed = useRef(false);
  const secretNow = useRef(false);
  const heldLater = useRef(false);
  const accepted = useRef(0);
  const mounted = useRef(true);
  const wasKeysOpen = useRef(props.keysOpen);
  // Without a thread to wait in, a message waits above the composer.
  const outbox = useContext(Outbox);
  const touch = useMediaQuery(TOUCH);
  // Where a lost message offers its two choices.
  const lostChoice = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    current.current = props;
    guardOwner.current = guard;
    problemShown.current = problem;
    heldShown.current = held;
  });
  useLayoutEffect(() => {
    const previous = identity.current;
    if (
      previous.api === props.api &&
      previous.cellId === props.cell?.id &&
      previous.sessionId === props.agent.sessionId
    )
      return;
    identity.current = { api: props.api, cellId: props.cell?.id, sessionId: props.agent.sessionId };
    guardOwner.current.cancel();
    if (
      previous.api === props.api &&
      previous.cellId === props.cell?.id &&
      pending.current?.request.mode === "new"
    )
      return; // Live polling can discover the new session before its HTTP reply arrives.
    // A started task's first message waits in the thread until the new task's history shows it.
    if (
      previous.api === props.api &&
      previous.cellId === props.cell?.id &&
      delivery?.phase === "accepted" &&
      delivery.request.mode === "new" &&
      delivery.session === props.agent.sessionId
    )
      return;
    // Polling may retire the stopped task after a refused attempt to start its
    // replacement. Keep that refusal on this computer until another request or
    // a different task takes ownership; it grants no authority to retry.
    if (
      previous.api === props.api &&
      previous.cellId === props.cell?.id &&
      props.agent.sessionId === null &&
      delivery?.phase === "refused" &&
      delivery.request.mode === "new" &&
      delivery.request.sessionId === previous.sessionId
    )
      return;
    pending.current = null;
    setDelivery(null);
    setProblem(null);
    setRevising(null);
    // A different task does not inherit an uncertain request. Preserve ordinary unsent text.
    revision.current += 1;
  }, [props.api, props.cell?.id, props.agent.sessionId, delivery]);
  useLayoutEffect(() => {
    if (wasKeysOpen.current && !props.keysOpen) guardOwner.current.cancel();
    wasKeysOpen.current = props.keysOpen;
  }, [props.keysOpen]);
  useEffect(() => () => window.clearTimeout(suggestion.current), []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // "/" anywhere outside a field starts a message, as long as the composer is in view.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.key !== "/" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        editable(event.target)
      )
        return;
      const input = form.current?.querySelector("textarea");
      if (!input || input.closest("[inert], [hidden]") || !input.getClientRects().length) return;
      event.preventDefault();
      input.focus();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);

  const mode = modeFor(props, "steer");
  const permitted = readyCell(props) && !props.keysOpen && (mode === "new" || props.agent.fresh);
  const uncertain = delivery?.phase === "uncertain";
  const sending = delivery?.phase === "sending";
  const takeover = !!props.agent.model.pendingTakeover;
  const uploads = useUploads({
    api: props.api,
    cellId: props.cell?.id ?? null,
    ready: readyCell(props),
    enabled: permitted && !sending && !uncertain,
  });
  // Pasted pictures and long texts get names of their own; attaching answers whether it could.
  const pasteNames = useRef(new Set<string>());
  const attach = useRef<(files: readonly File[]) => boolean>(() => false);
  const draft = useRef(0);
  // A long text moved out of the field as its message was sent goes once it has uploaded.
  const sendOnceUploaded = useRef<boolean | null>(null);
  // Returns whether it was turned away: long text would be uploaded at once, before any send.
  const addLongText = (text: string, kind: LongText) => {
    if (secretNow.current && !sendConfirmed.current) {
      setProblem(
        kind === "pasted"
          ? t`Long text isn't taken while a field for a secret is up. Nothing was pasted.`
          : t`Long text isn't taken while a field for a secret is up. The message stops here.`,
      );
      return true;
    }
    const { clean, removed } = withoutKeyLike(text);
    if (removed)
      setProblem(
        kind === "pasted"
          ? t`Keys were taken out of the pasted text. Paste keys straight into Keys.`
          : t`Keys were taken out of your text. Paste keys straight into Keys.`,
      );
    if (!clean.trim()) return false;
    const { file, label } = longTextFile(clean, kind, pasteNames.current);
    uploads.addText(file, label, clean);
    announce("composer", t`The long text is attached as a file.`);
    return false;
  };
  const addLongNow = useRef(addLongText);
  addLongNow.current = addLongText;
  // Files dropped anywhere on the window join the draft, while the composer is on screen.
  useEffect(() => {
    const shown = () => !!form.current && !form.current.closest("[hidden], [inert]");
    const enter = (event: DragEvent) => {
      if (!carriesFiles(event) || !shown()) return;
      drags.current += 1;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (carriesFiles(event) && shown()) event.preventDefault();
    };
    const leave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      drags.current = Math.max(0, drags.current - 1);
      if (!drags.current) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      drags.current = 0;
      setDragging(false);
      if (!carriesFiles(event) || !shown()) return;
      event.preventDefault();
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length) attach.current(files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);

  // The message's own row is in the thread: one of yours, in its words, that the thread did not
  // have when it was sent. The task's feed can bring it before the send's own reply does.
  const messages = props.agent.model.messages;
  const arrived = useMemo(() => {
    if (!delivery || delivery.phase === "refused") return false;
    for (const message of messages.values())
      if (
        message.role === "user" &&
        message.text === delivery.request.text &&
        !delivery.known.has(message.id)
      )
        return true;
    return false;
  }, [delivery, messages]);

  const menuChanged = useRef<(value: string) => void>(() => {});
  const measure = useCallback((input: HTMLTextAreaElement, nativeInput = false) => {
    // Native input already schedules sizing. Imperative paste, voice and clearing need it here.
    if (!nativeInput) resizeTextArea(input);
    menuChanged.current(input.value);
    const next = !input.value.trim();
    if (next === blankNow.current) return;
    blankNow.current = next;
    setBlank(next);
  }, []);
  // The field's words go with the message as a file, and the field is free for more. Keys come out
  // by the guard's own notice when it can read that much.
  const moveToFile = (input: HTMLTextAreaElement) => {
    if (input.value.length <= KEY_SCAN_CHARS) guardOwner.current.check(input);
    const refused = addLongText(input.value, "typed");
    // Turned away, the words stay, up to where the box stops taking more.
    input.value = refused ? input.value.slice(0, TEXT_BOUND) : "";
    revision.current += 1;
    keepDraft("");
    measure(input);
    return refused;
  };
  // Text past what the guard can read never reaches it.
  const checked = (input: HTMLTextAreaElement) => {
    if (input.value.length > TEXT_BOUND) moveToFile(input);
    return guardOwner.current.check(input);
  };
  const checkedNow = useRef(checked);
  checkedNow.current = checked;
  const moveNow = useRef(moveToFile);
  moveNow.current = moveToFile;
  const weigh = useCallback((input: HTMLTextAreaElement) => {
    window.clearTimeout(suggestion.current);
    suggestion.current = window.setTimeout(
      () => setSuggested(looksLikeResearch(input.value)),
      SUGGEST_MS,
    );
  }, []);
  const actionRunning = useRef(false);
  // A command runs instead of being sent: the field clears once it has, unless the action wrote in it.
  const runAction = async (action: Action, given: Omit<ActionInput, "trigger">) => {
    const input = field();
    if (!input || actionRunning.current) return;
    if (!checked(input)) {
      measure(input);
      return;
    }
    actionRunning.current = true;
    const before = input.value;
    setProblem(null);
    try {
      const problem = await action.run({ ...given, trigger: input });
      if (!mounted.current) return;
      if (typeof problem === "string" && problem) {
        setProblem(problem);
        return;
      }
      rememberAction(action.id);
      const box = field();
      if (box?.value === before) {
        box.value = "";
        revision.current += 1;
        keepDraft("");
        measure(box);
      }
    } catch {
      if (mounted.current) setProblem(t`That didn't work. Try again.`);
    } finally {
      actionRunning.current = false;
    }
  };
  const write = (text: string) => {
    const input = field();
    if (!input || input.readOnly) return;
    input.value = text;
    revision.current += 1;
    keepDraft(text);
    measure(input);
    if (problemShown.current !== null) setProblem(null);
    input.focus();
    input.setSelectionRange(text.length, text.length);
  };
  const commands = useCommandMenu({
    actions: props.actions ?? NO_ACTIONS,
    write,
    problem: setProblem,
    run: (action, given) => void runAction(action, given),
  });
  menuChanged.current = commands.changed;
  // What was being written before a reload comes back, through the key guard like a paste.
  useEffect(() => {
    const input = form.current?.querySelector("textarea");
    const saved = readDraft() || waitDraft;
    waitDraft = "";
    // Read-only is no bar: Settings can change the view, and with it this composer, while it is open.
    if (!input || input.value || !saved) return;
    input.value = saved;
    revision.current += 1;
    checkedNow.current(input);
    measure(input);
  }, [measure]);
  // Revise on a file fills the message with the file's name, keeps what was typed and focuses it.
  useEffect(
    () =>
      onReviseRequest((draft) => {
        const input = form.current?.querySelector("textarea");
        if (!input || input.readOnly) return;
        input.value = prefill(input.value, draft.link.name);
        revision.current += 1;
        measure(input);
        setProblem(null);
        setRevising(draft);
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }),
    [measure],
  );
  // A message that never reached dot, or that Stop gave back: its words and files come back into
  // the draft ahead of anything written there since, as they were written first, and the caret
  // stays at the end, where the user was writing. Each message comes back once.
  const takenBack = useRef(new Set<string>());
  const restoreFiles = useRef(uploads.restore);
  restoreFiles.current = uploads.restore;
  const takeBack = useCallback(
    (sessionId: string, messages: readonly GivenBack[]) => {
      const box = form.current?.querySelector("textarea");
      if (!box) return false;
      const fresh = messages.filter(
        ({ messageId }) => !takenBack.current.has(`${sessionId}:${messageId}`),
      );
      if (!fresh.length) return true;
      const parts = fresh.map(({ messageId, text }) => {
        takenBack.current.add(`${sessionId}:${messageId}`);
        return splitAttachments(text);
      });
      box.value = [...parts.map((part) => part.body), box.value]
        .filter((text) => text.trim())
        .join("\n\n");
      restoreFiles.current(parts.flatMap((part) => part.files));
      revision.current += 1;
      keepDraft(checkedNow.current(box) ? box.value : "");
      measure(box);
      setProblem(null);
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
      box.scrollTop = box.scrollHeight;
      announce(
        "composer",
        fresh.length > 1
          ? t`Messages moved to the composer. Edit them, then send when ready.`
          : t`Message moved to the composer. Edit it, then send when ready.`,
      );
      return true;
    },
    [measure],
  );
  useEffect(() => onGiveBack(takeBack), [takeBack]);
  // This device's Stop: what it gave back comes into the draft as it leaves the thread.
  const stopping = props.stopping;
  const said = props.agent.model.messages;
  const shownTask = props.agent.sessionId;
  useEffect(() => {
    if (!stopping || stopping !== shownTask) return;
    const back = [...said.values()].filter(
      (message) => message.role === "user" && message.delivery === "withdrawn" && message.stopped,
    );
    if (back.length)
      takeBack(
        stopping,
        back.map((message) => ({ messageId: message.id, text: message.text })),
      );
  }, [stopping, shownTask, said, takeBack]);
  useEffect(() => {
    const lifetime = new AbortController();
    const unsubscribe = onQueuedEdit((sessionId, messageId, stopped) => {
      const now = current.current;
      const input = form.current?.querySelector("textarea");
      if (!input || (!stopped && sessionId !== now.agent.sessionId)) return null;
      // In the press itself, so a phone raises its keyboard for the words on their way.
      input.focus();
      if (takenBack.current.has(`${sessionId}:${messageId}`)) return Promise.resolve(true);
      return editQueuedMessage(now.api, sessionId, messageId, lifetime.signal).then(
        (text) => takeBack(sessionId, [{ messageId, text }]),
        () => {
          if (!lifetime.signal.aborted)
            setProblem(
              stopped
                ? t`Couldn't move your message here. Try again.`
                : t`Couldn't move your queued message here. It may have started already.`,
            );
          return false;
        },
      );
    });
    return () => {
      lifetime.abort();
      unsubscribe();
    };
  }, [takeBack]);
  // A key taken out, or discarded, changes the text under the composer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a notice's change is the trigger.
  useLayoutEffect(() => {
    const input = form.current?.querySelector("textarea");
    if (input) measure(input);
  }, [guard.notice, measure]);
  // Spoken words land in the field as typed ones do; once final they are checked like a paste.
  const voice = useVoice({
    api: props.api,
    field,
    owner: `${props.cell?.id}:${props.agent.sessionId}`,
    enabled: !props.keysOpen && !props.controlBlocked && !sending && !uncertain,
    live: true,
    changed: (input, caret) => {
      revision.current += 1;
      sendConfirmed.current = false;
      if (heldShown.current) setHeld(false);
      if (caret !== undefined) {
        checked(input);
        keepDraft(input.value);
        if (!touch) {
          input.focus();
          input.setSelectionRange(caret, caret);
        }
        announce("composer", t`Your words are in the message.`);
      }
      measure(input);
      if (caret === undefined)
        requestAnimationFrame(() => {
          // Follow incoming words inside the bounded field without focusing it or moving the
          // page/keyboard. The resize scheduled above runs first.
          if (input.isConnected && input.readOnly) input.scrollTop = input.scrollHeight;
        });
      if (problemShown.current !== null) setProblem(null);
    },
  });
  const talking = voice.state.phase !== "idle";
  const secretWait = WAITS_FOR_A_SECRET.has(props.waitingOn) || !!props.secretField;
  secretNow.current = secretWait;
  useLayoutEffect(() => {
    if (!secretWait) return;
    keepDraft("");
    draftsHeld = true;
    sendConfirmed.current = false;
    accepted.current = revision.current;
    // The secrets entered on this page during the wait, by field, so only a draft that holds one
    // is cleared when the wait ends; anything else typed meanwhile stays.
    const secrets = new Map<EventTarget, string>();
    const note = (event: Event) => {
      const field = event.target;
      if (
        field instanceof HTMLInputElement &&
        (field.type === "password" || field.autocomplete.includes("password"))
      )
        secrets.set(field, field.value);
    };
    document.addEventListener("input", note, true);
    document.addEventListener("change", note, true);
    return () => {
      document.removeEventListener("input", note, true);
      document.removeEventListener("change", note, true);
      draftsHeld = false;
      window.clearTimeout(draft.current);
      unkeptDraft = null;
      setHeld(false);
      const box = form.current?.querySelector("textarea");
      if (!box) return;
      const holdsSecret = [...secrets.values()].some(
        (secret) => secret.trim() && box.value.includes(secret),
      );
      // Still waiting, as when the view changes: the next composer takes the words, never the disk.
      if (secretNow.current) {
        waitDraft = holdsSecret ? "" : box.value;
        return;
      }
      if (!holdsSecret) keepDraft(box.value);
      else {
        box.value = "";
        revision.current += 1;
        measure(box);
        setProblem(
          t`What you typed during that wait was cleared, as it held the secret you entered.`,
        );
      }
    };
  }, [secretWait, measure]);
  // dot has the message: its files went with it, and the draft clears unless it changed since.
  const delivered = (record: Delivery) => {
    sendConfirmed.current = false;
    announce(
      "composer",
      record.request.research
        ? t`Research started.`
        : record.request.mode === "new"
          ? t`Task started.`
          : t`Sent to dot.`,
    );
    // Research is for the task it starts; the next message is an ordinary one again.
    if (record.request.research) setResearch(false);
    if (record.revising === revisingNow.current) setRevising(null);
    uploads.acknowledge(record.attachmentIDs);
    const input = field();
    if (revision.current === record.revision && input && input.value === record.draftText) {
      outbox?.keep();
      input.value = "";
      keepDraft("");
      measure(input);
      window.clearTimeout(suggestion.current);
      setSuggested(false);
    }
  };
  // An accepted message's stand-in gives way in the same frame its own row arrives in the thread.
  useEffect(() => {
    if (delivery?.phase !== "accepted") return;
    const done = () => setDelivery((now) => (now === delivery ? null : now));
    if (arrived) return done();
    const timer = window.setTimeout(done, LANDING_MS);
    return () => window.clearTimeout(timer);
  }, [delivery, arrived]);
  // A lost reply is checked against the task at once. Once the task shows the message, dot has it;
  // until then only you decide whether to send it again.
  const lostId = delivery?.phase === "uncertain" ? delivery.id : null;
  useEffect(() => {
    if (lostId !== null) current.current.agent.reconcile();
  }, [lostId]);
  // While a lost message waits on your choice, the thread's jump button leads to it.
  useEffect(() => {
    if (!outbox || !uncertain) return;
    outbox.needs(() => {
      const choice = lostChoice.current?.querySelector("button");
      if (choice) focusWithoutScroll(choice);
    });
    return () => outbox.needs(null);
  }, [outbox, uncertain]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the lost message's arrival is the trigger.
  useEffect(() => {
    if (delivery?.phase !== "uncertain" || !arrived) return;
    const lost = pending.current;
    if (lost?.phase !== "uncertain" || lost.id !== delivery.id) return;
    pending.current = null;
    setDelivery(null);
    delivered(delivery);
  }, [delivery, arrived]);
  const perform = async (
    request: TextDelivery,
    capturedRevision: number,
    shown: Pick<Delivery, "draftText" | "attachmentIDs" | "files" | "revising" | "tag">,
  ) => {
    if (pending.current) return;
    const capturedApi = current.current.api;
    const record: Delivery = {
      id: ++nextId.current,
      request: Object.freeze(request),
      revision: capturedRevision,
      ...shown,
      known: userIds(current.current),
      at: Date.now(),
      phase: "sending",
    };
    pending.current = record;
    setDelivery(record);
    setProblem(null);
    outbox?.show();
    // One held for after the task wakes nothing until then.
    if (!(request.mode === "followup" && shown.tag)) current.current.onSending?.(true);
    const owns = (acceptedSession?: string) =>
      mounted.current &&
      pending.current === record &&
      current.current.api === capturedApi &&
      current.current.cell?.id === request.cellId &&
      (current.current.agent.sessionId === request.sessionId ||
        (request.mode === "new" && current.current.agent.sessionId === acceptedSession));
    try {
      const acceptedSession = await deliverText(capturedApi, request);
      if (!owns(acceptedSession)) {
        if (mounted.current && pending.current === record) {
          current.current.onSending?.(false);
          setDelivery(null);
          setProblem(
            t`The task changed while sending. Check the current task before sending again.`,
          );
        }
        return;
      }
      setDelivery({ ...record, phase: "accepted", session: acceptedSession });
      delivered(record);
      if (request.mode === "new") current.current.onTaskStarted?.();
    } catch (error) {
      if (
        !owns() &&
        !(
          request.mode === "new" &&
          mounted.current &&
          pending.current === record &&
          current.current.api === capturedApi &&
          current.current.cell?.id === request.cellId
        )
      )
        return;
      const failure = error instanceof DeliveryFailure ? error : new DeliveryFailure(true);
      const phase = failure.uncertain ? "uncertain" : "refused";
      setDelivery({ ...record, phase });
      current.current.onSending?.(false);
      announce("composer", failure.uncertain ? t`Not sure dot got that.` : t`Not sent.`);
      if (failure.uncertain) pending.current = { ...record, phase };
    } finally {
      if (pending.current === record) pending.current = null;
    }
  };
  const submit = (later = false, voiceFinished = false, sendsAnyway = false) => {
    const input = field();
    if (!input || composing.current || (talking && !voiceFinished)) return;
    if (commands.submit(input.value) === "handled") return;
    if (pending.current) return;
    if (
      secretWait &&
      !sendsAnyway &&
      !sendConfirmed.current &&
      (input.value.trim() || uploads.rows.length)
    ) {
      heldLater.current = later;
      setHeld(true);
      announce("composer", HELD);
      return;
    }
    if (input.value.length > TEXT_BOUND) {
      moveToFile(input);
      sendOnceUploaded.current = later;
      return;
    }
    // Check the DOM before copying even ordinary text into delivery state or requests.
    if (!guardOwner.current.check(input)) {
      measure(input);
      return;
    }
    const now = current.current;
    // Research starts a task of its own; at rest, a conversation's next task continues it.
    const resting = now.agent.snapshot?.status === "idle";
    const asked = modeFor(now, later || now.modelAfter ? "followup" : "steer");
    const chosen =
      (researchNow.current || now.modelChanged) && asked === "followup" && resting ? "new" : asked;
    if (chosen === "new" && now.configured === false) {
      now.onSettings?.(input);
      return;
    }
    if (!readyCell(now) || now.keysOpen || (chosen !== "new" && !now.agent.fresh)) {
      const why = blockedReason(now, chosen);
      setProblem(
        why
          ? t`${why} Your message stays here.`
          : t`Reconnect and check the computer before sending.`,
      );
      return;
    }
    // A revision needs its words, which name the file it revises, in the message.
    if (input.value.length > LONG_TEXT && !linkFor(input.value, revisingNow.current)) {
      moveToFile(input);
      sendOnceUploaded.current = later;
      return;
    }
    const text = input.value;
    if (
      (!text.trim() && !uploads.rows.length) ||
      text.length > LIMIT ||
      !text.isWellFormed() ||
      text.includes("\0")
    ) {
      setProblem(t`Write a message or attach a file.`);
      return;
    }
    // A revision goes to the revise route when the task has ended, or when it revises an older
    // version or an earlier task's file: a follow-up would make this task edit its own file.
    const draft = revisingNow.current;
    const link = linkFor(text, draft);
    const elsewhere = !!link && (!draft?.newest || link.sessionId !== now.agent.sessionId);
    if (elsewhere && chosen !== "new" && now.agent.snapshot?.status !== "idle") {
      setProblem(t`Wait for dot to finish, then revise v${String(draft?.label)}.`);
      return;
    }
    if (link && (chosen === "new" || elsewhere)) {
      deliver(text, "new", false, link);
      return;
    }
    deliver(text, chosen, later);
  };
  const sendHeld = () => {
    accepted.current = revision.current;
    sendConfirmed.current = true;
    setHeld(false);
    if (!touch) field()?.focus();
    submit(heldLater.current, false, true);
  };
  const sendVoice = async () => {
    if (voiceSubmission.current) return;
    voiceSubmission.current = true;
    setVoiceSubmitting(true);
    const owner = identity.current;
    try {
      if (await voice.finish()) {
        // A spoken message waits for this task to finish; only a typed one steers.
        if (mounted.current && identity.current === owner) submit(true, true);
      }
    } finally {
      voiceSubmission.current = false;
      if (mounted.current) setVoiceSubmitting(false);
    }
  };
  const deliver = (
    text: string,
    chosen: MessageMode,
    later: boolean,
    revise?: TextDelivery["revise"],
  ) => {
    const now = current.current;
    const attached = uploads.forMessage();
    if (!attached) {
      setProblem(t`Wait for your files to finish uploading, or retry a paused upload.`);
      return;
    }
    const sent = withAttachments(
      text.trim() ? text : "",
      attached.map((row) => row.path),
    );
    const input = field();
    // Many long file names take the room the words had.
    if (sent.length > LIMIT && !revise && input?.value === text && text.trim()) {
      moveToFile(input);
      sendOnceUploaded.current = later;
      return;
    }
    if (sent.length > LIMIT || keyLikePresent(sent)) {
      setProblem(t`Shorten the attachment names before sending.`);
      return;
    }
    if (revise && sent.length > 7500) {
      setProblem(t`Shorten the message to 7,500 characters to revise a file.`);
      return;
    }
    void perform(
      {
        cellId: now.cell?.id as string,
        sessionId: now.agent.sessionId,
        mode: chosen,
        text: sent,
        ...(revise ? { revise } : {}),
        ...(chosen === "new" && !revise && researchNow.current ? { research: true as const } : {}),
        ...(now.sendModel && !revise ? { model: now.sendModel } : {}),
      },
      revision.current,
      {
        draftText: text,
        attachmentIDs: attached.map((row) => row.id),
        files: attached.map((row) => row.path),
        revising: revisingNow.current,
        tag:
          chosen === "steer"
            ? t`Sent while working`
            : chosen === "followup" && now.agent.snapshot?.status !== "idle"
              ? t`After this task`
              : undefined,
      },
    );
  };
  const retry = () => {
    const previous = delivery;
    const now = current.current;
    if (
      previous?.phase !== "uncertain" ||
      pending.current?.phase !== "uncertain" ||
      pending.current.id !== previous.id ||
      !readyCell(now) ||
      now.keysOpen ||
      now.cell?.id !== previous.request.cellId ||
      now.agent.sessionId !== previous.request.sessionId ||
      (previous.request.mode !== "new" && !now.agent.fresh)
    )
      return;
    if (previous.request.mode === "new" && now.configured === false) return;
    const input = field();
    if (!input || !checked(input)) return;
    pending.current = null;
    // Reuse the confirmed attachment IDs, while preserving any newer ordinary draft.
    void perform(previous.request, -1, {
      draftText: previous.draftText,
      attachmentIDs: previous.attachmentIDs,
      files: previous.files,
      revising: previous.revising,
      tag: previous.tag,
    });
  };
  const dismiss = () => {
    if (pending.current?.phase !== "uncertain" || pending.current.id !== delivery?.id) return;
    pending.current = null;
    setDelivery(null);
    setProblem(t`dot may already have that message. Sending again could repeat it.`);
  };
  // From the menu, focus goes back to the message once it is on its way; on a phone that would
  // bring up the keyboard, so focus stays on the menu's button.
  const sendAfter = () => {
    if (!touch) field()?.focus();
    submit(true);
  };
  const edit = () => {
    if (delivery?.phase === "refused") setDelivery(null);
    field()?.focus();
  };

  const choosing = mode !== "new" && props.agent.snapshot?.status !== "idle" && !props.waitingOn;
  // A phone's field has room for its text and Send only; its More menu has the choice instead.
  const pill = props.layout === "pill";
  const offersMenu = !pill && choosing && !props.modelAfter;
  if (!offersMenu && menu) setMenu(false);
  const rows = uploads.rows;
  const typing = useRef({ submit, touch, choosing, write, menuKey: commands.key, files: false });
  useLayoutEffect(() => {
    typing.current = {
      submit,
      touch,
      choosing,
      write,
      menuKey: commands.key,
      files: rows.length > 0,
    };
  });
  useEffect(() => {
    const later = sendOnceUploaded.current;
    if (later === null || uploads.blocked) return;
    sendOnceUploaded.current = null;
    if (rows.length) typing.current.submit(later);
  }, [uploads.blocked, rows.length]);
  useEffect(() => onComposerFill((text) => typing.current.write(text)), []);
  useEffect(() => onSendAfter(() => typing.current.submit(true)), []);
  // From a phone's More menu: research the message, with the field ready for it. Given the question,
  // it goes at once.
  useEffect(
    () =>
      onResearchRequest((question) => {
        const input = form.current?.querySelector("textarea");
        if (!input || input.readOnly || researchWait(current.current.agent)) return;
        setResearch(true);
        input.focus();
        if (question === undefined) return;
        researchNow.current = true;
        typing.current.write(question);
        typing.current.submit();
      }),
    [],
  );
  const events = useMemo<FieldEvents>(
    () => ({
      onCompositionStart: () => {
        composing.current = true;
      },
      onCompositionEnd: () => {
        composing.current = false;
      },
      onInput: (event) => {
        revision.current += 1;
        sendConfirmed.current = false;
        if (heldShown.current) setHeld(false);
        sendOnceUploaded.current = null;
        const refused =
          event.currentTarget.value.length > TEXT_BOUND &&
          !composing.current &&
          moveNow.current(event.currentTarget);
        guardOwner.current.input(event.currentTarget, event.nativeEvent);
        measure(event.currentTarget, true);
        weigh(event.currentTarget);
        if (!refused && problemShown.current !== null) setProblem(null);
        const input = event.currentTarget;
        window.clearTimeout(draft.current);
        unkeptDraft = () => keepDraft(guardOwner.current.notice ? "" : input.value);
        draft.current = window.setTimeout(keepDraftNow, 400);
      },
      onPaste: (event) => {
        const input = event.currentTarget;
        if (input.readOnly) return;
        event.preventDefault();
        const files = [...(event.clipboardData.files ?? [])];
        if (files.length && attach.current(pastedFiles(files, pasteNames.current))) return;
        const pasted = event.clipboardData.getData("text/plain");
        if (
          pasted.length + input.value.length - (input.selectionEnd - input.selectionStart) >
          LONG_TEXT
        ) {
          sendConfirmed.current = false;
          if (problemShown.current !== null) setProblem(null);
          addLongNow.current(pasted, "pasted");
          return;
        }
        input.setRangeText(pasted, input.selectionStart, input.selectionEnd, "end");
        revision.current += 1;
        sendConfirmed.current = false;
        if (heldShown.current) setHeld(false);
        keepDraft(guardOwner.current.check(input) ? input.value : "");
        measure(input);
        weigh(input);
        if (problemShown.current !== null) setProblem(null);
      },
      onKeyDown: (event) => {
        const { submit, touch, choosing, menuKey } = typing.current;
        if (!(touch && event.key === "Enter") && menuKey(event)) return;
        if (
          touch ||
          event.key !== "Enter" ||
          event.shiftKey ||
          event.nativeEvent.isComposing ||
          composing.current
        )
          return;
        // Command or Control and Enter is Enter, while dot works.
        if ((event.ctrlKey || event.metaKey) && !choosing) return;
        event.preventDefault();
        // Option-Return sends after this task, where that is a choice; elsewhere it does nothing.
        if (event.altKey && !choosing) return;
        if (event.currentTarget.value.trim() || typing.current.files) submit(event.altKey);
      },
    }),
    [measure, weigh],
  );
  const empty = blank && !rows.length;
  const taskAction = empty && !talking ? props.taskAction : undefined;
  const command = talking ? undefined : commands.command;
  const connect = mode === "new" && props.configured === false;
  // While nothing can be sent the field still takes the user's words, so what they were typing as a
  // card, an approval or a change of state arrived carries on.
  const unavailable = props.keysOpen;
  const reason = blockedReason(props, mode);
  const sendReason = voiceSubmitting
    ? t`Sending after transcription…`
    : sending
      ? t`Sending…`
      : uncertain
        ? t`Choose what to do with your last message first.`
        : guard.notice
          ? t`Discard the key or move it to Keys first.`
          : connect
            ? t`Choose a model first`
            : (reason ??
              (uploads.blocked
                ? t`Wait for your files to finish uploading.`
                : empty && !talking
                  ? t`Write a message first.`
                  : undefined));
  const attachReason = props.link
    ? t`Files can't be attached on a shared link.`
    : guard.notice
      ? t`Discard the key or move it to Keys first.`
      : sending || uncertain
        ? t`Wait until your message is sent.`
        : reason;
  attach.current = (files) => {
    if (attachReason || !files.length) return false;
    sendConfirmed.current = false;
    uploads.select(files);
    return true;
  };
  // A message to a conversation at rest starts its next task, but reads as any other message.
  const newConversation = mode === "new" && !props.agent.sessionId;
  const researchReason = researchWait(props.agent);
  const researching = research && !researchReason;
  // On a phone the line over the field folds away still saying what it last said.
  const researchLine = !researchReason && (research || suggested);
  const shownResearch = useRef(research);
  if (researchLine) shownResearch.current = research;
  const switching =
    !!props.modelChanged && mode === "followup" && props.agent.snapshot?.status === "idle";
  const sendLabel = researching
    ? t`Start research`
    : newConversation
      ? t`Start task`
      : mode === "new" || switching
        ? t`Send`
        : mode === "followup"
          ? t`Send follow-up`
          : props.modelAfter && !props.waitingOn
            ? t`Send after this task`
            : t`Send now`;
  const note =
    mode === "new" || takeover || props.waitingOn
      ? undefined
      : props.agent.snapshot?.status === "paused"
        ? TRIES_AGAIN.has(props.agent.model.state?.reason)
          ? t`Sending tries the model again`
          : t`Sending won't resume the task`
        : undefined;
  const notices = [
    problem && { text: problem, alert: true },
    uploads.problem && { text: uploads.problem, alert: true },
    uploads.notice && { text: uploads.notice, alert: false },
    choosing &&
      props.modelAfter &&
      !empty && { text: t`Runs on ${props.modelAfter} after this task`, alert: false },
    props.waitingOn &&
      !empty && {
        text:
          props.secretField && !WAITS_FOR_A_SECRET.has(props.waitingOn)
            ? MOVES_ON_UNSECRET[props.waitingOn]
            : MOVES_ON[props.waitingOn],
        alert: false,
      },
  ].filter((notice) => !!notice);
  // The notices fold away holding their last words.
  const shownNotices = useRef(notices);
  if (notices.length) shownNotices.current = notices;
  const shownRows = useRef(rows);
  if (rows.length) shownRows.current = rows;

  const fold = useComposerFold(
    form,
    !blank || rows.length > 0 || !!revising || research || talking || !!voice.notice,
  );

  const waiting = delivery && !arrived && (
    <PendingMessage
      delivery={delivery}
      choiceRef={lostChoice}
      onRetry={retry}
      onDismiss={dismiss}
      onEdit={edit}
      retryReason={
        uncertain && props.agent.sessionId === delivery.request.sessionId && permitted
          ? guard.notice
            ? t`Discard the key or move it to Keys first.`
            : undefined
          : t`Check the current task first.`
      }
    />
  );

  return (
    <div className="composer">
      {waiting && (outbox ? createPortal(waiting, outbox.slot) : waiting)}
      <form
        ref={form}
        className="composer-card"
        data-layout={pill ? "pill" : undefined}
        data-voice={talking || voice.notice ? "" : undefined}
        data-compact={fold.compact ? "" : undefined}
        aria-label={t`Message dot`}
        data-dragging={dragging || undefined}
        onFocus={fold.onFocus}
        onBlur={fold.onBlur}
        onSubmit={(event) => {
          event.preventDefault();
          // Send pressed: the next words go in the field, not to the button.
          if (!touch) field()?.focus();
          submit();
        }}
      >
        {!talking && commands.view}
        <KeyFound
          className="composer-key"
          guard={guard}
          receive={props.receiveKey}
          noticeId={keyNotice}
        />
        <Collapse open={notices.length > 0} className="composer-notices">
          {shownNotices.current.map((notice) => (
            <p
              key={notice.text}
              className="composer-notice"
              role={notices.length ? (notice.alert ? "alert" : "status") : undefined}
            >
              <Icon name="circle-alert" size={12} className="composer-notice-icon" />
              <span>{notice.text}</span>
            </p>
          ))}
        </Collapse>
        <Collapse open={held} className="composer-notices">
          {held && (
            <div className="composer-held">
              <p className="composer-notice" role="status">
                <Icon name="circle-alert" size={12} className="composer-notice-icon" />
                <span>{HELD}</span>
              </p>
              <Button size="sm" disabledReason={sendReason} onClick={sendHeld}>
                {SEND_HELD}
              </Button>
            </div>
          )}
        </Collapse>
        <Collapse open={!!revising} className="composer-files">
          {shownRevising.current && (
            <RevisingChip draft={shownRevising.current} onClear={() => setRevising(null)} />
          )}
        </Collapse>
        <Collapse open={rows.length > 0} className="composer-files">
          <AttachmentChips
            rows={shownRows.current}
            onRemove={uploads.remove}
            onRetry={uploads.retry}
          />
        </Collapse>
        {pill && (
          <Collapse open={researchLine} className="composer-files">
            <ResearchLine
              on={shownResearch.current}
              onToggle={() => {
                setResearch((on) => !on);
                field()?.focus();
              }}
            />
          </Collapse>
        )}
        <ComposerField
          label={newConversation ? t`New task` : t`Message`}
          placeholder={
            researching
              ? t`What should dot research?`
              : newConversation && !pill
                ? t`Ask dot to do something`
                : props.waitingOn
                  ? t`Or message dot`
                  : (props.placeholder ?? t`Message dot`)
          }
          unavailable={!!unavailable}
          listening={talking}
          describedBy={guard.notice ? keyNotice : undefined}
          menu={commands.field["aria-controls"]}
          limit={secretWait && !sendConfirmed.current ? TEXT_BOUND : undefined}
          active={commands.field["aria-activedescendant"]}
          events={events}
        />
        <div className="composer-bar">
          {!props.link && (
            <FileButton
              label={t`Attach files`}
              icon="paperclip"
              size={pill ? 36 : 28}
              round={pill}
              multiple
              onFiles={(files) => attach.current([...files])}
              disabledReason={attachReason}
            />
          )}
          {!pill && (
            <ResearchToggle
              on={research}
              suggested={suggested}
              disabledReason={researchReason}
              onToggle={() => setResearch((on) => !on)}
            />
          )}
          {props.model}
          <div className="composer-hint">
            <VoiceStrip voice={voice}>
              {note && <span className="composer-note">{note}</span>}
            </VoiceStrip>
          </div>
          {props.permissions}
          {!props.link && <VoiceButton voice={voice} />}
          {/* Send's own options, beside it. Mounted with the card, so its room folds in and out
              and the controls around it glide rather than jump as a task starts and stops. */}
          {!pill && (
            <IconButton
              ref={more}
              className="composer-more"
              icon="more-horizontal"
              size={24}
              label={t`Message options`}
              data-shown={offersMenu || undefined}
              aria-hidden={offersMenu ? undefined : true}
              inert={!offersMenu}
              {...triggerProps("menu", menu)}
              onClick={() => setMenu(true)}
            />
          )}
          <Menu
            open={menu}
            onClose={() => setMenu(false)}
            anchor={more}
            side="top"
            align="end"
            label={t`Message options`}
          >
            <MenuItem
              disabledReason={sendReason}
              kbd={touch ? undefined : ["Alt", "Enter"]}
              onSelect={sendAfter}
            >
              {t`Send after this task`}
            </MenuItem>
          </Menu>
          <IconButton
            type={talking || taskAction ? "button" : "submit"}
            onPointerDown={(event) => {
              if (talking && event.button === 0) event.preventDefault();
            }}
            onClick={talking ? () => void sendVoice() : taskAction?.run}
            className="composer-send"
            // What the phone's styles go by, as the label is in the reader's language.
            data-stop={!talking && taskAction?.kind === "stop" ? "" : undefined}
            variant="primary"
            size={32}
            icon={taskAction?.kind === "stop" ? "stop" : "arrow-up"}
            label={
              talking
                ? t`Send voice message`
                : taskAction?.kind === "stop"
                  ? t`Stop task`
                  : taskAction
                    ? t`Continue task`
                    : command
                      ? t`Run /${command.command ?? ""}`
                      : sendLabel
            }
            kbd={touch || taskAction || talking ? undefined : ["Enter"]}
            disabledReason={
              taskAction ? taskAction.disabledReason : command ? command.unavailable : sendReason
            }
            aria-describedby={guard.notice ? keyNotice : undefined}
          />
        </div>
      </form>
      {createPortal(
        <div className="composer-window-drop" data-shown={dragging || undefined} aria-hidden="true">
          <div className="composer-window-drop-card">
            <Icon name="paperclip" />
            {attachReason ?? t`Drop files to attach`}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}, sameComposerProps);
