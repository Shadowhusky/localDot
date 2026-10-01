import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// The user's own Codex config would otherwise lend the harness extra hands (their MCP servers,
// plugins, connectors, computer and browser use) and another endpoint (a custom base URL).
export function harnessOverrides({ keepBaseUrl = false, noBuiltins = false } = {}) {
  const userConfig = join(homedir(), ".codex", "config.toml");
  const userMcpServers = existsSync(userConfig)
    ? [...readFileSync(userConfig, "utf8").matchAll(/^\[mcp_servers\.("?)([^".\]]+)\1\]\s*$/gm)].map((m) => m[2])
    : [];
  const overrides = [
    "-c", `mcp_servers.localdot.command="node"`,
    "-c", `mcp_servers.localdot.args=${JSON.stringify([join(here, "mcp-tools.mjs")])}`,
    ...userMcpServers.filter((name) => name !== "localdot").flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]),
    "-c", "notify=[]",
    "-c", `web_search="disabled"`,
    "-c", `history.persistence="none"`,
    ...["plugins", "remote_plugin", "apps", "computer_use", "browser_use", "browser_use_external", "in_app_browser",
      "multi_agent", "goals", "tool_suggest", "image_generation"].flatMap((feature) => ["--disable", feature]),
  ];
  if (!keepBaseUrl) overrides.push("-c", `openai_base_url="https://chatgpt.com/backend-api/codex"`);
  if (noBuiltins) overrides.push(...["shell_tool", "unified_exec", "view_image"].flatMap((f) => ["--disable", f]));
  return overrides;
}

const explicitDefaults = (schema) =>
  Object.fromEntries(
    Object.entries(schema?.properties ?? {})
      .filter(([, p]) => p.default !== undefined)
      .map(([k, p]) => [k, p.default]),
  );
const denyLabel = (options) => options?.find((o) => /\b(deny|decline|cancel|reject|no)\b/i.test(o.label))?.label;

// Codex's built-in tools are always refused, and so is every question put to the user (its text can
// be model-written). Only Codex's approval prompt for a call to localDot's own MCP server passes.
export function decideServerRequest(method, params) {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { verdict: "declined", result: { decision: "decline" } };
    case "item/permissions/requestApproval":
      return { verdict: "declined", result: { permissions: {}, scope: "turn" } };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { verdict: "declined", result: { decision: { denied: { rejection: "localDot declines Codex built-in tools" } } } };
    case "mcpServer/elicitation/request": {
      const kind = params?._meta?.codex_approval_kind;
      const ours =
        params?.serverName === "localdot" && params.mode !== "url" && (kind === undefined || kind === "mcp_tool_call");
      return ours
        ? { verdict: "approved", result: { action: "accept", content: explicitDefaults(params.requestedSchema) } }
        : { verdict: "declined", result: { action: "decline" } };
    }
    case "item/tool/requestUserInput":
      return {
        verdict: "declined",
        result: {
          answers: Object.fromEntries(
            (params?.questions ?? []).map((q) => [q.id, { answers: [denyLabel(q.options)].filter(Boolean) }]),
          ),
        },
      };
    case "item/tool/call":
      return {
        verdict: "declined",
        result: { success: false, contentItems: [{ type: "inputText", text: "localDot exposes no dynamic tools" }] },
      };
    default:
      return { verdict: "declined", error: { code: -32601, message: `localDot spike declines ${method}` } };
  }
}

export const threadParams = (cwd) => ({
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandbox: "read-only",
  cwd,
  ephemeral: true,
});
