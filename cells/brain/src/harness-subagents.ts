import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { type SessionEvent, SessionId } from "@deepseek-ai/dsh-session";
import type { SubagentRunEndInfo, SubagentRunInfo } from "@deepseek-ai/dsh-subagent";
import {
  type EventOf,
  RESUMABLE_STOPS,
  type SubagentBrief,
  type SubagentResume,
  type SubagentStop,
} from "@localdot/protocol";
import { providerFailure } from "./provider-failure.ts";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "localdot-subagents": { kind: "localdot-subagents" };
  }
}

// Upstream's activation pool for continuable children; one-shot runs stand outside it.
export const MAX_ACTIVE_SUBAGENTS = 3;
const BECAUSE: Record<SubagentStop, string> = {
  limit: "the usage limit or budget was reached",
  error: "an error stopped it",
  restarted: "localDot restarted",
  control: "the user took the computer",
  stopped: "the task was stopped",
  cancelled: "dot stopped it",
};

type State = EventOf<"subagent.state">["data"];
interface Child {
  label: string;
  mode?: "continuable" | "one-shot";
}
interface Pending {
  runId: string;
  label: string;
  reason: SubagentStop;
  // The continuation that last saw it stop: it wakes at a later one, so a stop that recurs waits
  // for dot to continue again instead of looping.
  round: number;
  brief?: SubagentBrief;
}
export interface DelegatesHost {
  sessionId: string;
  signal: AbortSignal;
  spawn: { persona: string; tools: string[] };
  events(sessionId: string): readonly SessionEvent[];
  onSubagent?(state: State): void;
  brief?(brief: SubagentBrief): void;
}

const cut = (text: string, max: number) => {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
};
const HANDED_OVER = "You continue delegated work that an earlier agent left unfinished";
const ASKED = "What it was asked:\n";
const HAD_DONE = "What it had done (its own record, which may be incomplete):\n";
const GO_ON = "Continue from where it stopped and report as it was asked to.";
// A handed-over agent was asked what the first one was, however many times it was handed on.
function original(asked: string): string {
  if (!asked.startsWith(HANDED_OVER)) return asked;
  const from = asked.indexOf(ASKED);
  if (from === -1) return asked;
  const rest = asked.slice(from + ASKED.length);
  const end = [rest.indexOf(`\n\n${HAD_DONE}`), rest.indexOf(`\n\n${GO_ON}`)].filter(
    (at) => at !== -1,
  );
  return end.length ? rest.slice(0, Math.min(...end)) : rest;
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const said = (content: unknown) =>
  (Array.isArray(content) ? content : [])
    .flatMap((part) => {
      const { type, text } = record(part);
      return type === "text" && typeof text === "string" ? [text] : [];
    })
    .join("\n")
    .trim();
function intent(name: unknown, args: unknown): string {
  let input: Record<string, unknown> = {};
  try {
    input = record(JSON.parse(String(args)));
  } catch {}
  const what =
    typeof input.intent === "string"
      ? input.intent
      : ["op", "path", "url", "query", "command"]
          .flatMap((key) => (typeof input[key] === "string" ? [input[key]] : []))
          .join(" ");
  return cut(`${String(name)}${what ? `: ${what}` : ""}`.replace(/\s+/g, " "), 160);
}

// What a child was asked and has done, from its own session log, small enough for a fresh agent's
// first message. Tool output stays out: the computer still holds what the work made.
export function subagentBrief(
  id: string,
  label: string,
  events: readonly SessionEvent[],
): SubagentBrief {
  let asked = "";
  const later: string[] = [];
  let summary = "";
  let plan: string[] = [];
  let steps: string[] = [];
  let note = "";
  for (const event of events) {
    const data = record(event.data);
    switch (event.type as string) {
      case "agent/inbox/spliced":
        for (const item of Array.isArray(data.inserted) ? data.inserted : [])
          if (!asked && record(record(item).source).kind === "user")
            asked = said(record(item).content);
        break;
      case "user/message": {
        const kind = record(data.source).kind;
        if (kind === "user" && !asked) asked = said(data.content);
        else if (kind === "agent-message") later.push(said(data.content));
        break;
      }
      case "compaction/summary":
        summary = said(data.summary);
        steps = [];
        break;
      case "todo/write":
        plan = (Array.isArray(data.todos) ? data.todos : []).map((todo) => {
          const { status, content } = record(todo);
          return cut(`[${String(status)}] ${String(content)}`, 200);
        });
        break;
      case "tool/call":
        steps.push(intent(data.name, data.arguments));
        break;
      case "assistant/message":
        note = said(record(data.message).content) || note;
        break;
    }
  }
  const instructions = [cut(original(asked), 2200), ...later.slice(-2).map((m) => cut(m, 380))]
    .filter(Boolean)
    .join("\n\n");
  const progress = [
    summary && `Summary of its earlier work:\n${cut(summary, 2400)}`,
    plan.length && `Its plan:\n${plan.slice(0, 10).join("\n")}`,
    steps.length && `Its latest steps:\n${steps.slice(-8).join("\n")}`,
    note && `Its last note:\n${cut(note, 800)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    id,
    label: cut(label, 200),
    instructions: cut(instructions, 3000),
    progress: cut(progress, 5000),
  };
}

function handOver(pending: Pending, brief: SubagentBrief): string {
  return [
    `${HANDED_OVER} because ${BECAUSE[pending.reason]}. The computer and its files are as that agent left them: check what it already did before repeating any of it.`,
    `${ASKED}${brief.instructions}`,
    ...(brief.progress ? [`${HAD_DONE}${brief.progress}`] : []),
    GO_ON,
  ].join("\n\n");
}

// Delegated agents a stop left unfinished: limits, errors, restarts and the user taking the
// computer leave them to wake when dot continues the task. dot is told which ones woke, and its
// own interruption, a completed task or a stopped one leaves them asleep.
export class Delegates {
  readonly #children = new Map<string, Child>();
  readonly #runs = new Map<string, string>();
  readonly #failures = new Map<string, SubagentStop>();
  readonly #pending = new Map<string, Pending>();
  readonly #resuming = new Set<string>();
  readonly #briefed = new Map<string, string>();
  #round = 0;
  #due = false;
  #waking = Promise.resolve();
  constructor(
    private readonly ctx: Context,
    private readonly host: DelegatesHost,
  ) {}

  // A resume waits for a free slot: dot's work is not over while it does.
  get waiting(): boolean {
    return this.#due && [...this.#pending.values()].some((p) => p.round < this.#round);
  }

  restore(resume: readonly SubagentResume[]): void {
    for (const { runId, label, reason, ...brief } of resume) {
      if (!RESUMABLE_STOPS.has(reason)) continue;
      this.#children.set(brief.id, { label });
      this.#pending.set(brief.id, { runId, label, reason, round: 0, brief: { ...brief, label } });
    }
  }

  failed(sessionId: string, error: unknown): void {
    this.#failures.set(sessionId, providerFailure(error) ? "limit" : "error");
  }

  started(info: SubagentRunInfo): void {
    const id = String(info.id);
    const agent = this.ctx.agents.get(info.id);
    const identity =
      agent && this.ctx.sessionProjections.snapshot(agent.session, ["subagent"]).values.subagent;
    const label = (identity?.label || this.#children.get(id)?.label || "Delegated task").slice(
      0,
      200,
    );
    this.#children.set(id, { label, ...(identity ? { mode: identity.mode } : {}) });
    this.#runs.set(String(info.runId), id);
    this.#pending.delete(id);
    this.#failures.delete(id);
    const resumed = this.#resuming.delete(id);
    this.host.onSubagent?.({
      id,
      runId: String(info.runId),
      label,
      state: "running",
      ...(resumed ? { resumed: true as const } : {}),
    });
    this.progressed(id);
  }

  ended(info: SubagentRunEndInfo): void {
    const id = String(info.id);
    this.#runs.delete(String(info.runId));
    const failure = this.#failures.get(id);
    this.#failures.delete(id);
    // A retired brain's children are recorded by the daemon, which knows why it retired it.
    if (this.host.signal.aborted) return;
    const child = this.#children.get(id);
    const label = child?.label ?? "Delegated task";
    const summary = info.lastAssistantMessage
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .slice(0, 5000);
    const reason: SubagentStop | undefined =
      info.stopReason === "error"
        ? (failure ?? "error")
        : info.stopReason === "aborted"
          ? "cancelled"
          : undefined;
    this.host.onSubagent?.({
      id,
      runId: String(info.runId),
      label,
      state: info.stopReason === "completed" ? "completed" : reason ? "interrupted" : "failed",
      ...(reason ? { reason } : {}),
      ...(summary ? { summary } : {}),
    });
    // A one-shot child's result belongs to dot's own call or job, which already tells it.
    if (reason && RESUMABLE_STOPS.has(reason) && child?.mode === "continuable")
      this.#pending.set(id, { runId: String(info.runId), label, reason, round: this.#round });
    this.progressed(id);
  }

  progressed(id: string): void {
    const child = this.#children.get(id);
    if (!this.host.brief || child?.mode !== "continuable") return;
    const brief = subagentBrief(id, child.label, this.host.events(id));
    const json = JSON.stringify(brief);
    if (!brief.instructions || this.#briefed.get(id) === json) return;
    this.#briefed.set(id, json);
    this.host.brief(brief);
  }

  // dot itself interrupted it: it stays stopped.
  drop(id: string): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    this.host.onSubagent?.({
      id,
      runId: pending.runId,
      label: pending.label,
      state: "interrupted",
      reason: "cancelled",
    });
  }

  // The task is complete: what its delegated agents left unfinished no longer needs doing.
  clear(): void {
    this.#pending.clear();
    this.#due = false;
  }

  // Waking a child never stops dot: one left asleep wakes at the next chance.
  continue(root: Agent): Promise<void> {
    this.#round += 1;
    this.#due = true;
    return this.#wake(root);
  }

  retry(root: Agent): Promise<void> {
    return this.waiting ? this.#wake(root) : Promise.resolve();
  }

  // One wake at a time, so two callers never wake the same child twice.
  #wake(root: Agent): Promise<void> {
    const next = this.#waking.then(() => this.#wakeDue(root)).catch(() => {});
    this.#waking = next;
    return next;
  }

  async #wakeDue(root: Agent): Promise<void> {
    const due = [...this.#pending].filter(([, p]) => p.round < this.#round);
    if (!due.length) {
      this.#due = false;
      return;
    }
    let catalog: Awaited<ReturnType<Context["subagents"]["listChildren"]>> | undefined;
    const line = (id: string, p: Pending) => `- ${p.label} (agent ${id}): ${BECAUSE[p.reason]}`;
    const resumed: string[] = [];
    const lost: string[] = [];
    let waiting = 0;
    for (const [id, pending] of due) {
      const active = [...this.#runs.values()].filter(
        (child) => this.#children.get(child)?.mode === "continuable",
      ).length;
      if (active >= MAX_ACTIVE_SUBAGENTS) {
        waiting += 1;
        continue;
      }
      // A child this session holds wakes with its own history; one from an earlier task is
      // handed to a fresh agent under the same id.
      const known = this.host.events(id).length > 0;
      if (known)
        catalog ??= await this.ctx.subagents.listChildren(
          SessionId(this.host.sessionId),
          this.host.signal,
        );
      // Started by dot, dropped or settled meanwhile.
      if (this.#pending.get(id) !== pending) continue;
      this.#pending.delete(id);
      this.#resuming.add(id);
      try {
        if (catalog?.some((entry) => String(entry.id) === id && entry.mode === "continuable"))
          await this.ctx.subagents.sendMessage(
            root,
            SessionId(id),
            [
              {
                type: "text",
                text: `localDot resumed you: your earlier run stopped before it finished because ${BECAUSE[pending.reason]}. Continue your delegated work from where you stopped, checking anything that was in progress before you repeat it.`,
              },
            ],
            { signal: this.host.signal },
          );
        else if (!known && pending.brief?.instructions)
          await this.ctx.subagents.startContinuable({
            provider: "spawn",
            label: pending.label,
            childId: SessionId(id),
            request: {
              prompt: [{ type: "text", text: handOver(pending, pending.brief) }],
              parent: root,
              persona: this.host.spawn.persona,
              toolFilter: { allow: this.host.spawn.tools },
              maxDepth: 1,
            },
            signal: this.host.signal,
          });
        else throw new Error("This delegated agent cannot be resumed.");
        resumed.push(line(id, pending));
      } catch (error) {
        this.#resuming.delete(id);
        this.host.signal.throwIfAborted();
        if (record(error).code === "ACTIVATION_LIMIT_REACHED") {
          this.#pending.set(id, pending);
          waiting += 1;
          continue;
        }
        lost.push(line(id, pending));
        this.host.onSubagent?.({
          id,
          runId: pending.runId,
          label: pending.label,
          state: "failed",
        });
      }
    }
    if (!waiting) this.#due = false;
    if (!resumed.length && !lost.length) return;
    const notice = [
      ...(resumed.length
        ? [
            `localDot resumed delegated agents that stopped before they finished; each continues its own earlier work:\n${resumed.join("\n")}\nTheir results reach you as before. Do not start them again; to stop one you no longer need, use interrupt_agent with its id.`,
          ]
        : []),
      ...(waiting ? [`${waiting} more resume when a running agent finishes.`] : []),
      ...(lost.length
        ? [
            `These delegated agents could not be resumed; delegate their work again if it is still needed:\n${lost.join("\n")}`,
          ]
        : []),
    ].join("\n\n");
    root.inject(
      createUserMessage({
        content: [{ type: "text", text: notice }],
        source: { kind: "localdot-subagents" },
      }),
    );
  }
}
