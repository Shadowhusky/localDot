import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_CODE_INSTALL, CLAUDE_CODE_SIGN_IN, CLAUDE_CODE_UPDATE } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeCodeSetup,
  type ClaudeCodeSetupDeps,
  ClaudeCodeUnavailable,
  claudeCodeEnv,
  findClaudeCode,
  ISOLATION,
  type Run,
  versionAtLeast,
} from "./setup.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const SIGNED_IN = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  email: "person@example.com",
  orgName: "Fixture org",
  subscriptionType: "max",
});
const TOKENS = {
  ANTHROPIC_API_KEY: "sk-ant-api03-fixture",
  ANTHROPIC_AUTH_TOKEN: "fixture-auth-token",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-fixture",
  CLAUDE_CONFIG_DIR: "/somewhere/else",
  NODE_OPTIONS: "--require /tmp/evil.js",
};
function fixture(answers: Partial<Record<"version" | "auth", string>> = {}, find = true) {
  const calls: { file: string; args: readonly string[]; env: Record<string, string> }[] = [];
  const run = vi.fn<Run>(async (file, args, { env }) => {
    calls.push({ file, args, env });
    if (args[0] === "--version")
      return { code: 0, stdout: answers.version ?? "2.1.290 (Claude Code)\n" };
    if (args.join(" ") === "auth status --json")
      return { code: 0, stdout: answers.auth ?? SIGNED_IN };
    throw new Error(`unexpected command ${args.join(" ")}`);
  });
  const listModels = vi.fn<ClaudeCodeSetupDeps["listModels"]>(async () => [
    { id: "sonnet", name: "Sonnet" },
    { id: "opus", name: "Opus" },
    { id: "sonnet[1m]", name: "Sonnet (1M context)" },
    { id: "opus", name: "Opus again" },
  ]);
  const setup = new ClaudeCodeSetup({
    home: "/Users/person",
    workDir: () => "/private/localdot/claude-code/work",
    find: () => (find ? "/Users/person/.local/bin/claude" : undefined),
    run,
    env: { PATH: "/usr/bin:/bin", HOME: "/elsewhere", LANG: "en_GB.UTF-8", ...TOKENS },
    listModels,
    now: () => 1_000,
  });
  return { setup, run, calls, listModels };
}

describe("Claude Code detection", () => {
  it("asks only the user's Claude Code, through its own version and status commands", async () => {
    const f = fixture();
    const status = await f.setup.check();
    expect(f.calls.map((call) => [call.file, call.args.join(" ")])).toEqual([
      ["/Users/person/.local/bin/claude", "--version"],
      ["/Users/person/.local/bin/claude", "auth status --json"],
    ]);
    expect(status).toEqual({
      state: "signed_in",
      version: "2.1.290",
      plan: "max",
      models: [
        { id: "sonnet", name: "Sonnet" },
        { id: "opus", name: "Opus" },
      ],
      checkedAt: 1_000,
    });
    // The account's address and organisation never leave Claude Code's own answer.
    expect(JSON.stringify(status)).not.toMatch(/person@example\.com|Fixture org/);
  });
  it("never hands a sign-in, API key or another config folder to Claude Code", async () => {
    const f = fixture();
    await f.setup.check();
    const envs = [...f.calls.map((call) => call.env), f.listModels.mock.calls[0]?.[0].env];
    for (const env of envs) {
      for (const name of Object.keys(TOKENS)) expect(env).not.toHaveProperty(name);
      expect(env).toMatchObject({ HOME: "/Users/person", ...ISOLATION });
      expect(env?.PATH?.split(":")[0]).toBe("/Users/person/.local/bin");
    }
    expect(f.listModels.mock.calls[0]?.[0].cwd).toBe("/private/localdot/claude-code/work");
  });
  it("says how to install Claude Code when it isn't there, without running anything", async () => {
    const f = fixture({}, false);
    expect(await f.setup.check()).toMatchObject({
      state: "not_installed",
      reason: "Install Claude Code and sign in there.",
      command: CLAUDE_CODE_INSTALL,
      models: [],
    });
    expect(f.run).not.toHaveBeenCalled();
  });
  it("asks for an update below the version that takes prompts verbatim", async () => {
    const f = fixture({ version: "2.1.100 (Claude Code)" });
    expect(await f.setup.check()).toMatchObject({
      state: "outdated",
      version: "2.1.100",
      command: CLAUDE_CODE_UPDATE,
    });
    expect(f.calls).toHaveLength(1);
  });
  it("asks the user to sign in to Claude Code itself when it is signed out", async () => {
    const f = fixture({ auth: JSON.stringify({ loggedIn: false }) });
    expect(await f.setup.check()).toMatchObject({
      state: "signed_out",
      command: CLAUDE_CODE_SIGN_IN,
    });
    await expect(f.setup.launch()).rejects.toBeInstanceOf(ClaudeCodeUnavailable);
    expect(f.listModels).not.toHaveBeenCalled();
  });
  it("treats an unreadable status as signed out, and a silent CLI as unavailable", async () => {
    expect(await fixture({ auth: "not json" }).setup.check()).toMatchObject({
      state: "signed_out",
    });
    expect(await fixture({ version: "" }).setup.check()).toMatchObject({ state: "unavailable" });
  });
  it("falls back to Claude Code's model aliases when it can't list its models", async () => {
    const f = fixture();
    f.listModels.mockRejectedValueOnce(new Error("no models"));
    expect((await f.setup.check()).models.map((model) => model.id)).toEqual(["sonnet", "opus"]);
  });
  it("checks sign-in again for every task, and launches the same installation", async () => {
    const f = fixture();
    await f.setup.status();
    const launch = await f.setup.launch();
    expect(launch).toMatchObject({
      executable: "/Users/person/.local/bin/claude",
      cwd: "/private/localdot/claude-code/work",
      plan: "max",
    });
    expect(f.calls.filter((call) => call.args[0] === "auth")).toHaveLength(2);
  });
});

describe("finding Claude Code", () => {
  it("uses an executable claude on the PATH or in an installer's folder", () => {
    const home = mkdtempSync("/tmp/ld-claude-");
    dirs.push(home);
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const other = join(home, "other");
    mkdirSync(other);
    writeFileSync(join(other, "claude"), "#!/bin/sh\n");
    expect(findClaudeCode(home, other, [])).toBeUndefined();
    writeFileSync(join(bin, "claude"), "#!/bin/sh\n");
    chmodSync(join(bin, "claude"), 0o755);
    expect(findClaudeCode(home, other, [])).toBe(join(bin, "claude"));
    chmodSync(join(other, "claude"), 0o755);
    expect(findClaudeCode(home, `relative:${other}`, [])).toBe(join(other, "claude"));
  });
  it("compares versions numerically", () => {
    expect(versionAtLeast("2.1.248", "2.1.248")).toBe(true);
    expect(versionAtLeast("2.10.0", "2.9.300")).toBe(true);
    expect(versionAtLeast("2.1.99", "2.1.248")).toBe(false);
  });
  it("passes only what Claude Code needs to run as the user", () => {
    const env = claudeCodeEnv(
      { PATH: "/usr/bin", USER: "person", SHELL: "/bin/zsh", ...TOKENS, SECRET: "x" },
      "/Users/person",
      "/opt/homebrew/bin/claude",
    );
    expect(env).toEqual({
      USER: "person",
      SHELL: "/bin/zsh",
      HOME: "/Users/person",
      PATH: "/opt/homebrew/bin:/usr/bin",
      ...ISOLATION,
    });
  });
});
