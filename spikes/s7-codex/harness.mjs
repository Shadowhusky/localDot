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

export const threadParams = (cwd) => ({
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandbox: "read-only",
  cwd,
  ephemeral: true,
});
