import {
  ApprovalCard,
  LocalDotEvent as EventSchema,
  type LocalDotEvent,
  MAX_RESEARCH_SOURCES,
  microsToMs,
  STALL,
  ulidTime,
} from "@localdot/protocol";
import {
  type AgentConnection,
  type AgentFeed,
  type AgentFeedState,
  type AgentModel,
  type AgentStep,
  type AgentWords,
  emptyAgentModel,
  AGENT_LIMITS as L,
} from "./model.ts";
import { appendTerminal, emptyTerminal, finishTerminal } from "./terminal-text.ts";

// While dot is in one of these, a follow-up waits for the task to finish.
const WORKING = new Set(["thinking", "acting", "observing", "waiting_user", "paused"]);
const STREAM_ERROR = "Activity could not be verified. Reconnect to load it again.";
const GAP_ERROR = "Some activity is missing. Reconnect to load it again.";
const RELEVANT = new Set<LocalDotEvent["type"]>([
  "agent.state",
  "screen.switch",
  "ask.request",
  "ask.answer",
  "takeover.request",
  "takeover.end",
  "session.end",
  "control.change",
  "pause.change",
  "safety.pause",
  "approval.request",
  "approval.resolve",
  "rule.created",
  "rule.removed",
  "budget.exceeded",
  "model.retry",
  "subscription.usage",
]);
function put<T>(
  old: ReadonlyMap<string, T>,
  id: string,
  value: T,
  max: number,
): ReadonlyMap<string, T> {
  const next = new Map(old);
  next.set(id, value);
  while (next.size > max) {
    const key = next.keys().next().value;
    if (key === undefined) break;
    next.delete(key);
  }
  return next;
}
// A message keeps its place in the conversation as later deltas and its final text arrive.
function firstSeen(old: { seq?: number; at?: number } | undefined, e: LocalDotEvent) {
  return { seq: old?.seq ?? e.seq, at: old?.at ?? e.t };
}
function step(model: AgentModel, id: string): AgentStep {
  return model.steps.get(id) ?? { id, output: [], outputTruncated: false };
}
function output(row: AgentStep, stream: "stdout" | "stderr", chunk: string): AgentStep {
  let entries = row.output.map((entry) => ({ ...entry }));
  const last = entries.at(-1);
  if (last?.stream === stream) last.text += chunk;
  else entries.push({ stream, text: chunk });
  let size = entries.reduce((sum, entry) => sum + entry.text.length, 0);
  const truncated = row.outputTruncated || size > L.outputText;
  while (size > L.outputText && entries.length) {
    const first = entries[0];
    if (!first) break;
    const remove = Math.min(first.text.length, size - L.outputText);
    first.text = first.text.slice(remove);
    size -= remove;
    if (!first.text) entries.shift();
  }
  // Alternating empty chunks cannot create an unbounded list of output nodes.
  entries = entries.filter((entry) => entry.text.length > 0);
  const nodesTruncated = entries.length > 512;
  if (nodesTruncated) entries = entries.slice(-512);
  return {
    ...row,
    output: entries,
    outputTruncated: truncated || nodesTruncated,
    terminal: appendTerminal(row.terminal ?? emptyTerminal(), stream, chunk),
  };
}

// Pure projection of already schema-checked events. Identity is messageId, request ID or envelope
// step, never message text, arrival position or the last tool shown on screen.
export function projectAgentEvent(model: AgentModel, event: LocalDotEvent): AgentModel {
  if (event.seq <= model.lastSeq || model.ended) return model;
  let next: AgentModel = { ...model, lastSeq: event.seq };
  const e = event;
  switch (e.type) {
    case "screen.switch": {
      const { screen, cellId, geometry, revision } = e.data;
      next = { ...next, screen: { screen, cellId, geometry, revision } };
      break;
    }
    case "agent.state":
      next = {
        ...next,
        state: { ...e.data },
        // Tool-completion notifications can say thinking after task.result. Only an
        // actual return from the follow-up window starts a new turn here.
        completion:
          WORKING.has(e.data.state) &&
          (model.state?.state === "idle" || model.state?.state === "done")
            ? undefined
            : model.completion,
        retrying: model.retrying && e.data.state === "paused" && e.data.reason === STALL.modelBusy,
      };
      break;
    case "session.end":
      next = { ...next, ended: { ...e.data }, pendingAsk: null, pendingTakeover: null };
      break;
    case "approval.request": {
      const { kind: _kind, target: _target, preview, ...card } = e.data;
      const parsed = ApprovalCard.parse({ ...card, fields: preview.fields });
      next =
        parsed.actionClass === "network"
          ? { ...next, connection: parsed }
          : { ...next, approval: parsed };
      break;
    }
    case "approval.resolve": {
      const card =
        [model.approval, model.connection].find((c) => c?.approvalId === e.data.approvalId) ?? null;
      next = {
        ...next,
        ...(card && card === model.approval ? { approval: null } : {}),
        ...(card && card === model.connection ? { connection: null } : {}),
        approvalOutcome: {
          approvalId: e.data.approvalId,
          decision: e.data.decision,
          ...(card ? { actionClass: card.actionClass } : {}),
          ...(e.data.note ? { note: e.data.note } : {}),
        },
      };
      break;
    }
    // The daemon appends a choice's rule.created right after the approval.resolve that saved it.
    case "rule.created": {
      const outcome = model.approvalOutcome;
      if (outcome && !outcome.rule && !outcome.note && outcome.actionClass === e.data.actionClass)
        next = { ...next, approvalOutcome: { ...outcome, rule: { ...e.data } } };
      break;
    }
    case "rule.removed": {
      const outcome = model.approvalOutcome,
        rule = outcome?.rule;
      if (
        outcome &&
        rule &&
        rule.id === e.data.id &&
        rule.actionClass === e.data.actionClass &&
        rule.scope === e.data.scope &&
        rule.destination === e.data.destination
      )
        next = { ...next, approvalOutcome: { ...outcome, ruleRemoved: true } };
      break;
    }
    case "pause.change":
      next = { ...next, safetyPaused: { ...e.data } };
      break;
    case "safety.pause":
      next = { ...next, safetyPause: e.data.pause };
      break;
    case "heartbeat":
      next = { ...next, lastHeartbeat: { t: e.t, ...e.data } };
      break;
    case "model.usage": {
      const old = model.usage.find(
        (row) =>
          row.role === e.data.role && row.route === e.data.route && row.model === e.data.model,
      );
      const add = (a: number, b: number) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
      const row = {
        ...e.data,
        inputTokens: add(old?.inputTokens ?? 0, e.data.inputTokens),
        outputTokens: add(old?.outputTokens ?? 0, e.data.outputTokens),
        ...(old?.reasoningTokens !== undefined || e.data.reasoningTokens !== undefined
          ? { reasoningTokens: add(old?.reasoningTokens ?? 0, e.data.reasoningTokens ?? 0) }
          : {}),
        calls: add(old?.calls ?? 0, 1),
        reasoningPartial: (old?.reasoningPartial ?? false) || e.data.reasoningTokens === undefined,
      };
      const rows = [...model.usage.filter((value) => value !== old), row];
      const call = {
        atMs: microsToMs(e.t),
        role: e.data.role,
        route: e.data.route,
        model: e.data.model,
        inputTokens: e.data.inputTokens,
        outputTokens: e.data.outputTokens,
        ...(e.data.reasoningTokens === undefined
          ? {}
          : { reasoningTokens: e.data.reasoningTokens }),
      };
      next = {
        ...next,
        usage: rows.slice(-12),
        usageCalls: [...model.usageCalls, call].slice(-L.usageCalls),
        usagePartial:
          model.usagePartial ||
          rows.length > 12 ||
          [row.inputTokens, row.outputTokens, row.reasoningTokens, row.calls].some(
            (value) => value === Number.MAX_SAFE_INTEGER,
          ),
      };
      break;
    }
    case "model.retry":
      next = {
        ...next,
        retry: { id: e.id, at: e.t, data: { ...e.data } },
        retrying: e.data.waitMs > 0 && !e.data.fallback,
      };
      break;
    case "subscription.usage":
      next = {
        ...next,
        subscription: {
          id: e.id,
          at: e.t,
          data: { ...e.data, windows: e.data.windows.map((window) => ({ ...window })) },
        },
      };
      break;
    case "budget.exceeded":
      next = { ...next, budget: { id: e.id, at: e.t, data: { ...e.data } } };
      break;
    case "model.spend": {
      const estimated = e.data.basis === "estimated";
      const call = {
        atMs: microsToMs(e.t),
        route: e.data.route,
        model: e.data.model,
        usd: e.data.costUSD,
        estimated,
      };
      next = {
        ...next,
        spend: {
          taskUSD: e.data.taskSpentUSD,
          dayUSD: e.data.daySpentUSD,
          estimated: (model.spend?.estimated ?? false) || estimated,
          ...(e.data.taskLimitUSD === undefined ? {} : { taskLimitUSD: e.data.taskLimitUSD }),
          ...(e.data.dayLimitUSD === undefined ? {} : { dayLimitUSD: e.data.dayLimitUSD }),
        },
        spendCalls: [...model.spendCalls, call].slice(-L.spendCalls),
      };
      break;
    }
    case "message.user": {
      const seen = model.messages.get(e.data.messageId);
      const queued =
        e.data.queued ??
        seen?.queued ??
        (e.data.kind === "followup" && WORKING.has(model.state?.state ?? "idle"));
      next = {
        ...next,
        messages: put(
          model.messages,
          e.data.messageId,
          {
            id: e.data.messageId,
            ...firstSeen(seen, e),
            role: "user",
            text: e.data.text,
            final: true,
            kind: e.data.kind,
            ...(e.data.sessionId ? { sessionId: e.data.sessionId } : {}),
            ...(queued ? { queued } : {}),
            ...(e.data.files ? { files: [...e.data.files] } : {}),
          },
          L.messages,
        ),
        historyTruncated:
          next.historyTruncated ||
          (!model.messages.has(e.data.messageId) && model.messages.size >= L.messages),
      };
      break;
    }
    case "message.delivery": {
      const message = model.messages.get(e.data.messageId);
      if (message)
        next = {
          ...next,
          messages: put(
            model.messages,
            message.id,
            {
              ...message,
              queued: false,
              delivery: e.data.state,
              ...(e.data.state === "steering" ? { kind: "steer" as const } : {}),
            },
            L.messages,
          ),
        };
      break;
    }
    case "message.delta": {
      const old = model.messages.get(e.data.messageId);
      if (old?.final || old?.role === "user") break;
      const text = (old?.text ?? "") + e.data.text;
      next = {
        ...next,
        messages: put(
          model.messages,
          e.data.messageId,
          {
            id: e.data.messageId,
            ...firstSeen(old, e),
            role: "assistant",
            text: text.slice(0, L.messageText),
            final: false,
            truncated: old?.truncated || text.length > L.messageText,
          },
          L.messages,
        ),
        historyTruncated: next.historyTruncated || (!old && model.messages.size >= L.messages),
      };
      break;
    }
    case "message.assistant": {
      const old = model.messages.get(e.data.messageId);
      if (old?.role === "user") break;
      next = {
        ...next,
        messages: put(
          model.messages,
          e.data.messageId,
          {
            id: e.data.messageId,
            ...firstSeen(old, e),
            role: "assistant",
            text: e.data.text,
            final: true,
            doneAt: e.t,
          },
          L.messages,
        ),
        historyTruncated: next.historyTruncated || (!old && model.messages.size >= L.messages),
      };
      break;
    }
    case "plan.set":
      next = {
        ...next,
        plan: e.data.items.slice(0, L.plan).map((item) => ({ ...item })),
        historyTruncated: next.historyTruncated || e.data.items.length > L.plan,
      };
      break;
    case "plan.update":
      next = {
        ...next,
        plan: model.plan.map((item) =>
          item.id === e.data.id ? { ...item, status: e.data.status } : item,
        ),
      };
      break;
    case "step.start":
    case "step.end":
    case "tool.start":
    case "tool.output":
    case "tool.end": {
      if (!e.step) break;
      if (e.type === "step.start") next = { ...next, completion: undefined };
      const old = step(model, e.step);
      let row: AgentStep = { ...old, firstSeenAt: old.firstSeenAt ?? e.t };
      if (e.type === "step.start")
        row = {
          ...row,
          kind: e.data.kind,
          planItem: e.data.planItem,
          ...(e.data.intent ? { intent: e.data.intent } : {}),
          startedAt: e.t,
        };
      else if (e.type === "step.end")
        row = { ...row, status: e.data.status, note: e.data.note, endedAt: e.t };
      else if (e.type === "tool.start")
        row = {
          ...row,
          tool: { name: e.data.tool, title: e.data.title },
          terminal: row.terminal ?? emptyTerminal(),
        };
      else if (e.type === "tool.output") row = output(row, e.data.stream, e.data.chunk);
      else if (row.tool)
        row = {
          ...row,
          tool: { ...row.tool, ok: e.data.ok, exitCode: e.data.exitCode },
          ...(row.terminal ? { terminal: finishTerminal(row.terminal) } : {}),
        };
      next = {
        ...next,
        steps: put(model.steps, e.step, row, L.steps),
        historyTruncated:
          next.historyTruncated || (!model.steps.has(e.step) && model.steps.size >= L.steps),
      };
      break;
    }
    case "ask.request":
      next = {
        ...next,
        pendingAsk: e.data.askId,
        questions: put(
          model.questions,
          e.data.askId,
          {
            ...e.data,
            ...firstSeen(model.questions.get(e.data.askId), e),
            options: e.data.options.map((option) => ({ ...option })),
          },
          L.questions,
        ),
        historyTruncated: next.historyTruncated || model.questions.size >= L.questions,
      };
      break;
    case "ask.answer": {
      const old = model.questions.get(e.data.askId);
      next = {
        ...next,
        pendingAsk: model.pendingAsk === e.data.askId ? null : model.pendingAsk,
        questions: old
          ? put(model.questions, e.data.askId, { ...old, answer: { ...e.data } }, L.questions)
          : model.questions,
      };
      break;
    }
    case "takeover.request":
      next = {
        ...next,
        pendingTakeover: e.data.requestId,
        takeovers: put(
          model.takeovers,
          e.data.requestId,
          {
            ...e.data,
            seq: model.takeovers.get(e.data.requestId)?.seq ?? e.seq,
            time: ulidTime(e.id),
          },
          L.takeovers,
        ),
        historyTruncated: next.historyTruncated || model.takeovers.size >= L.takeovers,
      };
      break;
    case "control.change": {
      const held = model.pendingTakeover ? model.takeovers.get(model.pendingTakeover) : undefined;
      if (e.data.holder === "user" && held && !held.taken)
        next = {
          ...next,
          takeovers: put(
            model.takeovers,
            held.requestId,
            { ...held, taken: { seq: e.seq, time: ulidTime(e.id) } },
            L.takeovers,
          ),
        };
      break;
    }
    case "takeover.end": {
      const old = model.takeovers.get(e.data.requestId);
      next = {
        ...next,
        pendingTakeover: model.pendingTakeover === e.data.requestId ? null : model.pendingTakeover,
        takeovers: old
          ? put(
              model.takeovers,
              e.data.requestId,
              { ...old, end: { ...e.data }, endSeq: e.seq, endTime: ulidTime(e.id) },
              L.takeovers,
            )
          : model.takeovers,
      };
      break;
    }
    case "file.change":
    case "memory.change": {
      const patch = e.data.patch;
      const change =
        e.type === "file.change"
          ? {
              id: e.id,
              ...(e.step ? { step: e.step } : {}),
              type: "file" as const,
              path: e.data.path.slice(0, 1024),
              op: e.data.op,
              patch: patch?.slice(0, L.patchText),
              truncated: e.data.path.length > 1024 || (patch?.length ?? 0) > L.patchText,
            }
          : {
              id: e.id,
              ...(e.step ? { step: e.step } : {}),
              type: "memory" as const,
              path: e.data.file,
              patch: patch?.slice(0, L.patchText),
              changeId: e.data.changeId,
              undoes: e.data.undoes,
              truncated: (patch?.length ?? 0) > L.patchText,
            };
      next = {
        ...next,
        changes: [...model.changes, change].slice(-L.changes),
        historyTruncated: next.historyTruncated || model.changes.length >= L.changes,
      };
      break;
    }
    case "session.start":
      if (e.data.origin) next = { ...next, origin: e.data.origin };
      if (e.data.research)
        next = {
          ...next,
          research: { startMs: microsToMs(e.t), budget: { ...e.data.research }, sources: [] },
        };
      break;
    case "research.budget":
      if (model.research) {
        const { stopped, ...budget } = e.data;
        next = {
          ...next,
          research: {
            startMs: model.research.startMs,
            budget,
            sources: model.research.sources,
            ...(stopped ? { stopped } : {}),
          },
        };
      }
      break;
    case "research.source":
      if (model.research && e.data.n <= MAX_RESEARCH_SOURCES) {
        const sources = model.research.sources.filter((source) => source.n !== e.data.n);
        sources.push({ ...e.data });
        sources.sort((a, b) => a.n - b.n);
        next = { ...next, research: { ...model.research, sources } };
      }
      break;
    case "routine.proposed":
      next = {
        ...next,
        routineProposals: put(
          model.routineProposals,
          e.data.routineId,
          { ...e.data, id: e.id, seq: e.seq },
          L.routineProposals,
        ),
      };
      break;
    case "task.result":
      next = {
        ...next,
        completion: e.data.outcome ?? "complete",
        results: [
          ...model.results,
          {
            id: e.id,
            seq: e.seq,
            at: e.t,
            summary: e.data.summary,
            ...(e.data.outcome ? { outcome: e.data.outcome } : {}),
            files: e.data.files.map((file) => ({ ...file })),
          },
        ].slice(-L.results),
        historyTruncated: next.historyTruncated || model.results.length >= L.results,
      };
      break;
  }
  return next;
}

export function parseAgentEvent(data: string): LocalDotEvent | null {
  try {
    if (data.length > 1_048_576 || new TextEncoder().encode(data).byteLength > 1_048_576)
      return null;
    const parsed = EventSchema.safeParse(JSON.parse(data));
    if (!parsed.success) return null;
    return wellFormed(parsed.data) ? parsed.data : null;
  } catch {
    return null;
  }
}

function wellFormed(e: LocalDotEvent): boolean {
  const id = (value: string) => value.length > 0 && value.length <= 512;
  if (e.step !== undefined && !id(e.step)) return false;
  if (e.type === "plan.set" && e.data.items.some((item) => !id(item.id))) return false;
  if (e.type === "plan.update" && !id(e.data.id)) return false;
  if (e.type === "step.start" && e.data.planItem !== undefined && !id(e.data.planItem))
    return false;
  if (e.type === "tool.start" && e.data.tool.length > 256) return false;
  return true;
}
export interface AgentFeedOwner extends AgentFeed, AgentWords {
  reset(cellId: string | null, sessionId: string | null): void;
  bindCell(cellId: string | null): void;
  // Tells the messages on show that new words arrived.
  words(): void;
  connection(value: AgentConnection): void;
  accept(data: string): LocalDotEvent | null;
  // The task's history, read whole before the live feed opens. The daemon leaves out what the
  // conversation never shows, so its sequence has gaps; the live feed goes on from its last event.
  load(events: readonly LocalDotEvent[]): void;
}
export function createAgentFeed(now: () => number = () => performance.now()): AgentFeedOwner {
  let value: AgentFeedState = {
    cellId: null,
    sessionId: null,
    epoch: 0,
    connection: "connecting",
    replayed: false,
    history: false,
    streamError: null,
    model: emptyAgentModel(),
  };
  const listeners = new Set<() => void>();
  const wordListeners = new Set<() => void>();
  let missingThrough = -1;
  let invalidPayload = false;
  const invalidate = () => {
    value = { ...value, epoch: value.epoch + 1 };
    for (const listener of listeners) listener();
  };
  return {
    read: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeWords: (listener) => {
      wordListeners.add(listener);
      return () => {
        wordListeners.delete(listener);
      };
    },
    words() {
      for (const listener of wordListeners) listener();
    },
    bindCell(cellId) {
      if (value.cellId === cellId) return;
      value = { ...value, cellId };
      invalidate();
    },
    reset(cellId, sessionId) {
      missingThrough = -1;
      invalidPayload = false;
      value = {
        cellId,
        sessionId,
        epoch: value.epoch,
        connection: "connecting",
        replayed: false,
        history: false,
        streamError: null,
        model: emptyAgentModel(),
      };
      invalidate();
    },
    connection(connection) {
      if (value.connection === connection) return;
      value = {
        ...value,
        connection,
        replayed: connection === "ended" && value.model.ended ? value.replayed : false,
      };
      invalidate();
    },
    accept(data) {
      const event = parseAgentEvent(data);
      if (!event) {
        invalidPayload = true;
        value = { ...value, streamError: STREAM_ERROR };
        invalidate();
        return null;
      }
      if (value.model.ended) return null;
      if (event.seq <= value.model.lastSeq) {
        // Replayed history establishes receipt on this transport without applying it twice.
        if (value.connection === "live" && !value.streamError && !value.replayed) {
          value = { ...value, replayed: true, history: true };
          invalidate();
        }
        return null;
      }
      if (event.seq !== value.model.lastSeq + 1) {
        missingThrough = Math.max(missingThrough, event.seq);
        value = { ...value, streamError: invalidPayload ? STREAM_ERROR : GAP_ERROR };
        invalidate();
        return null;
      }
      value = { ...value, model: projectAgentEvent(value.model, event) };
      if (event.type === "heartbeat" && value.model.lastHeartbeat)
        value = {
          ...value,
          model: {
            ...value.model,
            lastHeartbeat: { ...value.model.lastHeartbeat, receivedAt: now() },
          },
        };
      const recovered =
        !invalidPayload && value.streamError === GAP_ERROR && event.seq >= missingThrough;
      if (recovered) {
        missingThrough = -1;
        value = { ...value, streamError: null };
      }
      const firstReplay = value.connection === "live" && !value.streamError && !value.replayed;
      if (firstReplay) value = { ...value, replayed: true, history: true };
      if (RELEVANT.has(event.type) || recovered || firstReplay) invalidate();
      return event;
    },
    load(events) {
      let model = value.model;
      for (const event of events) if (wellFormed(event)) model = projectAgentEvent(model, event);
      // A task whose history ends has no live feed to confirm it: the history is the whole of it.
      value = { ...value, model, history: true, replayed: value.replayed || !!model.ended };
      invalidate();
    },
  };
}
