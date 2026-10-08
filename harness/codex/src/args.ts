import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type OwnedSandboxProfile, type SandboxInput, sandboxSettings } from "./profile.ts";
import { assertOwnedCodexDirectory } from "./roots.ts";

declare const __LOCALDOT_PACKAGED__: boolean | undefined;
export const MCP_SERVER_NAME = "localdot";
export const MCP_BRIDGE = "/usr/bin/nc";
export const MCP_TOOL_TIMEOUT_SEC = 86400;
export const DISABLED_FEATURES = Object.freeze([
  "shell_tool",
  "unified_exec",
  "view_image",
  "shell_snapshot",
  "plugins",
  "remote_plugin",
  "apps",
  "tool_suggest",
  "computer_use",
  "browser_use",
  "browser_use_external",
  "in_app_browser",
  "multi_agent",
  // The 0.154.0 pin accepts forced collaboration calls unless V2 is explicitly disabled too.
  // The real offline probe verifies rejection before a child thread or model request is created.
  "multi_agent_v2",
  "goals",
  "image_generation",
  "hooks",
  "memories",
  "skill_mcp_dependency_install",
  "skill_search",
  "workspace_dependencies",
] as const);
export type CodexArgsInput = SandboxInput;
export class CodexArgsError extends Error {
  constructor() {
    super("The localDot Codex command could not be verified.");
    this.name = "CodexArgsError";
  }
}
export function codexArgs(input: CodexArgsInput): readonly string[] {
  try {
    // The same capabilities determine both the granted socket and the fixed MCP command.
    const settings = sandboxSettings(input);
    const args = [
      ...[
        'cli_auth_credentials_store="file"',
        'forced_login_method="chatgpt"',
        "check_for_update_on_startup=false",
        "analytics.enabled=false",
        "notify=[]",
        'web_search="disabled"',
        'history.persistence="none"',
        "project_doc_max_bytes=0",
        "skills.bundled.enabled=false",
        "agents.enabled=false",
      ].flatMap((kv) => ["-c", kv]),
      ...DISABLED_FEATURES.flatMap((f) => ["--disable", f]),
      "--enable",
      "tool_call_mcp_elicitation",
    ];
    if (input.purpose === "task") {
      const socket = settings.network.allowUnixSockets?.[0];
      if (!socket) throw new CodexArgsError();
      args.push(
        ...[
          `mcp_servers.${MCP_SERVER_NAME}.command=${JSON.stringify(MCP_BRIDGE)}`,
          `mcp_servers.${MCP_SERVER_NAME}.args=["-U", ${JSON.stringify(socket)}]`,
          `mcp_servers.${MCP_SERVER_NAME}.startup_timeout_sec=20`,
          `mcp_servers.${MCP_SERVER_NAME}.tool_timeout_sec=${MCP_TOOL_TIMEOUT_SEC}`,
        ].flatMap((kv) => ["-c", kv]),
      );
    }
    return Object.freeze(args);
  } catch {
    throw new CodexArgsError();
  }
}
export function srtCli(): string {
  try {
    const packaged = typeof __LOCALDOT_PACKAGED__ === "boolean" && __LOCALDOT_PACKAGED__;
    const file = packaged
      ? fileURLToPath(new URL("./sandbox-runtime/dist/cli.mjs", import.meta.url))
      : createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime/dist/cli.js");
    if (!isAbsolute(file) || !lstatSync(file).isFile()) throw new CodexArgsError();
    if (packaged && (realpathSync(file) !== file || lstatSync(file).nlink !== 1))
      throw new CodexArgsError();
    return realpathSync(file);
  } catch {
    throw new CodexArgsError();
  }
}
export interface SrtArgvInput {
  readonly sandbox: SandboxInput;
  readonly profile: OwnedSandboxProfile;
}
export function srtArgv(
  input: SrtArgvInput,
): Readonly<{ command: string; args: readonly string[] }> {
  try {
    const expected = sandboxSettings(input.sandbox),
      profile = input.profile;
    assertOwnedCodexDirectory(input.sandbox.roots, profile.directory, "profilesRoot");
    if (profile.path !== join(profile.directory.path, "srt.json")) throw new CodexArgsError();
    const info = lstatSync(profile.path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600 ||
      info.nlink !== 1 ||
      info.size > 65536 ||
      realpathSync(profile.path) !== profile.path
    )
      throw new CodexArgsError();
    const fd = openSync(profile.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== info.dev || opened.ino !== info.ino) throw new CodexArgsError();
      if (JSON.stringify(JSON.parse(readFileSync(fd, "utf8"))) !== JSON.stringify(expected))
        throw new CodexArgsError();
    } finally {
      closeSync(fd);
    }
    // Only builders select options; callers cannot insert a shell command, other CLI, or late flags.
    return Object.freeze({
      command: process.execPath,
      args: Object.freeze([
        srtCli(),
        "--settings",
        profile.path,
        "--",
        input.sandbox.installed.codexBin,
        "app-server",
        "--listen",
        "stdio://",
        ...codexArgs(input.sandbox),
      ]),
    });
    // File metadata/profile checks are not executable authorization. Task9 rehashes the installed
    // pin and validates Mac/CA/nc/callback gates immediately before the owner-controlled spawn.
  } catch {
    throw new CodexArgsError();
  }
}
