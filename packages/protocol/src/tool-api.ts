import { z } from "zod";
import { ConnectorToolSpec, MAX_TASK_CONNECTOR_TOOLS } from "./connectors.ts";
import { EarlierTurns } from "./conversation.ts";
import {
  AgentState,
  Heartbeat,
  MessageAssistant,
  MessageDelta,
  ModelRetry,
  ModelUsage,
  SubagentState,
  SubagentStop,
  ThoughtDelta,
} from "./events.ts";
import { ULID_PATTERN } from "./ids.ts";
import { ModelControls, ModelOptions } from "./model-options.ts";
import { RECENT_TASKS, RecentLine } from "./recent-activity.ts";
import { ResearchBudget } from "./research.ts";
import { SessionRun } from "./routines.ts";

// The brain's tool API (spec "Ports": 4751). The brain calls only these, through its gate, with
// its own bearer token; everything it may do to the computer or the user goes through them.
export const TOOL_API_PORT = 4751;

// How the brain drives the screen with a given model (spec "Catalog"):
// - anthropic-toolset: Anthropic's computer_toolset_20260801 (Claude 5.x);
// - anthropic-legacy: computer_20250124, for Claude models that predate the toolset;
// - generic: localDot's own computer tool, in `coords` space;
// - none: a text-only model, which gets shell, files and page reading but no screen.
export const ComputerMode = z.enum(["anthropic-toolset", "anthropic-legacy", "generic", "none"]);
export type ComputerMode = z.infer<typeof ComputerMode>;

export const CoordSpaceName = z.enum(["pixels", "per1000"]);
export type CoordSpaceName = z.infer<typeof CoordSpaceName>;

// The SDK client a route needs. The first-class providers each have their official AI SDK package
// (spec "First-class providers"); every other provider speaks OpenAI's chat completions, so it goes
// through @ai-sdk/openai-compatible and keyd's openai-compatible kind (P5a-R4), or Anthropic's
// messages at a base URL the user names, through @ai-sdk/anthropic.
export const ClientKind = z.enum([
  "anthropic",
  "openai",
  "google",
  "xai",
  "mistral",
  "deepseek",
  "groq",
  "openrouter",
  "openai-compatible",
  "azure",
  "anthropic-compatible",
  "lmstudio",
  "ollama",
]);
export type ClientKind = z.infer<typeof ClientKind>;

export const ModelBinding = z.object({
  provider: z.string().optional(),
  options: ModelOptions.optional(),
  controls: ModelControls.optional(),
  route: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  client: ClientKind,
  model: z.string().min(1).max(128),
  // keyd's stand-in for the route's key; local routes have none. Worthless off this Mac.
  surrogate: z.string().optional(),
  computer: ComputerMode,
  coords: CoordSpaceName,
  vision: z.boolean(),
  reasoning: z.boolean(),
  contextTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  // What the task set aside per million tokens for a premium speed: a router that takes a price
  // cap is held to it, so a pricier endpoint is passed over rather than billed.
  maxPrice: z
    .strictObject({
      inputUSDPerMTok: z.number().nonnegative().max(10_000),
      outputUSDPerMTok: z.number().nonnegative().max(10_000),
    })
    .optional(),
});
export type ModelBinding = z.infer<typeof ModelBinding>;

export const SkillSummary = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  description: z.string().max(1024),
  // Where the skill's folder is in the desktop (copied there at session start).
  path: z.string().max(1024),
});
export type SkillSummary = z.infer<typeof SkillSummary>;

// The check-ins are the user's to turn on: without maxTurns dot never asks "Keep going?", and
// without maxFailedCalls repeated failures go back to the model as a cue to change approach.
export const AgentLimits = z.object({
  maxTurns: z.number().int().positive().optional(),
  maxFailedCalls: z.number().int().positive().optional(),
  maxRetries: z.number().int().nonnegative(),
});
export type AgentLimits = z.infer<typeof AgentLimits>;

export const DEFAULT_AGENT_LIMITS: AgentLimits = { maxRetries: 8 };

// What a delegated agent was asked and had done, kept with its task so that a later task in the
// conversation can hand the unfinished work to a fresh agent. A task keeps the newest few.
export const MAX_SUBAGENT_BRIEFS = 16;
export const SubagentBrief = z.strictObject({
  id: z.string().min(1).max(128),
  label: z.string().max(200),
  instructions: z.string().max(3000),
  progress: z.string().max(5000),
});
export type SubagentBrief = z.infer<typeof SubagentBrief>;
// A delegated agent a stop interrupted, which the brain wakes as it continues the task.
export const SubagentResume = SubagentBrief.extend({
  runId: z.string().min(1).max(128),
  reason: SubagentStop,
});
export type SubagentResume = z.infer<typeof SubagentResume>;

export const BootConfig = z.object({
  sessionId: z.string().regex(ULID_PATTERN),
  task: z.string().min(1).max(8000),
  models: z.object({
    main: ModelBinding,
    fast: ModelBinding.optional(),
    local: ModelBinding.optional(),
  }),
  // keyd's listener for this brain cell, through the gate: plain HTTP to http://llm.ldot/<route>.
  proxy: z.object({
    url: z.url({ protocol: /^http$/ }),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  }),
  memory: z.object({ user: z.string().max(20_000), memory: z.string().max(20_000) }),
  skills: z.array(SkillSummary).max(100),
  limits: AgentLimits,
  // The transcript already holds turns: the brain restarted and resumes the task.
  resume: z.boolean(),
  // The highest durably acknowledged inbox sequence, not the last item fetched.
  inboxAfter: z.number().int().nonnegative(),
  // What was said earlier in the conversation this task continues.
  earlier: EarlierTurns.optional(),
  // The user's last few tasks, newest first, unless they turned this off.
  recent: z.array(RecentLine).max(RECENT_TASKS).optional(),
  // Present when a routine started this task: the brain is told it runs unattended.
  run: SessionRun.optional(),
  // The user's connected apps' tools, as this task sees them.
  connectors: z.array(ConnectorToolSpec).max(MAX_TASK_CONNECTOR_TOOLS).optional(),
  // Present in research mode: the brain gets the research rules and tool, with this budget.
  research: ResearchBudget.optional(),
  // The chosen dot's instructions; absent for the everyday dot.
  role: z.string().min(1).max(2000).optional(),
  subagents: z.array(SubagentResume).max(MAX_SUBAGENT_BRIEFS).optional(),
});
export type BootConfig = z.infer<typeof BootConfig>;

// The transcript the daemon keeps for the brain (spec "Stateless brain"): AI SDK model messages,
// with screenshot data removed (the frame id stays, so the brain can fetch the latest again).
export const InboxSource = z.strictObject({
  seq: z.number().int().positive(),
  messageId: z.string().regex(ULID_PATTERN),
});
export type InboxSource = z.infer<typeof InboxSource>;

export const TranscriptMessage = z
  .object({
    role: z.enum(["user", "assistant", "tool"]),
    content: z.unknown(),
    // Durable delivery identity kept outside model content; the daemon validates it
    // against the original user message and the authenticated brain generation.
    sourceInbox: InboxSource.optional(),
    // Upstream orchestration events are durable metadata, never model message text.
    harnessEvent: z
      .object({
        version: z.literal(1),
        sessionId: z.string().min(1).max(200),
        event: z.unknown(),
      })
      .optional(),
  })
  .refine((message) => message.sourceInbox === undefined || message.role === "user", {
    message: "only user transcript messages may acknowledge inbox content",
  })
  .refine(
    (message) =>
      message.harnessEvent === undefined ||
      (message.role === "user" && message.content === "" && message.sourceInbox === undefined),
    {
      message: "harness events must be isolated from model and inbox content",
    },
  );
export type TranscriptMessage = z.infer<typeof TranscriptMessage>;

// The daemon first persists messages idempotently by sourceInbox.messageId, then advances
// this cursor only over items delivered to this generation and durably recorded. An empty
// batch may retry an acknowledgement after a crash; fetching alone never acknowledges.
export const TranscriptAppend = z
  .strictObject({
    messages: z.array(TranscriptMessage).max(64),
    inboxAfter: z.number().int().nonnegative().optional(),
  })
  .refine((append) => append.messages.length > 0 || append.inboxAfter !== undefined, {
    message: "append messages or acknowledge the inbox",
  });
export type TranscriptAppend = z.infer<typeof TranscriptAppend>;

export const InboxItem = z.object({
  seq: z.number().int().positive(),
  messageId: z.string().regex(ULID_PATTERN),
  kind: z.enum(["steer", "followup", "resume"]),
  text: z.string().max(8000),
});
export type InboxItem = z.infer<typeof InboxItem>;
export const InboxReply = z.object({ items: z.array(InboxItem), stopped: z.boolean() });
export type InboxReply = z.infer<typeof InboxReply>;

// The events a brain may append itself; everything else (actions, tools, plan, questions,
// results) is appended by the daemon when it runs the tool.
export const BrainEvent = z.discriminatedUnion("type", [
  // Completion, idle and user waits belong to the daemon and runner, not model output.
  AgentState.pick({ type: true, data: true }).extend({
    data: AgentState.shape.data.extend({
      state: z.enum(["thinking", "acting", "observing", "paused", "error"]),
    }),
  }),
  Heartbeat.pick({ type: true, data: true }),
  ThoughtDelta.pick({ type: true, data: true }),
  MessageDelta.pick({ type: true, data: true }),
  MessageAssistant.pick({ type: true, data: true }),
  SubagentState.pick({ type: true, data: true }),
  ModelUsage.pick({ type: true, data: true }),
  ModelRetry.pick({ type: true, data: true }),
]);
export type BrainEvent = z.infer<typeof BrainEvent>;
export const MAX_BRAIN_EVENTS = 256;
export const BrainEvents = z.object({ events: z.array(BrainEvent).min(1).max(MAX_BRAIN_EVENTS) });
export const BriefPost = z.strictObject({ brief: SubagentBrief });
