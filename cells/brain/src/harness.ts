import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import Compaction from "@deepseek-ai/dsh-compaction-basic";
import Goals from "@deepseek-ai/dsh-goal";
import * as GoalDriver from "@deepseek-ai/dsh-goal-round-driver";
import Jobs from "@deepseek-ai/dsh-jobs-local";
import LlmRuntime, {
  createUserMessage,
  type GenerateOptions,
  LlmAdapter,
  type StreamChunk,
  ToolCallId,
  type ToolSchema,
} from "@deepseek-ai/dsh-llm";
import * as RepeatToolReminder from "@deepseek-ai/dsh-repeat-tool-reminder";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import * as Checkpoints from "@deepseek-ai/dsh-session-checkpoint-policy";
import SessionProjections from "@deepseek-ai/dsh-session-projection";
import SessionQuery from "@deepseek-ai/dsh-session-query-sqlite";
import SkillRegistry from "@deepseek-ai/dsh-skill";
import Subagents from "@deepseek-ai/dsh-subagent";
import * as Spawn from "@deepseek-ai/dsh-subagent-spawn-in-process";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import * as GoalTools from "@deepseek-ai/dsh-tool-goal";
import * as JobTools from "@deepseek-ai/dsh-tool-jobs";
import * as SkillTool from "@deepseek-ai/dsh-tool-skill";
import * as SubagentTool from "@deepseek-ai/dsh-tool-subagent";
import * as AgentControls from "@deepseek-ai/dsh-tool-subagent-control";
import * as AgentList from "@deepseek-ai/dsh-tool-subagent-control/list-agents";
import * as TodoTool from "@deepseek-ai/dsh-tool-todo";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import type { EventOf, SubagentBrief, SubagentResume, ToolResult } from "@localdot/protocol";
import { desktopSkillProvider, type SkillComputer, skillChange } from "./harness-skills.ts";
import { type HarnessJournal, HarnessStorage } from "./harness-storage.ts";
import { Delegates, MAX_ACTIVE_SUBAGENTS } from "./harness-subagents.ts";

const CONTINUE = "Continue with the updated localDot context.";
const PERSONA =
  "You are a localDot subagent working inside the same virtual Ubuntu computer. The parent owns the visible browser and user conversation. Research and work only on the delegated scope; coordinate shared files through the parent. Return concrete findings, verification and output paths to the parent. Do not claim to deliver files or complete the user's overall task.";

export interface HarnessStep {
  text: string;
  calls: { id: string; name: string; input: unknown }[];
  // The main agent went on after a pause (a limit, an error, a refused request): interrupted
  // delegated agents wake with it.
  continued?: boolean;
}

export interface HarnessRequest {
  system: string;
  tools: ToolSchema[];
  context: { id: string; kind: string; text: string }[];
}
export interface HarnessHost {
  sessionId: string;
  task: string;
  signal: AbortSignal;
  skills?: SkillComputer;
  delegation?: {
    tools: ToolSchema[];
    contextTokens?: number;
    maxOutputTokens?: number;
    request(options: GenerateOptions): AsyncIterable<StreamChunk>;
    execute(
      sessionId: string,
      id: string,
      name: string,
      input: unknown,
      signal: AbortSignal,
    ): Promise<ToolResult>;
  };
  journal?: HarnessJournal;
  onSubagent?(state: EventOf<"subagent.state">["data"]): void;
  // Delegated agents an earlier stop interrupted, and where each child's brief is kept.
  subagents?: {
    resume: readonly SubagentResume[];
    brief(brief: SubagentBrief): void;
  };
  beforeNativeCall?(id: string, signal: AbortSignal): Promise<string | undefined>;
  request(signal: AbortSignal, request: HarnessRequest): Promise<HarnessStep | undefined>;
  execute(
    id: string,
    signal: AbortSignal,
    nativeResult?: ToolResult,
  ): Promise<{ result: ToolResult; conclude: boolean }>;
  stopping(signal: AbortSignal, goalActive?: boolean): Promise<boolean>;
}

/**
 * DSH owns step scheduling, serial tool dispatch, turn completion and cancellation.
 * localDot owns the durable, multimodal provider transcript and inbox. The adapter
 * deliberately uses that host context (including signed provider replay blocks),
 * not a second independently compacted copy of the root conversation. DSH's session is
 * a durable orchestration log stored through the same daemon journal. Native child
 * histories retain provider replay and use upstream compaction.
 *
 * Upstream skills, todos and recovery plugins contribute to the actual model context.
 * No stock shell, provider credentials, telemetry,
 * session uploader or filesystem persistence. Every action still crosses keyd /
 * the daemon's existing permission and computer ownership boundaries.
 */
export async function driveHarness(host: HarnessHost): Promise<void> {
  host.signal.throwIfAborted();
  const ctx = new Context();
  let failure: unknown;
  let hostFinished = false;
  const fail = (error: unknown) => {
    failure ??= error;
  };
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjections);
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, personaPrefix: "" });
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
    await ctx.plugin(TodoTool, { allowParallelInProgress: false });
    await ctx.plugin(Goals, {});
    await ctx.plugin(GoalTools, {});
    await ctx.plugin(GoalDriver);
    await ctx.plugin(RepeatToolReminder, {});
    const nativeNames = new Set(["todo_write", "get_goal", "create_goal", "update_goal"]);
    const journal = host.journal ?? { records: [], append: async () => {} };
    let storage: HarnessStorage | undefined;
    await ctx.plugin((scope) => {
      storage = new HarnessStorage(scope, journal);
    });
    const flush = async () => {
      try {
        await ctx.sessionPersistence.flush();
      } catch (error) {
        fail(error);
        throw error;
      }
    };
    await ctx.plugin(Checkpoints);
    if (host.delegation) {
      await ctx.plugin(SessionQuery, { path: ":memory:", openAt: "never" });
      await ctx.plugin(TokenMeter, {});
      // localDot compacts the root's transcript itself; a second, paid summary of DSH's copy
      // would only reach the host context as another message.
      class ChildCompaction extends Compaction {
        override compactIfNeeded(...args: Parameters<Compaction["compactIfNeeded"]>) {
          return String(args[0].session.id) === host.sessionId
            ? Promise.resolve(null)
            : super.compactIfNeeded(...args);
        }
      }
      // Upstream reserves 65,536 tokens of headroom and summary by default: more than many
      // windows leave, and more output than many models allow.
      await ctx.plugin(ChildCompaction, { headroomTokens: 8192, maxTokens: 4000 });
    }
    const skillComputer = host.skills;
    if (skillComputer) {
      await ctx.plugin(SkillRegistry);
      ctx.skills.registerProvider((control) => {
        const provider = desktopSkillProvider(ctx, control, skillComputer, host.signal);
        ctx.on("tools/result", (exec) => {
          const args = exec.arguments;
          const fileMutation =
            exec.name === "files" &&
            args !== null &&
            typeof args === "object" &&
            "op" in args &&
            (args.op === "write" || args.op === "edit");
          if (exec.name !== "shell" && !fileMutation) return;
          const change = skillChange(exec.name, args);
          if (change === undefined) return;
          provider.invalidate(change);
          control.invalidate();
        });
        ctx.effect(() => () => provider.dispose());
        return provider;
      });
      await ctx.plugin(SkillTool);
      nativeNames.add("skill");
    }
    if (host.delegation) {
      await ctx.plugin(Jobs, { maxConcurrentJobsPerOwner: 3 });
      await ctx.plugin(JobTools, { completionDelivery: "wakeup", maxConsecutiveWakes: 10 });
      await ctx.plugin(Subagents, { maxActiveSubagents: MAX_ACTIVE_SUBAGENTS, maxDepth: 1 });
      await ctx.plugin(Spawn, { providerName: "spawn" });
      await ctx.plugin(AgentControls);
      await ctx.plugin(AgentList);
      for (const name of [
        "subagent",
        "start_agent",
        "send_message",
        "interrupt_agent",
        "list_agents",
        "job_output",
        "job_list",
        "job_kill",
      ])
        nativeNames.add(name);
    }
    ctx.on("tools/pre-execute", async (exec, next) => {
      await flush();
      if (exec.agent?.id !== host.sessionId) return next();
      if (!nativeNames.has(exec.name)) return next();
      const reason = await host.beforeNativeCall?.(exec.callId, exec.signal);
      exec.signal.throwIfAborted();
      return reason ? { kind: "deny", reason } : next();
    });
    // Native plugins still settle through the host's durable transcript, progress
    // and cancellation boundary, including invalid arguments and plugin failures.
    ctx.on("tools/post-execute", async (exec, result, next) => {
      const decision = await next();
      if (exec.agent?.id !== host.sessionId || !nativeNames.has(exec.name)) return decision;
      const projected: ToolResult = {
        ok: !result.isError && decision.kind !== "block",
        content: (decision.kind === "block" ? decision.feedback : result.content)
          .filter((part) => part.type === "text")
          .map((part) => ({ type: "text", text: part.text })),
      };
      try {
        const settled = await host.execute(exec.callId, exec.signal, projected);
        if (!settled.result.ok)
          return {
            kind: "block",
            feedback: settled.result.content.filter((part) => part.type === "text"),
          };
        return decision;
      } catch (error) {
        fail(error);
        throw error;
      }
    });
    // An idle child may still be flushing its final result or tearing down its
    // activation. Keep ownership until upstream publishes the paired terminal
    // event, after delivering the parent's settlement notice. Agent.status alone
    // can retire the parent in that durability gap and lose its continuation.
    const unsettledChildren = new Set<string>();
    const delegatedTools = [
      ...(host.delegation?.tools.map((tool) => tool.name) ?? []),
      "todo_write",
      ...(skillComputer ? ["skill"] : []),
    ];
    const delegates = new Delegates(ctx, {
      sessionId: host.sessionId,
      signal: host.signal,
      spawn: { persona: PERSONA, tools: delegatedTools },
      events: (id) => storage?.events(id) ?? [],
      ...(host.onSubagent ? { onSubagent: host.onSubagent } : {}),
      ...(host.subagents ? { brief: host.subagents.brief } : {}),
    });
    delegates.restore(host.subagents?.resume ?? []);
    ctx.on("subagent/start", (info) => {
      unsettledChildren.add(info.runId);
      delegates.started(info);
    });
    ctx.on("subagent/end", (info) => {
      unsettledChildren.delete(info.runId);
      delegates.ended(info);
    });
    ctx.on("session/event", (session, event) => {
      if (session.id !== host.sessionId && ["agent/inbox/spliced", "step/end"].includes(event.type))
        delegates.progressed(String(session.id));
    });
    ctx.on("tools/result", (exec) => {
      if (exec.agent?.id === host.sessionId && exec.name === "interrupt_agent")
        delegates.drop(String((exec.arguments as { agent_id?: unknown })?.agent_id));
    });
    const hasPendingWork = () =>
      !!host.delegation &&
      (unsettledChildren.size > 0 ||
        delegates.waiting ||
        ctx.jobs
          .list(SessionId(host.sessionId))
          .some((job) => job.status === "running" || job.status === "stopping") ||
        ctx.agents
          .list()
          .some((agent) => agent.id !== host.sessionId && agent.status === "running"));
    const registered = new Set<string>(nativeNames);
    const register = (name: string, schema?: ToolSchema) => {
      if (registered.has(name)) return;
      ctx.tools.register({
        name,
        description:
          schema?.description ??
          "localDot daemon tool; schema and policy are enforced by the host adapter.",
        // Native provider tools have provider-owned schemas. The host validates
        // their decoded call and the daemon validates again before any action.
        parameters: schema?.parameters ?? { type: "object", additionalProperties: true },
        output: {
          schema: { type: "object", additionalProperties: true },
          render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          await flush();
          if (host.delegation && exec.agent && exec.agent.id !== host.sessionId) {
            const result = await host.delegation.execute(
              String(exec.agent.id),
              String(exec.callId),
              name,
              args,
              exec.signal,
            );
            return {
              ok: result.ok,
              content: result.content.filter((part) => part.type === "text"),
            };
          }
          if (failure) throw failure;
          try {
            const pendingJobs = hasPendingWork();
            const { result, conclude } = await host.execute(
              exec.callId,
              exec.signal,
              name === "done" && pendingJobs
                ? {
                    ok: false,
                    content: [
                      {
                        type: "text",
                        text: "Background work is still running. Collect it with job_output or cancel it with job_kill before completing the task.",
                      },
                    ],
                  }
                : undefined,
            );
            if (conclude) {
              const agent = ctx.agents.get(SessionId(host.sessionId));
              const goal = agent && ctx.goals.get(agent);
              const complete =
                name === "done" &&
                result.ok &&
                (args as { completion?: { status?: string } }).completion?.status !== "blocked";
              if (agent && goal && goal.phase !== "complete") {
                if (complete) ctx.goals.complete(agent, goal);
                else ctx.goals.disarm(agent);
              }
              if (complete) delegates.clear();
              exec.concludeTurn();
            }
            // Frames stay in the host transcript. Do not retain a duplicate base64
            // screenshot for every step in the orchestration log.
            return {
              ok: result.ok,
              content: result.content.map((part) =>
                part.type === "image"
                  ? { type: "text", text: `[frame ${part.frameId}]` }
                  : part.type === "web_image"
                    ? { type: "text", text: `[web image ${part.url}]` }
                    : part,
              ),
            };
          } catch (error) {
            // DSH normalizes tool exceptions. A failed durable write / transport
            // must nevertheless fail the host, never silently start another step.
            fail(error);
            throw error;
          }
        },
      });
      registered.add(name);
    };
    if (host.delegation) {
      for (const schema of host.delegation.tools) register(schema.name, schema);
      for (const [toolName, backgroundMode] of [
        ["subagent", "one-shot"],
        ["start_agent", "continuable"],
      ] as const)
        await ctx.plugin(SubagentTool, {
          provider: "spawn",
          toolName,
          maxDepth: 1,
          enableRunInBackground: true,
          backgroundMode,
          toolFilter: { allow: delegatedTools },
          persona: PERSONA,
        });
    }
    class HostAdapter extends LlmAdapter {
      async resolveModel(provider: string, model: string) {
        return {
          provider,
          id: model,
          name: model,
          ...(host.delegation?.contextTokens
            ? { context: { contextWindow: host.delegation.contextTokens } }
            : {}),
          ...(host.delegation?.maxOutputTokens
            ? { defaultMaxTokens: host.delegation.maxOutputTokens }
            : {}),
        };
      }
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        await flush();
        if (failure) throw failure;
        const signal = AbortSignal.any([host.signal, options.signal ?? host.signal]);
        if (options.purpose || (options.sessionId && options.sessionId !== host.sessionId)) {
          if (!host.delegation) throw new Error("Delegation transport is unavailable");
          try {
            yield* host.delegation.request({ ...options, signal });
          } catch (error) {
            if (options.sessionId) delegates.failed(String(options.sessionId), error);
            throw error;
          }
          return;
        }
        const root = ctx.agents.get(SessionId(host.sessionId));
        if (root) await delegates.retry(root);
        const step = await host.request(signal, {
          // Trusted plugin policy belongs in the system prompt. File/skill bodies
          // remain user/tool context below and never gain system authority.
          system: [
            options.system,
            ...options.messages
              .filter((message) => message.role === "system")
              .map((message) =>
                message.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n"),
              ),
          ]
            .filter(Boolean)
            .join("\n\n"),
          tools: (options.tools ?? []).filter((tool) => nativeNames.has(tool.name)),
          context: options.messages.flatMap((message) => {
            if (
              message.role !== "user" ||
              !("source" in message) ||
              !message.source ||
              message.source.kind === "user" ||
              message.source.kind === "compact-checkpoint" ||
              !("id" in message)
            )
              return [];
            return [
              {
                id: String(message.id),
                kind: message.source.kind,
                text: message.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n"),
              },
            ];
          }),
        });
        signal.throwIfAborted();
        if (!step) {
          hostFinished = true;
          if (root) ctx.goals.disarm(root);
        }
        if (step?.continued && root) await delegates.continue(root);
        let index = 0;
        if (step?.text) {
          yield { type: "block-start", index, blockType: "text" };
          yield { type: "text-delta", index, text: step.text };
          yield { type: "block-end", index: index++, block: { type: "text", text: step.text } };
        }
        for (const call of step?.calls ?? []) {
          register(call.name);
          const id = ToolCallId(call.id);
          const args = JSON.stringify(
            call.input !== null && typeof call.input === "object" && !Array.isArray(call.input)
              ? call.input
              : {},
          );
          yield { type: "block-start", index, blockType: "tool-call" };
          yield { type: "tool-call-delta", index, id, name: call.name, argumentsDelta: args };
          yield {
            type: "block-end",
            index: index++,
            block: {
              type: "tool-call",
              id,
              name: call.name,
              arguments: args,
            },
          };
        }
        yield { type: "finish", reason: { kind: step?.calls.length ? "tool-calls" : "stop" } };
      }
    }
    ctx.llm.registerAdapter(["localdot"], new HostAdapter());
    const resumed = !!(await ctx.sessionPersistence.stat(SessionId(host.sessionId)));
    const factory = resumed
      ? (options: Parameters<typeof ctx.agents.create>[0]) =>
          ctx.agents.resume({ ...options, resumeSessionId: options.sessionId })
      : (options: Parameters<typeof ctx.agents.create>[0]) => ctx.agents.create(options);
    const handle = await factory({
      sessionId: SessionId(host.sessionId),
      signal: host.signal,
      agentOptions: { provider: "localdot", model: "configured" },
      setup(scope) {
        scope.on("agent/error", ({ error }) => fail(error));
        scope.on("agent/turn-stopping", async ({ agent, signal }) => {
          if (failure || host.signal.aborted || hasPendingWork()) return;
          if (await host.stopping(signal, ctx.goals.get(agent)?.phase === "active"))
            agent.steer(
              createUserMessage({
                content: [{ type: "text", text: CONTINUE }],
                source: { kind: "user" },
              }),
            );
        });
      },
    });
    const abort = () => handle.agent.cancel({ kind: "user" });
    host.signal.addEventListener("abort", abort, { once: true });
    try {
      host.signal.throwIfAborted();
      // Before the first step, so dot's first request already knows which children woke.
      if (host.subagents?.resume.length) await delegates.continue(handle.agent);
      // A resumed session holds the task already: following it up again would repeat its
      // /skill gestures and what they inject.
      handle.agent.followup(
        createUserMessage({
          content: [{ type: "text", text: resumed ? CONTINUE : host.task }],
          source: { kind: "user" },
        }),
      );
      do {
        await handle.agent.whenIdle();
        await flush();
        await delegates.retry(handle.agent);
        // The upstream goal driver admits its next round after a durability
        // checkpoint. Let that admission settle before treating idle as complete.
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      } while (
        !host.signal.aborted &&
        !hostFinished &&
        ((ctx.goals.get(handle.agent)?.activation === "armed" &&
          ctx.goals.get(handle.agent)?.phase === "active") ||
          hasPendingWork() ||
          handle.agent.status === "running")
      );
      await flush();
      host.signal.throwIfAborted();
      if (failure) throw failure;
    } finally {
      host.signal.removeEventListener("abort", abort);
      await handle.dispose();
      await flush();
    }
  } finally {
    await ctx.fiber.dispose();
  }
}
