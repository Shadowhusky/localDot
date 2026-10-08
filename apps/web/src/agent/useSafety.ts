import {
  type ActionClass,
  type AlwaysOption,
  ApprovalAnswer,
  ApprovalCard,
  PauseSnapshot,
  type ReplacementRecord,
  ReplacementRequest,
  ulid,
} from "@localdot/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CellSummary } from "../cells/types.ts";
import type { ApiClient } from "../lib/api.ts";
import { ControlFailure } from "./control-api.ts";
import type { AgentFeed } from "./model.ts";
import {
  answerSafety,
  loadApprovalField,
  loadFence,
  loadReplacement,
  pauseSafety,
  removeAllowance,
  removeRule,
  replaceComputer,
  resumeSafety,
} from "./safety-api.ts";
import type { AgentSessionView } from "./useAgentSession.ts";
export interface SafetyProps {
  api: ApiClient;
  cell: CellSummary | null;
  agent: AgentSessionView;
  feed: AgentFeed;
  blocked: boolean;
  replaceBlocked?: boolean;
  visible: boolean;
  selectReady(id: string): Promise<boolean>;
}
type Operation = {
  api: ApiClient;
  cell: string;
  session: string;
  epoch: number;
  kind: "approval" | "pause" | "resume";
  target: string;
  abort: AbortController;
  before: AgentSessionView["snapshot"];
  phase: "sending" | "checking" | "uncertain";
  explicit: boolean;
};
// An Always allow choice this page made, held so the status line can offer Undo.
export interface AllowedChoice {
  readonly session: string;
  readonly approvalId: string;
  readonly actionClass: ActionClass;
  readonly option: AlwaysOption;
  readonly undo: "idle" | "pending" | "done" | "failed";
}
function sameCard(a: unknown, b: unknown) {
  const x = ApprovalCard.safeParse(a),
    y = ApprovalCard.safeParse(b);
  return x.success && y.success && JSON.stringify(x.data) === JSON.stringify(y.data);
}
const storageKey = (cell: string) => `localdot-replacement:${cell}`;
export function useSafety(props: SafetyProps) {
  const current = useRef(props);
  const mounted = useRef(true);
  const focused = useRef(document.hasFocus());
  const [, focusChanged] = useState(0);
  const operation = useRef<Operation | null>(null);
  const [pending, setPending] = useState<Operation["kind"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localPause, setLocalPause] = useState<PauseSnapshot | null>(null);
  const [replacement, setReplacement] = useState<ReplacementRecord | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [allowed, setAllowed] = useState<AllowedChoice | null>(null);
  const undoing = useRef<AbortController | null>(null);
  const replacementRequest = useRef<ReplacementRequest | null>(null);
  const replacementAttempt = useRef<object | null>(null);
  const replacementAbort = useRef<AbortController | null>(null);
  const replacingRef = useRef(false);
  const identity = useRef({ api: props.api, cell: props.cell?.id, session: props.agent.sessionId });
  useLayoutEffect(() => {
    current.current = props;
    const old = identity.current;
    if (
      old.api === props.api &&
      old.cell === props.cell?.id &&
      old.session === props.agent.sessionId
    )
      return;
    identity.current = { api: props.api, cell: props.cell?.id, session: props.agent.sessionId };
    operation.current?.abort.abort();
    operation.current = null;
    undoing.current?.abort();
    undoing.current = null;
    setPending(null);
    setError(null);
    setLocalPause(null);
    setAllowed(null);
    if (old.api !== props.api || old.cell !== props.cell?.id) {
      replacementAbort.current?.abort();
      replacementRequest.current = null;
      replacementAttempt.current = null;
      replacingRef.current = false;
      setReplacing(false);
      setReplacement(null);
    }
  });
  const owned = (op: Operation) =>
    mounted.current &&
    operation.current === op &&
    current.current.api === op.api &&
    current.current.cell?.id === op.cell &&
    current.current.agent.sessionId === op.session;
  const fresh = (p = current.current, requireFocus = true) => {
    const f = p.feed.read();
    return (
      mounted.current &&
      (!requireFocus || (focused.current && document.hasFocus())) &&
      p.agent.fresh &&
      p.agent.authorityEpoch === f.epoch &&
      f.cellId === p.cell?.id &&
      f.sessionId === p.agent.sessionId &&
      f.connection === "live" &&
      f.replayed &&
      !f.streamError &&
      !f.model.ended &&
      !p.cell?.fenced &&
      !p.cell?.replacementPending &&
      !p.blocked &&
      p.visible &&
      !document.hidden &&
      navigator.onLine
    );
  };
  useEffect(() => {
    mounted.current = true;
    const invalidate = () => {
      const op = operation.current;
      if (!op) return;
      const f = current.current.feed.read();
      if (
        f.epoch !== op.epoch ||
        f.cellId !== op.cell ||
        f.sessionId !== op.session ||
        !current.current.visible ||
        !focused.current ||
        document.hidden ||
        !navigator.onLine
      )
        op.abort.abort();
    };
    const off = props.feed.subscribe(invalidate);
    const blur = () => {
      focused.current = false;
      focusChanged((value) => value + 1);
      invalidate();
    };
    const focus = () => {
      focused.current = true;
      focusChanged((value) => value + 1);
    };
    const parentFocus = (event: Event) => {
      if (!event.isTrusted || document.hidden || !document.hasFocus()) return;
      if (event.target === window) {
        if (document.activeElement instanceof HTMLIFrameElement) return;
      } else {
        const target = event.target;
        if (
          !(target instanceof HTMLElement) ||
          target.ownerDocument !== document ||
          !target.isConnected ||
          target instanceof HTMLIFrameElement ||
          target.closest("[inert], [hidden]")
        )
          return;
      }
      // Regaining parent focus restores eligibility only. Every action still needs
      // a new explicit invocation against the current owner and authority epoch.
      focus();
    };
    window.addEventListener("blur", blur);
    window.addEventListener("focus", parentFocus);
    document.addEventListener("pointerdown", parentFocus, true);
    document.addEventListener("focusin", parentFocus);
    window.addEventListener("offline", invalidate);
    document.addEventListener("visibilitychange", invalidate);
    return () => {
      mounted.current = false;
      operation.current?.abort.abort();
      undoing.current?.abort();
      replacementAbort.current?.abort();
      off();
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", parentFocus);
      document.removeEventListener("pointerdown", parentFocus, true);
      document.removeEventListener("focusin", parentFocus);
      window.removeEventListener("offline", invalidate);
      document.removeEventListener("visibilitychange", invalidate);
    };
  }, [props.feed]);
  useEffect(() => {
    const op = operation.current;
    if (
      !op ||
      op.phase === "sending" ||
      !owned(op) ||
      !fresh() ||
      props.agent.snapshot === op.before
    )
      return;
    const s = props.agent.snapshot;
    const reconciled =
      op.kind === "approval"
        ? !s?.approval ||
          `${s.approval.approvalId}:${s.approval.generation}:${s.approval.revision}` !== op.target
        : op.kind === "pause"
          ? s?.pause?.requestId === op.target
          : !s?.pause || s.pause.phase === "resuming";
    if (reconciled || (op.phase === "uncertain" && op.explicit)) {
      operation.current = null;
      setPending(null);
      setError(null);
      setLocalPause(null);
    }
  });
  async function perform(
    kind: Operation["kind"],
    target: string,
    work: (op: Operation) => Promise<unknown>,
  ) {
    const p = current.current;
    if (operation.current || !p.cell || !p.agent.sessionId || !fresh()) return false;
    const op: Operation = {
      api: p.api,
      cell: p.cell.id,
      session: p.agent.sessionId,
      epoch: p.feed.read().epoch,
      kind,
      target,
      abort: new AbortController(),
      before: p.agent.snapshot,
      phase: "sending",
      explicit: false,
    };
    operation.current = op;
    setPending(kind);
    setError(null);
    try {
      await work(op);
      if (!owned(op)) return false;
      op.phase = "checking";
      current.current.agent.reconcile();
      return true;
    } catch (e) {
      if (!owned(op)) return false;
      op.phase = "uncertain";
      setError(
        e instanceof ControlFailure && !e.uncertain
          ? "Request refused. Check current task status before trying again."
          : "Delivery is unconfirmed. Check current task status before trying again.",
      );
      current.current.agent.reconcile();
      return false;
    }
  }
  const answerApproval = async (body: unknown) => {
    const input = ApprovalAnswer.safeParse(body);
    if (!input.success || !fresh()) return false;
    const p = current.current,
      card = ApprovalCard.safeParse(p.agent.snapshot?.approval);
    if (
      !card.success ||
      !sameCard(card.data, p.feed.read().model.approval) ||
      card.data.expiresAt <= Date.now() ||
      p.agent.model.pendingTakeover ||
      card.data.approvalId !== input.data.approvalId ||
      card.data.generation !== input.data.generation ||
      card.data.revision !== input.data.revision
    )
      return false;
    const scope = input.data.always;
    const option = card.data.always?.find((value) => value.scope === scope);
    if (scope !== undefined && !option) return false;
    // The reply can lose the race with the task's own record of the decision, so the status
    // line waits for that record instead of this request's outcome.
    return perform(
      "approval",
      `${card.data.approvalId}:${card.data.generation}:${card.data.revision}`,
      (op) => {
        if (option) {
          undoing.current?.abort();
          undoing.current = null;
          setAllowed({
            session: op.session,
            approvalId: card.data.approvalId,
            actionClass: card.data.actionClass,
            option,
            undo: "idle",
          });
        }
        return answerSafety(op.api, op.session, input.data, op.abort.signal);
      },
    );
  };
  const undoAllowed = async () => {
    const p = current.current,
      choice = allowed,
      outcome = p.agent.model.approvalOutcome,
      saved = outcome?.approvalId === choice?.approvalId ? outcome?.rule : undefined;
    if (
      !mounted.current ||
      !choice ||
      undoing.current ||
      choice.undo === "pending" ||
      choice.undo === "done" ||
      p.agent.sessionId !== choice.session ||
      saved?.scope !== choice.option.scope ||
      outcome?.ruleRemoved ||
      (choice.option.scope !== "task" && !saved.id)
    )
      return false;
    const abort = new AbortController();
    undoing.current = abort;
    const settle = (undo: AllowedChoice["undo"]) => {
      if (undoing.current !== abort) return;
      undoing.current = null;
      setAllowed((old) => (old?.approvalId === choice.approvalId ? { ...old, undo } : old));
    };
    setAllowed({ ...choice, undo: "pending" });
    try {
      if (saved.id) await removeRule(p.api, saved.id, abort.signal);
      else await removeAllowance(p.api, choice.session, choice.actionClass, abort.signal);
      settle("done");
      return true;
    } catch (error) {
      const gone = error instanceof ControlFailure && error.status === 404;
      settle(gone ? "done" : "failed");
      return gone;
    }
  };
  const dismissAllowed = () => {
    undoing.current?.abort();
    undoing.current = null;
    setAllowed(null);
  };
  const readApprovalField = (approvalId: string, field: number, signal: AbortSignal) => {
    const p = current.current;
    return loadApprovalField(p.api, p.agent.sessionId ?? "", approvalId, field, signal);
  };
  const requestPause = async () => {
    if (
      !fresh() ||
      current.current.agent.snapshot?.pause ||
      current.current.agent.snapshot?.approval ||
      current.current.agent.model.pendingTakeover ||
      current.current.agent.snapshot?.status !== "running"
    )
      return false;
    const requestId = ulid();
    return perform("pause", requestId, async (op) => {
      setLocalPause({
        requestId,
        revision: 1,
        phase: "pausing",
        reason: "user",
        atStepBoundary: false,
        resumeAvailable: false,
      });
      await pauseSafety(op.api, op.session, { requestId }, op.abort.signal);
    });
  };
  const resume = async () => {
    const p = current.current,
      value = PauseSnapshot.safeParse(p.agent.snapshot?.pause);
    if (
      !fresh() ||
      !value.success ||
      value.data.phase !== "paused" ||
      !value.data.atStepBoundary ||
      !value.data.resumeAvailable ||
      p.agent.model.pendingAsk ||
      p.agent.model.pendingTakeover ||
      p.agent.snapshot?.approval ||
      JSON.stringify(p.feed.read().model.safetyPause) !== JSON.stringify(value.data)
    )
      return false;
    return perform("resume", value.data.requestId, (op) =>
      resumeSafety(
        op.api,
        op.session,
        { requestId: value.data.requestId, revision: value.data.revision },
        op.abort.signal,
      ),
    );
  };
  // The browser stores only a request identity for read reconciliation, never a permit or a readiness grant.
  useEffect(() => {
    const id = props.cell?.id,
      revision = props.cell?.fenced?.revision;
    if (!id || !revision) return;
    let disposed = false,
      busy = false;
    const abort = new AbortController();
    replacementAbort.current = abort;
    try {
      const saved = ReplacementRequest.safeParse(
        JSON.parse(sessionStorage.getItem(storageKey(id)) ?? "null"),
      );
      if (saved.success && saved.data.oldRevision === revision)
        replacementRequest.current = saved.data;
    } catch {}
    const poll = async () => {
      const input = replacementRequest.current;
      if (disposed || busy || !input) return;
      busy = true;
      try {
        const value = await loadReplacement(props.api, id, input, abort.signal);
        if (
          disposed ||
          current.current.api !== props.api ||
          current.current.cell?.id !== id ||
          current.current.cell.fenced?.revision !== revision ||
          replacementRequest.current !== input
        )
          return;
        setReplacement(value);
        if (value.phase === "ready" && value.newCellId) {
          // Even a successful mutation reply must pass a separate current status read and an unheld Ready cell read.
          if (await current.current.selectReady(value.newCellId)) {
            replacementRequest.current = null;
            try {
              sessionStorage.removeItem(storageKey(id));
            } catch {}
          } else setError("The fresh computer is still being verified. Check its status again.");
        }
        if (value.phase === "blocked") {
          // Only an authoritative terminal GET releases this identity. Another attempt is explicit.
          replacementRequest.current = null;
          try {
            sessionStorage.removeItem(storageKey(id));
          } catch {}
        }
        if (value.phase === "ready" || value.phase === "blocked") {
          replacementAttempt.current = null;
          replacingRef.current = false;
          setReplacing(false);
        }
      } catch {
        if (!disposed)
          setError("Replacement status is unconfirmed. The old computer stays unavailable.");
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      disposed = true;
      abort.abort();
      clearInterval(timer);
    };
  }, [props.api, props.cell?.id, props.cell?.fenced?.revision]);
  const replace = async () => {
    const p = current.current,
      id = p.cell?.id,
      revision = p.cell?.fenced?.revision;
    if (
      !mounted.current ||
      !focused.current ||
      !document.hasFocus() ||
      !id ||
      !revision ||
      replacingRef.current ||
      replacementRequest.current ||
      document.hidden ||
      !navigator.onLine ||
      !p.visible ||
      (p.replaceBlocked ?? p.blocked)
    )
      return false;
    const attempt = {};
    replacementAttempt.current = attempt;
    replacingRef.current = true;
    setReplacing(true);
    setError(null);
    const abort = new AbortController();
    replacementAbort.current = abort;
    try {
      const fence = await loadFence(p.api, id, abort.signal);
      if (
        replacementAttempt.current !== attempt ||
        abort.signal.aborted ||
        !mounted.current ||
        !focused.current ||
        !document.hasFocus() ||
        document.hidden ||
        !navigator.onLine ||
        !current.current.visible ||
        (current.current.replaceBlocked ?? current.current.blocked) ||
        current.current.api !== p.api ||
        current.current.cell?.id !== id ||
        current.current.cell.fenced?.revision !== revision ||
        fence.revision !== revision
      )
        throw new ControlFailure(false);
      const input: ReplacementRequest = { requestId: ulid(), oldRevision: revision, home: "fresh" };
      replacementRequest.current = input;
      try {
        sessionStorage.setItem(storageKey(id), JSON.stringify(input));
      } catch {}
      const value = await replaceComputer(p.api, id, input, abort.signal);
      if (
        replacementAttempt.current === attempt &&
        !abort.signal.aborted &&
        current.current.api === p.api &&
        current.current.cell?.id === id &&
        current.current.cell.fenced?.revision === revision
      )
        setReplacement(value);
      return true;
    } catch {
      if (
        replacementAttempt.current !== attempt ||
        !mounted.current ||
        current.current.api !== p.api ||
        current.current.cell?.id !== id ||
        current.current.cell.fenced?.revision !== revision
      )
        return false;
      if (mounted.current)
        setError(
          "Replacement completion is unconfirmed. Checking the saved request; the old computer stays unavailable.",
        );
      if (!replacementRequest.current) {
        replacementAttempt.current = null;
        replacingRef.current = false;
        setReplacing(false);
      }
      return false;
    }
  };
  const checkAgain = () => {
    if (operation.current) operation.current.explicit = true;
    current.current.agent.reconcile();
  };
  const approval = props.agent.snapshot?.approval ?? null;
  const pause = props.agent.snapshot?.pause ?? localPause;
  // A newer decision replaces the last choice's status line.
  const later = !!approval && !!allowed && approval.approvalId !== allowed.approvalId;
  useEffect(() => {
    if (!later) return;
    undoing.current?.abort();
    undoing.current = null;
    setAllowed(null);
  }, [later]);
  return {
    approval,
    pause,
    pending,
    error,
    requestPause,
    answerApproval,
    readApprovalField,
    resume,
    replacement,
    replace,
    replacing,
    checkAgain,
    allowed,
    undoAllowed,
    dismissAllowed,
    canNotify:
      fresh(props, false) &&
      !!approval &&
      approval.expiresAt > Date.now() &&
      sameCard(approval, props.feed.read().model.approval) &&
      !props.agent.model.pendingTakeover,
    canApprove:
      fresh(props) &&
      !operation.current &&
      !!approval &&
      approval.expiresAt > Date.now() &&
      sameCard(approval, props.feed.read().model.approval) &&
      !props.agent.model.pendingTakeover,
    canPause:
      fresh(props) &&
      !operation.current &&
      !pause &&
      !approval &&
      !props.agent.model.pendingTakeover &&
      props.agent.snapshot?.status === "running",
    canResume:
      fresh(props) &&
      !operation.current &&
      pause?.phase === "paused" &&
      pause.atStepBoundary &&
      pause.resumeAvailable &&
      JSON.stringify(props.feed.read().model.safetyPause) === JSON.stringify(pause) &&
      !props.agent.model.pendingAsk &&
      !props.agent.model.pendingTakeover &&
      !approval,
    canReplace:
      (!replacement || replacement.phase === "blocked") &&
      !!props.cell?.fenced &&
      !(props.replaceBlocked ?? props.blocked) &&
      props.visible &&
      mounted.current &&
      focused.current &&
      document.hasFocus() &&
      !document.hidden &&
      navigator.onLine &&
      !replacingRef.current &&
      !replacementRequest.current,
  };
}
export type SafetyView = ReturnType<typeof useSafety>;
