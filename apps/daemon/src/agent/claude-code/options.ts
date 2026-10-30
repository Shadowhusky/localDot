import type {
  CanUseTool,
  McpSdkServerConfigWithInstance,
  Options,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { ModelOptions } from "@localdot/protocol";
import { isConnectorToolName, TOOL_NAMES } from "@localdot/protocol";
import type { ClaudeCodeLaunch } from "./setup.ts";

export const LOCALDOT_SERVER = "localdot";
export const LOCALDOT_TOOLS: readonly string[] = Object.freeze(
  TOOL_NAMES.map((name) => `mcp__${LOCALDOT_SERVER}__${name}`),
);
// Claude Code's own tools, named as well as left out, so none can be switched back on.
export const BUILT_IN_TOOLS: readonly string[] = Object.freeze([
  "Agent",
  "AskUserQuestion",
  "Bash",
  "BashOutput",
  "CronCreate",
  "CronDelete",
  "CronList",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "KillShell",
  "LS",
  "ListMcpResourcesTool",
  "LSP",
  "MultiEdit",
  "NotebookEdit",
  "NotebookRead",
  "Read",
  "ReadMcpResourceTool",
  "ReportFindings",
  "ScheduleWakeup",
  "SendMessage",
  "Skill",
  "SlashCommand",
  "Task",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskStop",
  "TaskUpdate",
  "TodoRead",
  "TodoWrite",
  "ToolSearch",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write",
]);

const PREFIX = `mcp__${LOCALDOT_SERVER}__`;
// Connected apps' tools are served by the same in-process server, which checks each against the
// task's own list.
export const isLocaldotTool = (name: string): boolean =>
  LOCALDOT_TOOLS.includes(name) ||
  (name.startsWith(PREFIX) && isConnectorToolName(name.slice(PREFIX.length)));

export const ONLY_LOCALDOT = "Only localDot's tools are available.";
// Every tool call asks here: localDot's own in-process server is allowed, anything else refused.
export const onlyLocaldot: CanUseTool = async (name, input, { mcpServer }) =>
  isLocaldotTool(name) && mcpServer?.source === "sdk" && mcpServer.name === LOCALDOT_SERVER
    ? { behavior: "allow", updatedInput: input }
    : { behavior: "deny", message: ONLY_LOCALDOT };

export const refuseAll: CanUseTool = async () => ({
  behavior: "deny",
  message: "No tools are available.",
});

export interface ClaudeCodeRunInput {
  readonly launch: ClaudeCodeLaunch;
  readonly model?: string;
  readonly modelOptions?: ModelOptions;
  readonly instructions: string;
  readonly abort: AbortController;
  readonly spawn: (options: SpawnOptions) => SpawnedProcess;
}
export interface ClaudeCodeOptionsInput extends ClaudeCodeRunInput {
  readonly server: McpSdkServerConfigWithInstance;
  // Built-ins a newer Claude Code turned on that localDot has learned to switch off by name.
  readonly disallowed?: readonly string[];
}

// The user's own Claude Code with none of their setup: no settings, CLAUDE.md, memory, skills,
// plugins, MCP servers or built-in tools reach dot, and nothing is saved in Claude Code's history.
function isolated(input: ClaudeCodeRunInput): Options {
  const effort = input.modelOptions?.reasoningEffort;
  if (effort && !["low", "medium", "high", "xhigh", "max"].includes(effort))
    throw new Error("Unsupported Claude Code effort.");
  return {
    pathToClaudeCodeExecutable: input.launch.executable,
    spawnClaudeCodeProcess: input.spawn,
    cwd: input.launch.cwd,
    env: { ...input.launch.env },
    abortController: input.abort,
    ...(input.model ? { model: input.model } : {}),
    ...(effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh" ||
    effort === "max"
      ? { effort }
      : {}),
    systemPrompt: input.instructions,
    settingSources: [],
    ...(input.modelOptions?.speed
      ? { settings: { fastMode: input.modelOptions.speed === "fast" } }
      : {}),
    strictMcpConfig: true,
    mcpServers: {},
    tools: [],
    disallowedTools: [...BUILT_IN_TOOLS],
    permissionMode: "default",
    canUseTool: refuseAll,
    skills: [],
    plugins: [],
    agents: {},
    persistSession: false,
    enableFileCheckpointing: false,
    verbatimPrompts: true,
    extraArgs: { "disable-slash-commands": null, "no-chrome": null },
  };
}

// Dot's brain: localDot's tools over MCP and nothing else.
export function claudeCodeOptions(input: ClaudeCodeOptionsInput): Options {
  const learned = (input.disallowed ?? []).filter(
    (name) => !isLocaldotTool(name) && !BUILT_IN_TOOLS.includes(name),
  );
  return {
    ...isolated(input),
    disallowedTools: [...BUILT_IN_TOOLS, ...new Set(learned)],
    mcpServers: { [LOCALDOT_SERVER]: input.server },
    canUseTool: onlyLocaldot,
    includePartialMessages: true,
  };
}

// One answer to one question, in one turn, with no tools at all.
export function claudeCodeAnswerOptions(input: ClaudeCodeRunInput): Options {
  return { ...isolated(input), maxTurns: 1 };
}
