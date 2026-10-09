import {
  BudgetRaiseRequest,
  type QuestionAnswerRequest,
  type StopOutcome,
} from "@localdot/protocol";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Pending } from "../cells/hud-state.ts";
import type { CellSummary } from "../cells/types.ts";
import type { ApiClient } from "../lib/api.ts";
import { memoryUndoEligible } from "./activity.ts";
import {
  answerQuestion,
  ControlFailure,
  raiseTaskBudget,
  resumeTask,
  returnControl,
  stopTask,
  takeControl,
  undoMemory,
} from "./control-api.ts";
import { type AgentFeed, heldByUser } from "./model.ts";
import type { AgentSessionView } from "./useAgentSession.ts";

export interface ControlStatus {
  readonly kind: "answer" | "take" | "handback" | "budget" | "resume" | "memory";
  readonly target: string;
  readonly phase: "sending" | "checking" | "refused" | "uncertain";
  readonly message: string;
  readonly code?: number;
}
export interface StopStatus {
  readonly phase: "idle" | "sending" | "paused" | "stopped" | "unconfirmed";
  readonly errors: readonly string[];
}
interface Props {
  api: ApiClient;
  cell: CellSummary | null;
  cellPending: Pending | null;
  agent: AgentSessionView;
  feed: AgentFeed;
  suspended: boolean;
  manualVisible: boolean;
  refreshCell(): void;
}
interface Operation {
  api: ApiClient;
  cellId: string;
  sessionId: string;
  kind: ControlStatus["kind"] | "stop";
  target: string;
  abort: AbortController;
  settled: boolean;
  recheck?: AgentSessionView["snapshot"];
}
const idleStop: StopStatus = { phase: "idle", errors: [] };
// "busy" while the user's own input stream is delivering, which never closes their control.
const manualReady = (state: string | undefined) => state === "ready" || state === "busy";
export function useTaskControls(props: Props) {
  const current = useRef(props);
  const operation = useRef<Operation | null>(null);
  const fence = useRef(false);
  const confirmedUndos = useRef(new Set<string>());
  const [memoryUndone, setMemoryUndone] = useState<ReadonlySet<string>>(new Set());
  const [status, setStatus] = useState<ControlStatus | null>(null);
  const [stopStatus, setStopStatus] = useState<StopStatus>(idleStop);
  const mounted = useRef(true);
  const identity = useRef({ api: props.api, cell: props.cell?.id, session: props.agent.sessionId });
  const stopScope = useRef<{ api: ApiClient; cellId: string; sessionId: string } | null>(null);
  const containedCell = useRef(false);
  useLayoutEffect(() => {
    current.current = props;
    const old = identity.current;
    if (
      old.api === props.api &&
      (!props.cell || old.cell === props.cell.id) &&
      (!props.agent.sessionId || old.session === props.agent.sessionId)
    )
      return;
    identity.current = { api: props.api, cell: props.cell?.id, session: props.agent.sessionId };
    operation.current?.abort.abort();
    operation.current = null;
    fence.current = false;
    containedCell.current = false;
    confirmedUndos.current.clear();
    setMemoryUndone(new Set());
    stopScope.current = null;
    setStatus(null);
    setStopStatus(idleStop);
  });
  const owned = (record: Operation) =>
    mounted.current &&
    operation.current === record &&
    current.current.api === record.api &&
    (record.kind === "stop"
      ? (!current.current.cell || current.current.cell.id === record.cellId) &&
        (!current.current.agent.sessionId || current.current.agent.sessionId === record.sessionId)
      : current.current.cell?.id === record.cellId &&
        current.current.agent.sessionId === record.sessionId);
  const authoritative = useCallback((now = current.current, allowEnded = false) => {
    const feed = now.feed.read();
    return (
      (allowEnded ? (now.agent.readFresh ?? now.agent.fresh) : now.agent.fresh) &&
      now.agent.authorityEpoch === feed.epoch &&
      feed.cellId === now.cell?.id &&
      feed.sessionId === now.agent.sessionId &&
      (feed.connection === "live" || (allowEnded && feed.connection === "ended")) &&
      feed.replayed &&
      !feed.streamError &&
      (!feed.model.ended || allowEnded) &&
      feed.model.pendingAsk === (now.agent.snapshot?.pendingAsk ?? null) &&
      feed.model.pendingTakeover === (now.agent.snapshot?.pendingTakeover ?? null)
    );
  }, []);
  const available = (now = current.current, allowEnded = false) =>
    authoritative(now, allowEnded) &&
    !fence.current &&
    !now.suspended &&
    !document.hidden &&
    navigator.onLine &&
    now.cellPending === null &&
    now.cell?.state === "ready" &&
    !now.cell.paused &&
    !now.cell.fenced &&
    !now.cell.replacementPending;
  useEffect(() => {
    mounted.current = true;
    const check = () => {
      const record = operation.current;
      if (!record || !["budget", "resume", "memory"].includes(record.kind)) return;
      const feed = current.current.feed.read();
      if (
        document.hidden ||
        !navigator.onLine ||
        current.current.suspended ||
        feed.model.pendingTakeover ||
        feed.model.pendingAsk ||
        feed.sessionId !== record.sessionId ||
        feed.cellId !== record.cellId ||
        (feed.connection !== "live" &&
          !(record.kind === "memory" && feed.connection === "ended")) ||
        !feed.replayed ||
        (feed.model.ended && record.kind !== "memory")
      )
        record.abort.abort();
    };
    const unsubscribe = props.feed.subscribe(check);
    window.addEventListener("offline", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      mounted.current = false;
      operation.current?.abort.abort();
      unsubscribe();
      window.removeEventListener("offline", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [props.feed]);
  useEffect(() => {
    const record = operation.current;
    if (
      record &&
      record.kind !== "stop" &&
      record.settled &&
      (authoritative(current.current, record.kind === "memory") ||
        (!!props.agent.model.ended && authoritative(current.current, true)))
    ) {
      const absent =
        !!props.agent.model.ended ||
        (record.kind === "answer"
          ? props.agent.model.pendingAsk !== record.target
          : record.kind === "take"
            ? !!heldByUser(props.agent.model)
            : record.kind === "handback"
              ? props.agent.model.pendingTakeover !== record.target
              : record.kind === "memory"
                ? props.agent.model.changes.some((change) => change.undoes === record.target)
                : record.kind === "resume"
                  ? props.agent.snapshot?.status !== "paused"
                  : record.kind === "budget"
                    ? props.agent.snapshot?.status !== "paused" ||
                      (!!props.agent.snapshot?.pause && props.agent.snapshot.budgetHold !== "task")
                    : false);
      const reread = record.recheck !== undefined && record.recheck !== props.agent.snapshot;
      if (
        absent ||
        (reread &&
          (record.kind === "answer" ||
            record.kind === "budget" ||
            record.kind === "resume" ||
            record.kind === "memory" ||
            props.agent.snapshot?.manualControl === "ready"))
      ) {
        operation.current = null;
        setStatus(null);
      }
    }
    if (stopStatus.phase === "paused" || stopStatus.phase === "stopped") {
      if (props.cell?.paused || props.cell?.state === "stopped") {
        containedCell.current = true;
        if (stopStatus.phase === "paused" && props.cell.state === "stopped")
          setStopStatus((status) => ({ ...status, phase: "stopped" }));
      } else if (
        containedCell.current &&
        props.cell?.state === "ready" &&
        props.cellPending === null
      ) {
        fence.current = false;
        setStopStatus(idleStop);
        containedCell.current = false;
      }
    }
  }, [props.agent, props.cell, props.cellPending, stopStatus.phase, authoritative]);
  const begin = (kind: Operation["kind"], target: string): Operation | null => {
    const now = current.current;
    if (!now.cell || !now.agent.sessionId) return null;
    const record: Operation = {
      api: now.api,
      cellId: now.cell.id,
      sessionId: now.agent.sessionId,
      kind,
      target,
      abort: new AbortController(),
      settled: false,
    };
    operation.current = record;
    return record;
  };
  const perform = async (
    kind: ControlStatus["kind"],
    target: string,
    request: (record: Operation) => Promise<void | string>,
  ) => {
    const record = begin(kind, target);
    if (!record) return false;
    setStatus({
      kind,
      target,
      phase: "sending",
      message: "Sending request…",
    });
    try {
      const acknowledgement = await request(record);
      if (!owned(record)) return false;
      record.settled = true;
      if (kind === "memory" && typeof acknowledgement === "string") {
        if (kind === "memory") {
          confirmedUndos.current.add(target);
          setMemoryUndone(new Set(confirmedUndos.current));
        }
        operation.current = null;
        setStatus(null);
      } else
        setStatus({
          kind,
          target,
          phase: "checking",
          message: "Request acknowledged. Checking task ownership…",
        });
      current.current.agent.reconcile();
      return true;
    } catch (error) {
      if (!owned(record)) return false;
      record.settled = true;
      const uncertain = !(error instanceof ControlFailure) || error.uncertain;
      setStatus({
        kind,
        target,
        phase: uncertain ? "uncertain" : "refused",
        ...(error instanceof ControlFailure && error.status !== undefined
          ? { code: error.status }
          : {}),
        message: uncertain
          ? "Delivery not confirmed. Check task state before trying again."
          : "The request was refused. Check the current task.",
      });
      current.current.agent.reconcile();
      return false;
    }
  };
  const answer = (body: QuestionAnswerRequest): Promise<boolean> => {
    const now = current.current,
      question = now.agent.model.questions.get(body.askId);
    if (
      !available() ||
      operation.current ||
      now.agent.model.pendingTakeover ||
      now.agent.model.pendingAsk !== body.askId ||
      !question ||
      question.answer ||
      (body.option && !question.options.some((option) => option.key === body.option)) ||
      (body.text && !question.allowText)
    )
      return Promise.resolve(false);
    return perform("answer", body.askId, (record) =>
      answerQuestion(record.api, record.sessionId, body, record.abort.signal),
    );
  };
  // Whatever dot is doing, or the computer dot handed over. dot's Pause, mid-change, settles first;
  // a held one stays held under the user's control.
  const takeReady = (now = current.current) =>
    available(now) &&
    !operation.current &&
    !heldByUser(now.agent.model) &&
    (now.agent.snapshot?.pause?.phase ?? "paused") === "paused";
  const take = (): Promise<boolean> => {
    if (!takeReady()) return Promise.resolve(false);
    return perform("take", "", async (record) => {
      await takeControl(record.api, record.sessionId, record.abort.signal);
    });
  };
  const handback = (requestId: string, note?: string): Promise<boolean> => {
    const now = current.current;
    if (
      !available() ||
      operation.current ||
      now.agent.model.pendingTakeover !== requestId ||
      !manualReady(now.agent.snapshot?.manualControl)
    )
      return Promise.resolve(false);
    return perform("handback", requestId, (record) =>
      returnControl(
        record.api,
        record.sessionId,
        { requestId, ...(note ? { note } : {}) },
        record.abort.signal,
      ),
    );
  };
  const stop = async () => {
    const now = current.current;
    if (operation.current?.kind === "stop" || now.cellPending !== null) return;
    const scope =
      now.cell && now.agent.sessionId
        ? { api: now.api, cellId: now.cell.id, sessionId: now.agent.sessionId }
        : stopScope.current;
    if (!scope || scope.api !== now.api) return;
    operation.current?.abort.abort();
    fence.current = true;
    stopScope.current = scope;
    const record: Operation = {
      ...scope,
      kind: "stop",
      target: "",
      abort: new AbortController(),
      settled: false,
    };
    operation.current = record;
    setStatus(null);
    setStopStatus({ phase: "sending", errors: [] });
    try {
      const outcome: StopOutcome = await stopTask(
        record.api,
        record.sessionId,
        record.abort.signal,
      );
      if (!owned(record)) return;
      setStopStatus({
        phase:
          outcome.revoked && outcome.paused
            ? "paused"
            : outcome.closed && outcome.stopped
              ? "stopped"
              : "unconfirmed",
        errors: outcome.errors,
      });
    } catch {
      if (owned(record)) setStopStatus({ phase: "unconfirmed", errors: [] });
    } finally {
      if (owned(record)) {
        operation.current = null;
        current.current.agent.reconcile();
        current.current.refreshCell();
      }
    }
  };
  const quiet = (now = current.current) =>
    available(now) &&
    !now.agent.snapshot?.approval &&
    !operation.current &&
    !now.agent.model.pendingAsk &&
    !now.agent.model.pendingTakeover &&
    !now.agent.snapshot?.pendingAsk &&
    !now.agent.snapshot?.pendingTakeover;
  const recoverable = (now = current.current) =>
    quiet(now) &&
    !now.agent.snapshot?.pause &&
    now.agent.snapshot?.status === "paused" &&
    now.agent.model.state?.state === "paused";
  // A held Pause keeps its own Resume, which waits until this task's budget is raised.
  const pausedAtBudget = (now = current.current) =>
    quiet(now) &&
    now.agent.snapshot?.pause?.phase === "paused" &&
    now.agent.snapshot.budgetHold === "task";
  const budgetReady = (now = current.current) =>
    now.agent.snapshot?.models?.kind !== "chatgpt" &&
    !now.agent.model.subscription &&
    (pausedAtBudget(now) ||
      (recoverable(now) &&
        now.agent.model.budget?.data.scope === "task" &&
        now.agent.model.budget.data.taskId === now.agent.sessionId));
  const raiseBudget = (budgetUSD: number) => {
    if (!budgetReady() || !BudgetRaiseRequest.safeParse({ budgetUSD }).success)
      return Promise.resolve(false);
    return perform("budget", current.current.agent.model.budget?.id ?? "", (record) =>
      raiseTaskBudget(record.api, record.sessionId, budgetUSD, record.abort.signal),
    );
  };
  const resume = () => {
    if (!recoverable()) return Promise.resolve(false);
    return perform("resume", "", (record) =>
      resumeTask(record.api, record.sessionId, record.abort.signal),
    );
  };
  const memoryReady = (now = current.current) =>
    available(now, true) &&
    !operation.current &&
    !now.agent.model.pendingAsk &&
    !now.agent.model.pendingTakeover &&
    !now.agent.snapshot?.pendingAsk &&
    !now.agent.snapshot?.pendingTakeover;
  const undo = (changeId: string) => {
    const now = current.current;
    const change = now.agent.model.changes.find(
      (row) => row.type === "memory" && row.changeId === changeId,
    );
    if (
      !memoryReady(now) ||
      confirmedUndos.current.has(changeId) ||
      !change ||
      !memoryUndoEligible(change, now.agent.model.changes)
    )
      return Promise.resolve(false);
    return perform("memory", changeId, (record) =>
      undoMemory(record.api, changeId, record.abort.signal),
    );
  };
  const recheck = () => {
    const record = operation.current;
    if (record?.settled && record.kind !== "stop") record.recheck = current.current.agent.snapshot;
    current.current.agent.reconcile();
    current.current.refreshCell();
  };
  return {
    status,
    stopStatus,
    answer,
    take,
    handback,
    raiseBudget,
    resume,
    undo,
    stop,
    recheck,
    busy: !!operation.current,
    fenced: fence.current,
    stopping: stopStatus.phase === "sending",
    canRaiseBudget: budgetReady(props),
    canResumeTask: recoverable(props),
    canUndoMemory: memoryReady(props),
    memoryUndone,
    canStop:
      operation.current?.kind !== "stop"
        ? props.cellPending === null &&
          Boolean((props.cell && props.agent.sessionId) || stopScope.current)
        : false,
    canAnswer: available(props) && !operation.current && !props.agent.model.pendingTakeover,
    canTake: takeReady(props),
    taking: operation.current?.kind === "take",
    canInput:
      available(props) &&
      !operation.current &&
      props.manualVisible &&
      manualReady(props.agent.snapshot?.manualControl),
    canHandback:
      available(props) && !operation.current && manualReady(props.agent.snapshot?.manualControl),
  };
}
export type TaskControls = ReturnType<typeof useTaskControls>;
