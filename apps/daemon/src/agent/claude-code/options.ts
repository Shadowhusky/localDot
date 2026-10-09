import type {
  CanUseTool,
  McpSdkServerConfigWithInstance,
  Options,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { TOOL_NAMES } from "@localdot/protocol";
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
  "Edit",
  "EnterPlanMode",
  "ExitPlanMode",
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
  "Skill",
  "SlashCommand",
  "Task",
  "TodoRead",
  "TodoWrite",
  "ToolSearch",
  "WebFetch",
  "WebSearch",
  "Write",
]);

// Anything but localDot's own server is refused, whatever asks for it.
export const onlyLocaldot: CanUseTool = async (name, input, { mcpServer }) =>
  LOCALDOT_TOOLS.includes(name) && mcpServer?.source === "sdk" && mcpServer.name === LOCALDOT_SERVER
    ? { behavior: "allow", updatedInput: input }
    : { behavior: "deny", message: "Only localDot's tools are available." };

export interface ClaudeCodeOptionsInput {
  readonly launch: ClaudeCodeLaunch;
  readonly model?: string;
  readonly instructions: string;
  readonly server: McpSdkServerConfigWithInstance;
  readonly abort: AbortController;
  readonly spawn: (options: SpawnOptions) => SpawnedProcess;
}

// Dot's brain on the user's own Claude Code: localDot's tools over MCP and nothing else. No
// settings, CLAUDE.md, memory, skills, plugins or other MCP servers of the user's reach dot, and
// nothing of the task is saved in Claude Code's history.
export function claudeCodeOptions(input: ClaudeCodeOptionsInput): Options {
  return {
    pathToClaudeCodeExecutable: input.launch.executable,
    spawnClaudeCodeProcess: input.spawn,
    cwd: input.launch.cwd,
    env: { ...input.launch.env },
    abortController: input.abort,
    ...(input.model ? { model: input.model } : {}),
    systemPrompt: input.instructions,
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: { [LOCALDOT_SERVER]: input.server },
    tools: [],
    allowedTools: [...LOCALDOT_TOOLS],
    disallowedTools: [...BUILT_IN_TOOLS],
    permissionMode: "dontAsk",
    canUseTool: onlyLocaldot,
    skills: [],
    plugins: [],
    agents: {},
    persistSession: false,
    enableFileCheckpointing: false,
    includePartialMessages: true,
    verbatimPrompts: true,
    extraArgs: { "disable-slash-commands": null, "no-chrome": null },
  };
}
