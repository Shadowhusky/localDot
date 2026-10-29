import { keyLikePresent, STALL, ULID_PATTERN } from "@localdot/protocol";
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
import type { CellSummary } from "../cells/types.ts";
import {
  linkFor,
  onReviseRequest,
  prefill,
  type ReviseDraft,
} from "../deliverables/revise-draft.ts";
import type { KeyIntake } from "../keys/KeyForm.tsx";
import type { ApiClient } from "../lib/api.ts";
import { announce } from "../ui/Announcer.tsx";
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
import { pastedFiles, pastedText } from "./paste.ts";
import { onQueuedEdit } from "./queued-draft.ts";
import { ResearchLine, ResearchToggle } from "./ResearchToggle.tsx";
import { RevisingChip } from "./RevisingChip.tsx";
import { looksLikeResearch, onResearchRequest, researchWait } from "./research.ts";
import type { AgentSessionView } from "./useAgentSession.ts";
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
// A phone: Return starts a new line there, and Send sends.
const TOUCH = "(hover: none) and (pointer: coarse)";
// What is left shows from here on.
const NEAR = 7000;
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
  // While dot waits on a question: a message answers it, or turns it down so dot reads the message
  // and its files.
  reply?(text: string, attached: boolean): Promise<ReplyOutcome>;
  // A card in the rail, or one rounded field in a phone's toolbar with its controls inside it.
  layout?: "card" | "pill";
  // The model chip, in a card's row.
  model?: ReactNode;
  taskAction?: { kind: "stop" | "continue"; run(): void; disabledReason?: string };
  permissions?: ReactNode;
  // The main model saved since this task started: a message at rest starts a task on it.
  modelChanged?: boolean;
}
// What became of a message sent as a reply: it answered the question, it turned the question down
// and goes on as a message, it did not arrive, or it was held with the reason why.
export type ReplyOutcome = "answered" | "declined" | "failed" | { readonly hold: string };
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
  if (
    props.agent.snapshot?.status === "paused" &&
    !props.agent.snapshot.pause &&
    !props.agent.model.pendingAsk &&
    !props.agent.model.pendingTakeover &&
    !props.agent.snapshot.approval
  )
    return "new";
  if (!props.agent.sessionId || props.agent.model.ended || props.agent.snapshot?.holder)
    return "new";
  return props.agent.snapshot?.status === "idle" ? "followup" : selected;
}
// Why nothing can be sent to the computer now, in the order someone would fix it.
function computerReason(props: ComposerProps): string | undefined {
  if (!props.known) return "Checking your computer…";
  if (props.pending) return "Wait for your computer.";
  const state = props.cell?.state;
  if (state === "starting") return "Your computer is starting.";
  if (state === "stopping") return "Your computer is shutting down.";
  if (state !== "ready" || !props.cell || !ULID_PATTERN.test(props.cell.id))
    return "Turn on your computer first.";
  if (props.cell.paused) return "Resume your computer first.";
  if (props.controlBlocked) return "You can send once the task is ready.";
  return undefined;
}
// Why nothing can be sent now, as Send says it.
function blockedReason(props: ComposerProps, online: boolean, mode: MessageMode) {
  if (!online) return "You're offline.";
  return (
    computerReason(props) ??
    (mode !== "new" && !props.agent.fresh ? "Reconnecting to the task…" : undefined)
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
function keepDraft(text: string): void {
  try {
    if (text.trim()) localStorage.setItem(DRAFT_KEY, JSON.stringify({ text, at: Date.now() }));
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* A blocked store keeps the draft for this page only. */
  }
}
// What the composer shows of its text: whether there is any, and its length once that shows.
interface TextShape {
  readonly blank: boolean;
  readonly length: number;
}
const shapeOf = (input: HTMLTextAreaElement): TextShape => ({
  blank: !input.value.trim(),
  length: input.value.length > NEAR ? input.value.length : 0,
});

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
  events,
}: {
  label: string;
  placeholder: string;
  unavailable: boolean;
  // While the user talks, the words land here and the field waits for them.
  listening: boolean;
  describedBy?: string;
  events: FieldEvents;
}) {
  return (
    <TextArea
      bare
      className="composer-field"
      aria-label={label}
      placeholder={placeholder}
      maxRows={8}
      maxLength={LIMIT}
      autoComplete="off"
      readOnly={unavailable || listening}
      aria-disabled={unavailable || undefined}
      aria-busy={listening || undefined}
      aria-describedby={describedBy}
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
  const [online, setOnline] = useState(() => navigator.onLine);
  const [text, setText] = useState<TextShape>({ blank: true, length: 0 });
  const shown = useRef(text);
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
  const replying = useRef(false);
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
  // From a phone's More menu: research the message, with the field ready for it.
  useEffect(
    () =>
      onResearchRequest(() => {
        const input = form.current?.querySelector("textarea");
        if (!input || input.readOnly || researchWait(current.current.agent)) return;
        setResearch(true);
        input.focus();
      }),
    [],
  );
  useEffect(() => {
    mounted.current = true;
    const changed = () => setOnline(navigator.onLine);
    window.addEventListener("online", changed);
    window.addEventListener("offline", changed);
    return () => {
      mounted.current = false;
      window.removeEventListener("online", changed);
      window.removeEventListener("offline", changed);
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

  const mode = modeFor(props, "followup");
  const permitted =
    readyCell(props) && online && !props.keysOpen && (mode === "new" || props.agent.fresh);
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
  // have when it was sent.
  const messages = props.agent.model.messages;
  const arrived = useMemo(() => {
    if (delivery?.phase !== "accepted" && delivery?.phase !== "uncertain") return false;
    for (const message of messages.values())
      if (
        message.role === "user" &&
        message.text === delivery.request.text &&
        !delivery.known.has(message.id)
      )
        return true;
    return false;
  }, [delivery, messages]);

  const measure = useCallback((input: HTMLTextAreaElement, nativeInput = false) => {
    // Native input already schedules sizing. Imperative paste, voice and clearing need it here.
    if (!nativeInput) resizeTextArea(input);
    const next = shapeOf(input);
    if (next.blank === shown.current.blank && next.length === shown.current.length) return;
    shown.current = next;
    setText(next);
  }, []);
  const weigh = useCallback((input: HTMLTextAreaElement) => {
    window.clearTimeout(suggestion.current);
    suggestion.current = window.setTimeout(
      () => setSuggested(looksLikeResearch(input.value)),
      SUGGEST_MS,
    );
  }, []);
  // What was being written before a reload comes back, through the key guard like a paste.
  useEffect(() => {
    const input = form.current?.querySelector("textarea");
    const saved = readDraft();
    if (!input || input.value || input.readOnly || !saved) return;
    input.value = saved;
    revision.current += 1;
    guardOwner.current.check(input);
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
  // Edit on a message that never reached dot: its words and files come back into the draft, after
  // anything already written there, once dot has given them back.
  const takenBack = useRef(new Set<string>());
  const restoreFiles = useRef(uploads.restore);
  restoreFiles.current = uploads.restore;
  useEffect(() => {
    const lifetime = new AbortController();
    const unsubscribe = onQueuedEdit((sessionId, messageId, stopped) => {
      const now = current.current;
      const input = form.current?.querySelector("textarea");
      if (!input || (!stopped && sessionId !== now.agent.sessionId)) return null;
      // In the press itself, so a phone raises its keyboard for the words on their way.
      input.focus();
      const key = `${sessionId}:${messageId}`;
      if (takenBack.current.has(key)) return Promise.resolve(true);
      return editQueuedMessage(now.api, sessionId, messageId, lifetime.signal).then(
        (text) => {
          const box = form.current?.querySelector("textarea");
          if (!box || takenBack.current.has(key)) return !!box;
          takenBack.current.add(key);
          const { body, files } = splitAttachments(text);
          box.value = box.value.trim() ? `${box.value}\n\n${body}` : body;
          restoreFiles.current(files);
          revision.current += 1;
          keepDraft(guardOwner.current.check(box) ? box.value : "");
          measure(box);
          setProblem(null);
          box.focus();
          box.setSelectionRange(box.value.length, box.value.length);
          box.scrollTop = box.scrollHeight;
          announce("composer", "Message moved to the composer. Edit it, then send when ready.");
          return true;
        },
        () => {
          if (!lifetime.signal.aborted)
            setProblem(
              stopped
                ? "Couldn't move your message here. Try again."
                : "Couldn't move your queued message here. It may have started already.",
            );
          return false;
        },
      );
    });
    return () => {
      lifetime.abort();
      unsubscribe();
    };
  }, [measure]);
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
      if (caret !== undefined) {
        guardOwner.current.check(input);
        keepDraft(input.value);
        if (!touch) {
          input.focus();
          input.setSelectionRange(caret, caret);
        }
        announce("composer", "Your words are in the message.");
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
  // dot has the message: its files went with it, and the draft clears unless it changed since.
  const delivered = (record: Delivery) => {
    announce(
      "composer",
      record.request.research
        ? "Research started."
        : record.request.mode === "new"
          ? "Task started."
          : "Sent to dot.",
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
    current.current.onSending?.(true);
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
          setDelivery(null);
          setProblem(
            "The task changed while sending. Check the current task before sending again.",
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
      announce("composer", failure.uncertain ? "Not sure dot got that." : "Not sent.");
      if (failure.uncertain) pending.current = { ...record, phase };
    } finally {
      if (pending.current === record) pending.current = null;
    }
  };
  const submit = (later = true, voiceFinished = false) => {
    const input = field();
    if (
      !input ||
      pending.current ||
      composing.current ||
      replying.current ||
      (talking && !voiceFinished)
    )
      return;
    // Check the DOM before copying even ordinary text into delivery state or requests.
    if (!guardOwner.current.check(input)) {
      measure(input);
      return;
    }
    const now = current.current;
    // Research starts a task of its own; at rest, a conversation's next task continues it.
    const resting = now.agent.snapshot?.status === "idle";
    const asked = modeFor(now, later ? "followup" : "steer");
    const chosen =
      (researchNow.current || now.modelChanged) && asked === "followup" && resting ? "new" : asked;
    if (chosen === "new" && now.configured === false) {
      now.onSettings?.(input);
      return;
    }
    if (
      !readyCell(now) ||
      !navigator.onLine ||
      now.keysOpen ||
      (chosen !== "new" && !now.agent.fresh)
    ) {
      const why = blockedReason(now, navigator.onLine, chosen);
      setProblem(
        why
          ? `${why} Your message stays here.`
          : "Reconnect and check the computer before sending.",
      );
      return;
    }
    const text = input.value;
    if (!text.trim() || text.length > LIMIT || !text.isWellFormed() || text.includes("\0")) {
      setProblem("Write a message of 1–8,000 characters.");
      return;
    }
    // A revision goes to the revise route when the task has ended, or when it revises an older
    // version or an earlier task's file: a follow-up would make this task edit its own file.
    const draft = revisingNow.current;
    const link = linkFor(text, draft);
    const elsewhere = !!link && (!draft?.newest || link.sessionId !== now.agent.sessionId);
    if (elsewhere && chosen !== "new" && now.agent.snapshot?.status !== "idle") {
      setProblem(`Wait for dot to finish, then revise v${draft?.label}.`);
      return;
    }
    if (link && (chosen === "new" || elsewhere)) {
      deliver(text, "new", false, link);
      return;
    }
    const reply = now.reply;
    if (reply && chosen !== "new") {
      replying.current = true;
      setProblem(null);
      void reply(text, uploads.rows.length > 0).then((outcome) => {
        replying.current = false;
        if (!mounted.current) return;
        const box = field();
        if (outcome === "declined") {
          if (box?.value === text) deliver(text, chosen, later);
        } else if (outcome === "answered") {
          if (box?.value === text) {
            box.value = "";
            measure(box);
          }
        } else
          setProblem(
            outcome === "failed" ? "Your reply didn't reach dot. Try again." : outcome.hold,
          );
      });
      return;
    }
    deliver(text, chosen, later);
  };
  const sendVoice = async () => {
    if (voiceSubmission.current) return;
    voiceSubmission.current = true;
    setVoiceSubmitting(true);
    const owner = identity.current;
    try {
      if (await voice.finish()) {
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
      setProblem("Wait for your files to finish uploading, or retry a paused upload.");
      return;
    }
    const sent = withAttachments(
      text,
      attached.map((row) => row.path),
    );
    if (sent.length > LIMIT || keyLikePresent(sent)) {
      setProblem("Shorten the message or attachment names before sending.");
      return;
    }
    if (revise && sent.length > 7500) {
      setProblem("Shorten the message to 7,500 characters to revise a file.");
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
      },
      revision.current,
      {
        draftText: text,
        attachmentIDs: attached.map((row) => row.id),
        files: attached.map((row) => row.path),
        revising: revisingNow.current,
        tag:
          chosen === "steer"
            ? "Sent while working"
            : chosen === "followup" && later && now.agent.snapshot?.status !== "idle"
              ? "After this task"
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
      !navigator.onLine ||
      now.keysOpen ||
      now.cell?.id !== previous.request.cellId ||
      now.agent.sessionId !== previous.request.sessionId ||
      (previous.request.mode !== "new" && !now.agent.fresh)
    )
      return;
    if (previous.request.mode === "new" && now.configured === false) return;
    const input = field();
    if (!input || !guardOwner.current.check(input)) return;
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
    setProblem("dot may already have that message. Sending again could repeat it.");
  };
  // From the menu, focus goes back to the message once it is on its way; on a phone that would
  // bring up the keyboard, so focus stays on the menu's button.
  const send = (later: boolean) => {
    if (!touch) field()?.focus();
    submit(later);
  };
  const edit = () => {
    if (delivery?.phase === "refused") setDelivery(null);
    field()?.focus();
  };

  const choosing = mode !== "new" && props.agent.snapshot?.status !== "idle";
  // A phone's field has room for its text and Send only; there a message is read after the step.
  const pill = props.layout === "pill";
  if ((pill || !choosing) && menu) setMenu(false);
  const typing = useRef({ submit, touch, choosing });
  useLayoutEffect(() => {
    typing.current = { submit, touch, choosing };
  });
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
        guardOwner.current.input(event.currentTarget, event.nativeEvent);
        measure(event.currentTarget, true);
        weigh(event.currentTarget);
        if (problemShown.current !== null) setProblem(null);
        const input = event.currentTarget;
        window.clearTimeout(draft.current);
        draft.current = window.setTimeout(
          () => keepDraft(guardOwner.current.notice ? "" : input.value),
          400,
        );
      },
      onPaste: (event) => {
        const input = event.currentTarget;
        if (input.readOnly) return;
        event.preventDefault();
        const files = [...(event.clipboardData.files ?? [])];
        if (files.length && attach.current(pastedFiles(files, pasteNames.current))) return;
        const pasted = event.clipboardData.getData("text/plain");
        const document = pastedText(pasted, pasteNames.current);
        if (document && attach.current([document])) return;
        if (
          pasted.length + input.value.length - (input.selectionEnd - input.selectionStart) >
          LIMIT
        )
          input.value = " ".repeat(LIMIT + 1); // Bounded overflow sentinel, never a truncated key.
        else input.setRangeText(pasted, input.selectionStart, input.selectionEnd, "end");
        revision.current += 1;
        guardOwner.current.check(input);
        measure(input);
        weigh(input);
        if (problemShown.current !== null) setProblem(null);
      },
      onKeyDown: (event) => {
        const { submit, touch, choosing } = typing.current;
        if (
          touch ||
          event.key !== "Enter" ||
          event.shiftKey ||
          event.nativeEvent.isComposing ||
          composing.current
        )
          return;
        // Command or Control and Enter sends now, into the step dot is on.
        if (event.ctrlKey || event.metaKey) {
          if (!choosing) return;
          event.preventDefault();
          if (event.currentTarget.value.trim()) submit(false);
          return;
        }
        event.preventDefault();
        // Option-Return sends after this task, where that is a choice; elsewhere it does nothing.
        if (event.altKey && !choosing) return;
        if (event.currentTarget.value.trim()) submit();
      },
    }),
    [measure, weigh],
  );
  const taskAction = text.blank && !talking ? props.taskAction : undefined;
  const connect = mode === "new" && props.configured === false;
  const near = text.length > NEAR && text.length <= LIMIT;
  const unavailable = props.keysOpen || props.controlBlocked;
  const reason = blockedReason(props, online, mode);
  const sendReason = voiceSubmitting
    ? "Sending after transcription…"
    : sending
      ? "Sending…"
      : uncertain
        ? "Choose what to do with your last message first."
        : guard.notice
          ? "Discard the key or move it to Keys first."
          : connect
            ? "Choose a model first"
            : (reason ??
              (uploads.blocked
                ? "Wait for your files to finish uploading."
                : text.blank && !talking
                  ? "Write a message first."
                  : undefined));
  const attachReason = guard.notice
    ? "Discard the key or move it to Keys first."
    : sending || uncertain
      ? "Wait until your message is sent."
      : reason;
  attach.current = (files) => {
    if (attachReason || !files.length) return false;
    uploads.select(files);
    return true;
  };
  // A message to a conversation at rest starts its next task, but reads as any other message.
  const newConversation = mode === "new" && !props.agent.sessionId;
  const researchReason =
    researchWait(props.agent) ?? (props.reply ? "Answer dot's question first." : undefined);
  const researching = research && !researchReason;
  // On a phone the line over the field folds away still saying what it last said.
  const researchLine = !researchReason && (research || suggested);
  const shownResearch = useRef(research);
  if (researchLine) shownResearch.current = research;
  const switching =
    !!props.modelChanged && mode === "followup" && props.agent.snapshot?.status === "idle";
  const sendLabel = researching
    ? "Start research"
    : newConversation
      ? "Start task"
      : mode === "new" || switching
        ? "Send"
        : mode === "followup"
          ? choosing
            ? "Queue message"
            : "Send follow-up"
          : "Send now";
  const note =
    mode === "new" || takeover
      ? undefined
      : props.agent.snapshot?.status === "paused"
        ? TRIES_AGAIN.has(props.agent.model.state?.reason)
          ? "Sending tries the model again"
          : "Sending won't resume the task"
        : undefined;
  const notices = [
    problem && { text: problem, alert: true },
    uploads.problem && { text: uploads.problem, alert: true },
    uploads.notice && { text: uploads.notice, alert: false },
  ].filter((notice) => !!notice);
  // The notices fold away holding their last words.
  const shownNotices = useRef(notices);
  if (notices.length) shownNotices.current = notices;
  const rows = uploads.rows;
  const shownRows = useRef(rows);
  if (rows.length) shownRows.current = rows;

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
            ? "Discard the key or move it to Keys first."
            : undefined
          : "Check the current task first."
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
        aria-label="Message dot"
        data-dragging={dragging || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
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
        {near && (
          <p className="composer-count num">{`${(LIMIT - text.length).toLocaleString()} left`}</p>
        )}
        <ComposerField
          label={newConversation ? "New task" : "Message"}
          placeholder={
            researching
              ? "What should dot research?"
              : newConversation && !pill
                ? "Ask dot to do something"
                : props.reply
                  ? "Answer dot"
                  : "Message dot"
          }
          unavailable={!!unavailable}
          listening={talking}
          describedBy={guard.notice ? keyNotice : undefined}
          events={events}
        />
        <div className="composer-bar">
          <FileButton
            label="Attach files"
            icon="paperclip"
            size={pill ? 36 : 28}
            round={pill}
            multiple
            onFiles={(files) => uploads.select(files)}
            disabledReason={attachReason}
          />
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
          {!pill && choosing && (
            <IconButton
              ref={more}
              className="composer-more"
              icon="more-horizontal"
              size={24}
              label="Message options"
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
            label="Message options"
          >
            {choosing && (
              <MenuItem
                disabledReason={sendReason}
                kbd={touch ? undefined : ["Mod", "Enter"]}
                onSelect={() => send(false)}
              >
                Send now
              </MenuItem>
            )}
            {choosing && (
              <MenuItem
                disabledReason={sendReason}
                kbd={touch ? undefined : ["Alt", "Enter"]}
                onSelect={() => send(true)}
              >
                Send after this task
              </MenuItem>
            )}
          </Menu>
          {props.permissions}
          <VoiceButton voice={voice} />
          <IconButton
            type={talking || taskAction ? "button" : "submit"}
            onPointerDown={(event) => {
              if (talking && event.button === 0) event.preventDefault();
            }}
            onClick={talking ? () => void sendVoice() : taskAction?.run}
            className="composer-send"
            variant="primary"
            size={32}
            icon={taskAction?.kind === "stop" ? "stop" : "arrow-up"}
            label={
              talking
                ? "Send voice message"
                : taskAction?.kind === "stop"
                  ? "Stop task"
                  : taskAction
                    ? "Continue task"
                    : sendLabel
            }
            kbd={touch || taskAction || talking ? undefined : ["Enter"]}
            disabledReason={taskAction ? taskAction.disabledReason : sendReason}
            aria-describedby={guard.notice ? keyNotice : undefined}
          />
        </div>
      </form>
      {createPortal(
        <div className="composer-window-drop" data-shown={dragging || undefined} aria-hidden="true">
          <div className="composer-window-drop-card">
            <Icon name="paperclip" />
            {attachReason ?? "Drop files to attach"}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}, sameComposerProps);
