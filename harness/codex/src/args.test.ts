import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexArgs,
  DISABLED_FEATURES,
  MCP_BRIDGE,
  MCP_TOOL_TIMEOUT_SEC,
  srtArgv,
  srtCli,
} from "./args.ts";
import { type SandboxInput, sandboxSettings, writeSettingsFile } from "./profile.ts";
import {
  codexInstallDirectory,
  createOwnedCodexDirectory,
  prepareOwnedCodexRoots,
} from "./roots.ts";
import { codexRelease, releaseInstallKey } from "./version.ts";

const owned: string[] = [];
function fixture(purpose: SandboxInput["purpose"] = "task") {
  const top = realpathSync(mkdtempSync("/tmp/ld-codex-argv-"));
  owned.push(top);
  const user = join(top, "user's home");
  mkdirSync(user, { mode: 0o700 });
  const roots = prepareOwnedCodexRoots(join(user, ".localdot"), user),
    release = codexRelease("darwin", "arm64");
  if (!release) throw new Error("Missing test pin.");
  const binDir = codexInstallDirectory(roots, releaseInstallKey(release));
  mkdirSync(binDir, { mode: 0o700 });
  for (const name of ["codex", "codex-code-mode-host"])
    writeFileSync(join(binDir, name), "inert argv fixture", { mode: 0o555 });
  const input: SandboxInput = {
    purpose,
    roots,
    work: createOwnedCodexDirectory(roots, "workRoot"),
    installed: {
      version: "0.154.0",
      platform: "darwin-arm64",
      binDir,
      codexBin: join(binDir, "codex"),
      codeModeHostBin: join(binDir, "codex-code-mode-host"),
    },
    platform: "darwin",
    ...(purpose === "task" ? { mcp: createOwnedCodexDirectory(roots, "runRoot") } : {}),
  };
  return { top, input };
}
const pairs = (a: readonly string[], flag: string) =>
  a.flatMap((x, i) => (x === flag ? [a[i + 1] as string] : []));
afterEach(() => {
  for (const p of owned.splice(0)) rmSync(p, { recursive: true, force: true });
});
describe("fixed Codex command", () => {
  it.each(["task", "account", "login-browser"] as const)(
    "disables both agent systems and other host tools for %s and forces file-backed ChatGPT authentication",
    (purpose) => {
      const { input } = fixture(purpose),
        args = codexArgs(input),
        config = pairs(args, "-c");
      expect(DISABLED_FEATURES).toEqual([
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
        "multi_agent_v2",
        "goals",
        "image_generation",
        "hooks",
        "memories",
        "skill_mcp_dependency_install",
        "skill_search",
        "workspace_dependencies",
      ]);
      expect(MCP_BRIDGE).toBe("/usr/bin/nc");
      expect(MCP_TOOL_TIMEOUT_SEC).toBe(86400);
      expect(pairs(args, "--disable")).toEqual([...DISABLED_FEATURES]);
      expect(pairs(args, "--enable")).toEqual(["tool_call_mcp_elicitation"]);
      expect(config.slice(0, 9)).toEqual([
        'cli_auth_credentials_store="file"',
        'forced_login_method="chatgpt"',
        "check_for_update_on_startup=false",
        "analytics.enabled=false",
        "notify=[]",
        'web_search="disabled"',
        'history.persistence="none"',
        "project_doc_max_bytes=0",
        "skills.bundled.enabled=false",
      ]);
      expect(config).toContain("agents.enabled=false");
      const mcp = config.filter((x) => x.startsWith("mcp_servers."));
      if (purpose !== "task") expect(mcp).toEqual([]);
      else {
        expect(mcp).toEqual([
          `mcp_servers.localdot.command="${MCP_BRIDGE}"`,
          `mcp_servers.localdot.args=["-U", ${JSON.stringify(join((input.mcp as NonNullable<typeof input.mcp>).path, "m.sock"))}]`,
          "mcp_servers.localdot.startup_timeout_sec=20",
          `mcp_servers.localdot.tool_timeout_sec=${MCP_TOOL_TIMEOUT_SEC}`,
        ]);
        expect(JSON.parse((mcp[1] as string).slice((mcp[1] as string).indexOf("=") + 1))).toEqual([
          "-U",
          join((input.mcp as NonNullable<typeof input.mcp>).path, "m.sock"),
        ]);
      }
    },
  );
  it.each(["missing", "cloned", "wrong-area", "foreign-purpose"])(
    "refuses %s MCP ownership",
    (which) => {
      const { input } = fixture();
      const bad = { ...input };
      if (which === "missing") bad.mcp = undefined;
      if (which === "cloned") bad.mcp = { ...(input.mcp as NonNullable<typeof input.mcp>) };
      if (which === "wrong-area") bad.mcp = input.work;
      if (which === "foreign-purpose") bad.purpose = "account";
      expect(() => codexArgs(bad)).toThrow("The localDot Codex command could not be verified.");
    },
  );
  it("puts the fixed sandbox/Codex commands after -- with literal argv and no shell", async () => {
    const { input } = fixture(),
      profile = await writeSettingsFile(input.roots, sandboxSettings(input));
    const result = srtArgv({ sandbox: input, profile });
    expect(result).toEqual({
      command: process.execPath,
      args: [
        srtCli(),
        "--settings",
        profile.path,
        "--",
        input.installed.codexBin,
        "app-server",
        "--listen",
        "stdio://",
        ...codexArgs(input),
      ],
    });
    expect(Object.isFrozen(result.args)).toBe(true);
  });
  it.each(["path", "directory", "mode", "link", "settings", "purpose"])(
    "refuses %s profile substitution",
    async (which) => {
      const { input } = fixture(),
        profile = await writeSettingsFile(input.roots, sandboxSettings(input));
      const p = { ...profile },
        sandbox = { ...input };
      if (which === "path") p.path = join(profile.directory.path, "other.json");
      if (which === "directory") p.directory = { ...profile.directory };
      if (which === "mode") chmodSync(profile.path, 0o666);
      if (which === "link") {
        rmSync(profile.path);
        symlinkSync(join(input.work.path, "foreign"), profile.path);
      }
      if (which === "settings")
        writeFileSync(profile.path, JSON.stringify({ filesystem: { allowWrite: ["/"] } }));
      if (which === "purpose") {
        sandbox.purpose = "account";
        sandbox.mcp = undefined;
      }
      expect(() => srtArgv({ sandbox, profile: p })).toThrow();
    },
  );
});
