import type {
  ActionClass,
  ApprovalCard,
  EventOf,
  ResearchBudget,
  ResearchSourceData,
  ResearchStop,
  RuleChange,
  ScreenSelectionSnapshot,
  SessionOrigin,
} from "@localdot/protocol";
import type { TerminalText } from "./terminal-text.ts";

export const AGENT_LIMITS = Object.freeze({
  messages: 512,
  steps: 256,
  plan: 200,
  changes: 128,
  questions: 64,
  takeovers: 64,
  results: 64,
  routineProposals: 16,
  spendCalls: 2048,
  usageCalls: 2048,
  messageText: 20_000,
  outputText: 65_536,
  patchText: 8192,
});
// seq orders the conversation; at is the session time (µs) it was first seen.
export interface AgentMessage {
  readonly id: string;
  readonly seq?: number;
  readonly at?: number;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly final: boolean;
  // When dot's reply was whole: the session time (µs) of its final text.
  readonly doneAt?: number;
  readonly kind?: EventOf<"message.user">["data"]["kind"];
  // A follow-up sent while dot was still working, so it waits for the task to finish.
  readonly queued?: boolean;
  readonly files?: readonly string[];
  readonly truncated?: boolean;
}
export interface AgentStep {
  readonly id: string;
  readonly firstSeenAt?: number;
  readonly kind?: EventOf<"step.start">["data"]["kind"];
  readonly planItem?: string;
  // dot's line for the user about the call this step starts.
  readonly intent?: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly status?: EventOf<"step.end">["data"]["status"];
  readonly note?: string;
  readonly tool?: {
    readonly name: string;
    readonly title: string;
    readonly ok?: boolean;
    readonly exitCode?: number;
  };
  readonly output: readonly { readonly stream: "stdout" | "stderr"; readonly text: string }[];
  readonly outputTruncated: boolean;
  readonly terminal?: TerminalText;
}
export type AgentQuestion = EventOf<"ask.request">["data"] & {
  readonly seq?: number;
  readonly at?: number;
  readonly answer?: EventOf<"ask.answer">["data"];
};
export type AgentTakeover = EventOf<"takeover.request">["data"] & {
  readonly seq?: number;
  // Wall-clock ms of the hand-over and of its end.
  readonly time?: number;
  // When the user took the computer dot handed over.
  readonly taken?: { readonly seq: number; readonly time: number };
  readonly end?: EventOf<"takeover.end">["data"];
  readonly endSeq?: number;
  readonly endTime?: number;
};
export interface AgentChange {
  readonly id: string;
  readonly step?: string;
  readonly type: "file" | "memory";
  readonly path: string;
  readonly op?: EventOf<"file.change">["data"]["op"];
  readonly patch?: string;
  readonly truncated: boolean;
  readonly changeId?: string;
  readonly undoes?: string;
}
export interface AgentResult {
  readonly id: string;
  // An earlier task's result in the conversation: its files are that task's.
  readonly sessionId?: string;
  readonly seq?: number;
  readonly at?: number;
  readonly summary: string;
  readonly files: readonly EventOf<"task.result">["data"]["files"][number][];
}
// A routine dot drafted in this task; it runs only once the user saves it.
export type RoutineProposal = EventOf<"routine.proposed">["data"] & {
  readonly id: string;
  readonly seq: number;
};
// A research task: its budget, why gathering stopped, and its numbered sources in order.
export interface AgentResearch {
  // Session time (ms) the research began, for the minutes it has used.
  readonly startMs: number;
  readonly budget: ResearchBudget;
  readonly stopped?: ResearchStop;
  readonly sources: readonly ResearchSourceData[];
}
export type UsageRow = EventOf<"model.usage">["data"] & {
  readonly calls: number;
  readonly reasoningPartial: boolean;
};
// One model call's tokens, at its session time, as the provider reported them.
export interface UsageCall {
  readonly atMs: number;
  readonly role: string;
  readonly route: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens?: number;
}
// One model call's cost, at its session time, as keyd charged it.
export interface SpendCall {
  readonly atMs: number;
  readonly route: string;
  readonly model: string;
  readonly usd: number;
  readonly estimated: boolean;
}
// What this task and today have cost so far, by keyd's account. Estimated once any call was.
export interface AgentSpend {
  readonly taskUSD: number;
  readonly dayUSD: number;
  readonly estimated: boolean;
  readonly taskLimitUSD?: number;
  readonly dayLimitUSD?: number;
}
export interface Reported<T> {
  readonly id: string;
  readonly at: number;
  readonly data: T;
}
// The last decision, its note, and the Always allow choice it saved, for the Undo line.
export interface ApprovalOutcome {
  readonly approvalId: string;
  readonly decision: EventOf<"approval.resolve">["data"]["decision"];
  readonly actionClass?: ActionClass;
  readonly note?: string;
  readonly rule?: RuleChange;
  readonly ruleRemoved?: boolean;
}
export interface AgentModel {
  readonly screen?: ScreenSelectionSnapshot;
  readonly lastSeq: number;
  readonly state: EventOf<"agent.state">["data"] | null;
  readonly ended: EventOf<"session.end">["data"] | null;
  readonly lastHeartbeat: {
    readonly t: number;
    readonly everyMs: number;
    readonly ongoing: boolean;
    readonly receivedAt?: number;
  } | null;
  readonly messages: ReadonlyMap<string, AgentMessage>;
  readonly steps: ReadonlyMap<string, AgentStep>;
  readonly plan: readonly EventOf<"plan.set">["data"]["items"][number][];
  readonly questions: ReadonlyMap<string, AgentQuestion>;
  readonly takeovers: ReadonlyMap<string, AgentTakeover>;
  readonly approval?: ApprovalCard | null;
  // A connection's card, which waits for the user beside the task's own decisions.
  readonly connection?: ApprovalCard | null;
  readonly approvalOutcome?: ApprovalOutcome;
  readonly safetyPaused?: { readonly paused: boolean; readonly atStepBoundary: boolean };
  readonly safetyPause?: EventOf<"safety.pause">["data"]["pause"];
  readonly pendingAsk: string | null;
  readonly pendingTakeover: string | null;
  readonly changes: readonly AgentChange[];
  readonly results: readonly AgentResult[];
  // What started the task when the user did not: a routine or a follow-up.
  readonly origin?: SessionOrigin;
  readonly research: AgentResearch | null;
  readonly routineProposals: ReadonlyMap<string, RoutineProposal>;
  readonly usage: readonly UsageRow[];
  readonly usageCalls: readonly UsageCall[];
  readonly usagePartial: boolean;
  readonly retry: Reported<EventOf<"model.retry">["data"]> | null;
  // The model call waits out that retry: no later state has said otherwise.
  readonly retrying: boolean;
  readonly subscription: Reported<EventOf<"subscription.usage">["data"]> | null;
  readonly budget: Reported<EventOf<"budget.exceeded">["data"]> | null;
  readonly spend: AgentSpend | null;
  readonly spendCalls: readonly SpendCall[];
  // Older material can be fetched from the event log by the later history UI. Never imply that
  // a bounded projection is the complete transcript.
  readonly historyTruncated: boolean;
}
// The hand-over the user holds the computer under: one they asked for, or dot's once they took it.
export function heldByUser(model: AgentModel): AgentTakeover | undefined {
  const held = model.pendingTakeover ? model.takeovers.get(model.pendingTakeover) : undefined;
  return held && (held.by === "user" || held.taken) ? held : undefined;
}

export function emptyAgentModel(): AgentModel {
  return {
    lastSeq: -1,
    state: null,
    ended: null,
    lastHeartbeat: null,
    messages: new Map(),
    steps: new Map(),
    plan: [],
    questions: new Map(),
    takeovers: new Map(),
    pendingAsk: null,
    pendingTakeover: null,
    changes: [],
    results: [],
    routineProposals: new Map(),
    research: null,
    usage: [],
    usageCalls: [],
    usagePartial: false,
    retry: null,
    retrying: false,
    subscription: null,
    budget: null,
    spend: null,
    spendCalls: [],
    historyTruncated: false,
  };
}
export type AgentConnection = "connecting" | "live" | "lost" | "ended";
export interface AgentFeedState {
  readonly cellId: string | null;
  readonly sessionId: string | null;
  readonly epoch: number;
  readonly connection: AgentConnection;
  // This connection has delivered a valid in-order or duplicate replay packet.
  readonly replayed: boolean;
  // The task's history so far has arrived, read whole or from the live feed's first packet.
  readonly history: boolean;
  readonly streamError: string | null;
  readonly model: AgentModel;
}
export interface AgentFeed {
  read(): AgentFeedState;
  // Only authority/transport invalidations notify; token deltas use the existing 10 Hz flush.
  subscribe(listener: () => void): () => void;
}
// New words for a message already on show, at most ten times a second: only that message draws
// again for them, not the page.
export interface AgentWords {
  read(): AgentFeedState;
  subscribeWords(listener: () => void): () => void;
}
