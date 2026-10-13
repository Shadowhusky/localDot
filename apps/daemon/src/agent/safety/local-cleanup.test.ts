import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactor } from "../redact.ts";
import { AgentSession } from "../session.ts";
import { toolHarness } from "../testing/harness.ts";
import type { ToolCallContext, ToolDeps } from "../tools/deps.ts";
import { dispatchTool } from "../tools/index.ts";
import { shellTool } from "../tools/shell.ts";
import { authorizePrepared, toolRisk } from "./authorize.ts";
import {
  beginFileTracking,
  cleanupSyntax,
  creationCandidates,
  finishFileTracking,
  prepareLocalCleanup,
} from "./local-cleanup.ts";

const exec = promisify(execFile);
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "localdot-owned-cleanup-")));
  homes.push(home);
  const session = new AgentSession(ulid(), ulid(), "task", { append: vi.fn() });
  session.permissionMode = () => "full";
  const asks = vi.spyOn(session, "requestApproval").mockResolvedValue("approve");
  const ctx = {
    session,
    generation: { id: 1 },
    lease: {},
    check() {},
    signal: new AbortController().signal,
    callId: ulid(),
    step: ulid(),
    redact: redactor([]),
  } as unknown as ToolCallContext;
  const shell = async (
    input: { command: string; cwd?: string },
    chunk: (c: { chunk: string; stream: string }) => void,
  ) => {
    try {
      const output = await exec("/bin/sh", ["-c", input.command], {
        cwd: input.cwd ?? home,
        env: { ...process.env, HOME: home },
      });
      chunk({ stream: "stdout", chunk: output.stdout });
      return { exitCode: 0, timedOut: false, truncated: false };
    } catch (error) {
      const e = error as { stdout: string; stderr: string };
      chunk({ stream: "stderr", chunk: e.stderr ?? "" });
      return { exitCode: 1, timedOut: false, truncated: false };
    }
  };
  const deps = { desktop: () => ({ shell }) } as unknown as ToolDeps;
  const create = async (name: string, content = "agent artifact") => {
    const path = join(home, name);
    const track = await beginFileTracking(deps, ctx, [path]);
    await writeFile(path, content);
    await finishFileTracking(deps, ctx, track);
    return path;
  };
  const prepare = (command: string) => prepareLocalCleanup(deps, ctx, { command, cwd: home });
  return { home, ctx, deps, asks, shell, create, prepare };
}

describe("task-owned recoverable cleanup", () => {
  it("removes a created image without a card and preserves recoverable bytes", async () => {
    const h = await fixture();
    const path = await h.create("_test.png");
    const input = { command: "rm -f _test.png && printf finished", cwd: h.home };
    const plan = await h.prepare(input.command);
    expect(plan).toBeDefined();
    const facts = toolRisk("shell", input);
    if (!facts || !plan) throw new Error("Expected cleanup plan and shell facts");
    facts.command = plan.riskCommand;
    h.ctx.permit = await authorizePrepared(h.ctx, {
      tool: "shell",
      input,
      target: null,
      facts,
      revalidate: async () => true,
    });
    h.ctx.localCleanup = plan;
    const result = await shellTool(h.deps, h.ctx, input);
    expect(result.ok).toBe(true);
    expect(h.asks).not.toHaveBeenCalled();
    await expect(readFile(path)).rejects.toThrow();
    const root = join(h.home, ".local/share/localdot/recovered-files", h.ctx.session.id);
    const [action] = await readdir(root);
    if (!action) throw new Error("Expected recovery directory");
    expect(await readFile(join(root, action, "0"), "utf8")).toBe("agent artifact");
    expect(JSON.parse(await readFile(join(root, action, "manifest.json"), "utf8"))).toEqual([
      { original: path, saved: "0" },
    ]);
    expect(JSON.stringify(result)).toContain("finished");
  });

  it("tracks shell-created and agent-revised test pages, then cleans multiple files", async () => {
    const h = await fixture();
    await mkdir(join(h.home, "public"));
    for (const name of ["__seed", "__dump", "__nullrun", "__dump"]) {
      const input = {
        command: `cat > public/${name}.html <<'EOF'\npage ${name}\nEOF`,
        cwd: h.home,
      };
      h.ctx.permit = { approved: false, consume: () => true };
      expect((await shellTool(h.deps, h.ctx, input)).ok).toBe(true);
    }
    expect(
      await h.prepare(
        "rm -f public/__seed.html public/__dump.html public/__nullrun.html && git status --short",
      ),
    ).toBeDefined();
  });

  it("does not credit pre-existing files even when the agent overwrites them", async () => {
    const h = await fixture();
    await writeFile(join(h.home, "existing.txt"), "user data");
    await h.create("existing.txt", "agent edit");
    expect(await h.prepare("rm -f existing.txt")).toBeUndefined();
  });

  it("invalidates ownership when a file changes, and does not transfer it to another session", async () => {
    const h = await fixture();
    await h.create("owned.txt");
    const other = await fixture();
    expect(
      await prepareLocalCleanup(h.deps, other.ctx, { command: `rm -f ${h.home}/owned.txt` }),
    ).toBeUndefined();
    await writeFile(join(h.home, "owned.txt"), "user edit");
    expect(await h.prepare("rm -f owned.txt")).toBeUndefined();
    await h.create("owned.txt", "agent edit again");
    expect(await h.prepare("rm -f owned.txt")).toBeUndefined();
  });

  it("rechecks after authorization and refuses changed data without running the tail", async () => {
    const h = await fixture();
    await h.create("owned.txt");
    const plan = await h.prepare("rm -f owned.txt && touch tail-ran");
    await writeFile(join(h.home, "owned.txt"), "user edit");
    if (!plan) throw new Error("Expected cleanup plan");
    const result = await h.shell({ command: plan.command }, () => {});
    expect(result.exitCode).toBe(1);
    expect(await readFile(join(h.home, "owned.txt"), "utf8")).toBe("user edit");
    await expect(readFile(join(h.home, "tail-ran"))).rejects.toThrow();
  });

  it("refuses symlink files, symlink parents, directories and mixtures of owned/unowned files", async () => {
    const h = await fixture();
    const path = await h.create("owned.txt");
    await writeFile(join(h.home, "user.txt"), "user");
    expect(await h.prepare("rm -f owned.txt user.txt")).toBeUndefined();
    await symlink(path, join(h.home, "link.txt"));
    expect(await h.prepare("rm -f link.txt")).toBeUndefined();
    await mkdir(join(h.home, "dir"));
    expect(await h.prepare("rm -f dir")).toBeUndefined();
    await symlink(h.home, join(h.home, "alias"));
    expect(await h.prepare("rm -f alias/owned.txt")).toBeUndefined();
  });

  it("still asks for destructive operations after an eligible cleanup prefix", async () => {
    const h = await fixture();
    await h.create("owned.txt");
    const input = { command: "rm -f owned.txt && rm -rf important", cwd: h.home };
    const plan = await h.prepare(input.command);
    expect(plan).toBeDefined();
    const facts = toolRisk("shell", input);
    if (!facts || !plan) throw new Error("Expected cleanup plan and shell facts");
    facts.command = plan.riskCommand;
    await authorizePrepared(h.ctx, {
      tool: "shell",
      input,
      target: null,
      facts,
      revalidate: async () => true,
    });
    expect(h.asks).toHaveBeenCalledOnce();
  });
});

it.each([
  "rm -rf data",
  "rm *",
  "rm $file",
  "rm $(pwd)/x",
  "rm ../x",
  "rm /tmp/../x",
  "rm x; rm y",
  "sudo rm x",
  "rm -f x | sh",
  "rm --preserve-root x",
  "rm x &",
  "rm x > file",
  'rm "~/x"',
  "cd /tmp; rm x",
  "rm x &&",
])("does not rewrite ambiguous or recursive commands: %s", (command) => {
  expect(cleanupSyntax({ command })).toBeUndefined();
});

it("discovers the actual screenshot and heredoc writers from the reported session", () => {
  expect(
    creationCandidates({
      command:
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal shell syntax from the regression.
        'mkdir -p ~/pr1064-ui && echo "DISPLAY=$DISPLAY"; ffmpeg -loglevel error -f x11grab -video_size 1280x800 -i "${DISPLAY:-:0}" -frames:v 1 -y ~/pr1064-ui/_test.png && ls -l ~/pr1064-ui/_test.png',
    }).paths,
  ).toEqual(["~/pr1064-ui/_test.png"]);
  expect(
    creationCandidates({
      command:
        "cd ~/thema-app-pr1064 && cat > public/__seed.html <<'EOF'\n<script>hello</script>\nEOF\necho written",
    }),
  ).toEqual({ paths: ["public/__seed.html"], prefix: "cd ~/thema-app-pr1064 && " });
});

it.each(["auto", "full"] as const)(
  "dispatches owned creation and cleanup without approval in %s mode",
  async (permission) => {
    const f = await fixture();
    const h = toolHarness();
    try {
      h.session.permissionMode = () => permission;
      h.tools.desktop = f.deps.desktop;
      const asks = vi.spyOn(h.session, "requestApproval");
      for (const command of [
        "cat > screenshot.png <<'EOF'\nimage\nEOF",
        "rm -f screenshot.png && printf done",
      ]) {
        const response = await dispatchTool(
          { tools: h.tools },
          h.session,
          "shell",
          ulid(),
          { command, cwd: f.home },
          redactor([]),
          h.session.generation,
        );
        expect(response.result.ok).toBe(true);
      }
      expect(asks).not.toHaveBeenCalled();
      await expect(readFile(join(f.home, "screenshot.png"))).rejects.toThrow();
      expect(
        await readdir(join(f.home, ".local/share/localdot/recovered-files", h.session.id)),
      ).toHaveLength(1);
    } finally {
      h.close();
    }
  },
);
