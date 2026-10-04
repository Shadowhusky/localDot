import type { ApprovalCard, EventOf } from "@localdot/protocol";
import type { TerminalText } from "./terminal-text.ts";

export const AGENT_LIMITS = Object.freeze({
  messages: 512,
  steps: 256,
  plan: 200,
  changes: 128,
  questions: 64,
  takeovers: 64,
  results: 64,
  messageText: 20_000,
  outputText: 65_536,
  patchText: 8192,
});
export interface AgentMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly final: boolean;
  readonly kind?: EventOf<"message.user">["data"]["kind"];
  readonly files?: readonly string[];
  readonly truncated?: boolean;
}
export interface AgentStep {
  readonly id: string;
  readonly firstSeenAt?: number;
  readonly kind?: EventOf<"step.start">["data"]["kind"];
  readonly planItem?: string;
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
  readonly answer?: EventOf<"ask.answer">["data"];
};
export type AgentTakeover = EventOf<"takeover.request">["data"] & {
  readonly end?: EventOf<"takeover.end">["data"];
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
  readonly summary: string;
  readonly files: readonly EventOf<"task.result">["data"]["files"][number][];
}
export type UsageRow = EventOf<"model.usage">["data"] & {
  readonly calls: number;
  readonly reasoningPartial: boolean;
};
export interface Reported<T> {
  readonly id: string;
  readonly at: number;
  readonly data: T;
}
export interface AgentModel {
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
  readonly safetyPaused?: { readonly paused: boolean; readonly atStepBoundary: boolean };
  readonly safetyPause?: EventOf<"safety.pause">["data"]["pause"];
  readonly pendingAsk: string | null;
  readonly pendingTakeover: string | null;
  readonly changes: readonly AgentChange[];
  readonly results: readonly AgentResult[];
  readonly usage: readonly UsageRow[];
  readonly usagePartial: boolean;
  readonly retry: Reported<EventOf<"model.retry">["data"]> | null;
  readonly subscription: Reported<EventOf<"subscription.usage">["data"]> | null;
  readonly budget: Reported<EventOf<"budget.exceeded">["data"]> | null;
  // Older material can be fetched from the event log by the later history UI. Never imply that
  // a bounded projection is the complete transcript.
  readonly historyTruncated: boolean;
  readonly activity?: string;
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
    usage: [],
    usagePartial: false,
    retry: null,
    subscription: null,
    budget: null,
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
  readonly streamError: string | null;
  readonly model: AgentModel;
}
export interface AgentFeed {
  read(): AgentFeedState;
  // Only authority/transport invalidations notify; token deltas use the existing 10 Hz flush.
  subscribe(listener: () => void): () => void;
}
