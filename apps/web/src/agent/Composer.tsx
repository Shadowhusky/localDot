import { ULID_PATTERN } from "@localdot/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CellSummary } from "../cells/types.ts";
import type { KeyIntake } from "../keys/KeyForm.tsx";
import type { ApiClient } from "../lib/api.ts";
import { DeliveryState } from "./DeliveryState.tsx";
import { KeyFound } from "./KeyFound.tsx";
import type { AgentSessionView } from "./useAgentSession.ts";
import { type KeyGuard, useKeyGuard } from "./useKeyGuard.ts";
import { DeliveryFailure, deliverText, type MessageMode, type TextDelivery } from "./write-api.ts";
import "./composer.css";

export interface ComposerProps {
  api: ApiClient;
  cell: CellSummary | null;
  known: boolean;
  pending: boolean;
  agent: AgentSessionView;
  keysOpen: boolean;
  receiveKey: KeyIntake["receive"];
}
export interface Delivery {
  readonly id: number;
  readonly request: TextDelivery;
  readonly revision: number;
  readonly phase: "sending" | "accepted" | "refused" | "uncertain";
  readonly explanation?: string;
}
const readyCell = (props: ComposerProps) =>
  props.known &&
  !props.pending &&
  props.cell?.state === "ready" &&
  !props.cell.paused &&
  ULID_PATTERN.test(props.cell.id);
function modeFor(props: ComposerProps, selected: "steer" | "followup"): MessageMode {
  if (!props.agent.sessionId || props.agent.model.ended) return "new";
  return props.agent.snapshot?.status === "idle" ? "followup" : selected;
}

export function Composer(props: ComposerProps) {
  const [selected, setSelected] = useState<"steer" | "followup">("steer");
  const selectedNow = useRef<"steer" | "followup">("steer");
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [length, setLength] = useState(0);
  const field = useRef<HTMLTextAreaElement>(null);
  const current = useRef(props);
  const guard = useKeyGuard(true);
  const guardOwner = useRef<KeyGuard>(guard);
  const revision = useRef(0);
  const nextId = useRef(0);
  const pending = useRef<Delivery | null>(null);
  const identity = useRef({
    api: props.api,
    cellId: props.cell?.id,
    sessionId: props.agent.sessionId,
  });
  const composing = useRef(false);
  const mounted = useRef(true);
  const wasKeysOpen = useRef(props.keysOpen);
  useLayoutEffect(() => {
    current.current = props;
    guardOwner.current = guard;
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
    pending.current = null;
    setDelivery(null);
    setProblem(null);
    // A different task does not inherit an uncertain request. Preserve ordinary unsent text.
    revision.current += 1;
  }, [props.api, props.cell?.id, props.agent.sessionId]);
  useLayoutEffect(() => {
    if (wasKeysOpen.current && !props.keysOpen) guardOwner.current.cancel();
    wasKeysOpen.current = props.keysOpen;
  }, [props.keysOpen]);
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
  const mode = modeFor(props, selected);
  const permitted =
    readyCell(props) && online && !props.keysOpen && (mode === "new" || props.agent.fresh);
  const uncertain = delivery?.phase === "uncertain";
  const sending = delivery?.phase === "sending";
  const perform = async (request: TextDelivery, capturedRevision: number) => {
    if (pending.current) return;
    const capturedApi = current.current.api;
    const record: Delivery = {
      id: ++nextId.current,
      request: Object.freeze(request),
      revision: capturedRevision,
      phase: "sending",
    };
    pending.current = record;
    setDelivery(record);
    setProblem(null);
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
      setDelivery({ ...record, phase: "accepted" });
      if (
        revision.current === capturedRevision &&
        field.current &&
        field.current.value === request.text
      ) {
        field.current.value = "";
        setLength(0);
      }
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
      setDelivery({ ...record, phase, explanation: failure.message });
      if (failure.uncertain) pending.current = { ...record, phase };
    } finally {
      if (pending.current === record) pending.current = null;
    }
  };
  const submit = () => {
    const input = field.current;
    if (!input || pending.current || composing.current) return;
    // Check the DOM before copying even ordinary text into delivery state or requests.
    if (!guardOwner.current.check(input)) {
      setLength(input.value.length);
      return;
    }
    const now = current.current;
    const chosen = modeFor(now, selectedNow.current);
    if (
      !readyCell(now) ||
      !navigator.onLine ||
      now.keysOpen ||
      (chosen !== "new" && !now.agent.fresh)
    ) {
      setProblem("Reconnect and check the computer before sending.");
      return;
    }
    const text = input.value;
    if (!text.trim() || text.length > 8000 || !text.isWellFormed() || text.includes("\0")) {
      setProblem("Write a message of 1–8000 characters.");
      return;
    }
    void perform(
      { cellId: now.cell?.id as string, sessionId: now.agent.sessionId, mode: chosen, text },
      revision.current,
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
    if (!field.current || !guardOwner.current.check(field.current)) return;
    pending.current = null;
    void perform(previous.request, -1); // A retry never clears a newer ordinary draft.
  };
  const dismiss = () => {
    if (pending.current?.phase !== "uncertain" || pending.current.id !== delivery?.id) return;
    pending.current = null;
    setDelivery(null);
    setProblem("Delivery is still unconfirmed. Sending this draft again may create a duplicate.");
  };
  return (
    <div className="composer">
      <form
        aria-label="Message dot"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {mode !== "new" && props.agent.snapshot?.status !== "idle" && (
          <fieldset className="delivery-mode" disabled={sending || uncertain}>
            <legend>When to send</legend>
            <label>
              <input
                type="radio"
                name="delivery-mode"
                checked={selected === "steer"}
                onChange={() => {
                  selectedNow.current = "steer";
                  setSelected("steer");
                }}
              />
              Now
            </label>
            <label>
              <input
                type="radio"
                name="delivery-mode"
                checked={selected === "followup"}
                onChange={() => {
                  selectedNow.current = "followup";
                  setSelected("followup");
                }}
              />
              After this task
            </label>
          </fieldset>
        )}
        <label className="draft-label">
          <span>{mode === "new" ? "New task" : "Message"}</span>
          <textarea
            ref={field}
            rows={3}
            disabled={props.keysOpen}
            placeholder={mode === "new" ? "What would you like done?" : "Message dot…"}
            autoComplete="off"
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onInput={(event) => {
              revision.current += 1;
              guardOwner.current.check(event.currentTarget);
              setLength(event.currentTarget.value.length);
              setProblem(null);
            }}
            onPaste={(event) => {
              event.preventDefault();
              const input = event.currentTarget;
              const pasted = event.clipboardData.getData("text/plain");
              if (
                pasted.length + input.value.length - (input.selectionEnd - input.selectionStart) >
                8000
              )
                input.value = " ".repeat(8001); // Bounded overflow sentinel, never a truncated key.
              else input.setRangeText(pasted, input.selectionStart, input.selectionEnd, "end");
              revision.current += 1;
              guardOwner.current.check(input);
              setLength(input.value.length);
              setProblem(null);
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.altKey &&
                !event.nativeEvent.isComposing &&
                !composing.current
              ) {
                event.preventDefault();
                submit();
              }
            }}
          />
        </label>
        <div className="composer-actions">
          <span>{length}/8000</span>
          <button type="submit" disabled={!permitted || sending || uncertain || !!guard.notice}>
            {sending
              ? "Sending…"
              : mode === "new"
                ? "Start task"
                : mode === "followup"
                  ? "Send follow-up"
                  : "Send now"}
          </button>
        </div>
      </form>
      <KeyFound guard={guard} receive={props.receiveKey} />
      {problem && <p role="alert">{problem}</p>}
      {(props.agent.snapshot?.status === "paused" || props.agent.model.pendingTakeover) && (
        <p className="composer-note">A message does not resume the task or hand back control.</p>
      )}
      <DeliveryState
        delivery={delivery}
        onInspect={props.agent.reconcile}
        onRetry={retry}
        onDismiss={dismiss}
        retryEnabled={
          permitted &&
          uncertain === true &&
          !guard.notice &&
          props.agent.sessionId === delivery.request.sessionId
        }
      />
    </div>
  );
}
