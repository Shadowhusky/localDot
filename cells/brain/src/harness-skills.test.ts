import { readFileSync } from "node:fs";
import { type FilesInput, PERSONAS, type ToolResult } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { driveHarness, type HarnessHost, type HarnessStep } from "./harness.ts";
import { skillChange } from "./harness-skills.ts";

const skillFile = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\nInstructions for ${name}.`;
const installed = (name: string, description: string) => ({
  name,
  description,
  path: `~/.skills/${name}`,
});

// The computer's skill files as the daemon's files tool answers them; `dirs` changes when a
// scripted command installs a skill.
function computer(files: Record<string, string>, dirs: Record<string, string[]> = {}) {
  const calls: string[] = [];
  const read = async (input: FilesInput): Promise<ToolResult> => {
    const { op, path } = input as { op: string; path: string };
    calls.push(`${op} ${path}`);
    if (op === "list") {
      const entries = dirs[path];
      return entries
        ? {
            ok: true,
            content: [],
            fileList: {
              path,
              truncated: false,
              entries: entries.map((name) => ({ name, type: "dir" as const, bytes: 0 })),
            },
          }
        : { ok: false, content: [], fileError: "not_found" };
    }
    const content = files[path];
    return content === undefined
      ? { ok: false, content: [], fileError: "not_found" }
      : {
          ok: true,
          content: [],
          fileRead: { path, content, bytes: content.length, binary: false, truncated: false },
        };
  };
  return { read, calls, lists: (path: string) => calls.filter((c) => c === `list ${path}`).length };
}

const shell = (id: string, command: string): HarnessStep => ({
  text: "",
  calls: [{ id, name: "shell", input: { command } }],
});
const load = (id: string, name: string): HarnessStep => ({
  text: "",
  calls: [{ id, name: "skill", input: { name } }],
});
const done: HarnessStep = { text: "", calls: [{ id: "done", name: "done", input: {} }] };

// Each request's harness context, and each native skill load's output, by call id.
async function run(
  skills: HarnessHost["skills"],
  steps: HarnessStep[],
  onExecute: (id: string) => void = () => {},
) {
  const contexts: string[] = [];
  const outputs = new Map<string, ToolResult>();
  await driveHarness({
    sessionId: "skills-session",
    task: "Use the skills",
    signal: new AbortController().signal,
    skills,
    request: async (_signal, request) => {
      contexts.push(request.context.map((item) => item.text).join("\n"));
      return steps.shift() ?? done;
    },
    execute: async (id, _signal, output) => {
      onExecute(id);
      if (output) outputs.set(id, output);
      return {
        result: output ?? { ok: true, content: [{ type: "text", text: "ok" }] },
        conclude: id === "done",
      };
    },
    stopping: async () => false,
  });
  return { contexts, outputs };
}

describe("the skill catalog", () => {
  it("comes from the installed skills, with no folder listed and only the loaded skill read", async () => {
    const disk = computer({
      "/config/.skills/office-files/SKILL.md": skillFile("office-files", "Office conversions"),
    });
    const { contexts, outputs } = await run(
      {
        installed: [
          installed("office-files", "Office conversions"),
          installed("web-research", "Research on the web"),
        ],
        read: disk.read,
      },
      [shell("build", "pnpm test"), load("load", "office-files")],
    );
    expect(contexts[0]).toContain("`office-files`: Office conversions");
    expect(contexts[0]).toContain("`web-research`: Research on the web");
    expect(disk.calls).toEqual(["read /config/.skills/office-files/SKILL.md"]);
    const loaded = JSON.stringify(outputs.get("load")?.content);
    expect(outputs.get("load")?.ok).toBe(true);
    expect(loaded).toContain("Instructions for office-files.");
    expect(loaded).toContain("Base directory for this skill: /config/.skills/office-files");
  });

  it("scans the agent's skill folders after an install, probing a missing one once per task", async () => {
    const dirs: Record<string, string[]> = {};
    const disk = computer(
      {
        "/config/.agents/skills/alpha/SKILL.md": skillFile("alpha", "Alpha workflow"),
        "/config/.agents/skills/beta/SKILL.md": skillFile("beta", "Beta workflow"),
      },
      dirs,
    );
    const { contexts } = await run(
      { installed: [], read: disk.read },
      [
        shell("install-alpha", "npx skills add owner/alpha"),
        shell("install-beta", "npx skills add owner/beta"),
        shell("use", "python3 ~/.agents/skills/beta/run.py"),
      ],
      (id) => {
        if (id === "install-alpha") dirs["/config/.agents/skills"] = ["alpha"];
        if (id === "install-beta") dirs["/config/.agents/skills"] = ["alpha", "beta"];
      },
    );
    expect(contexts[0]).not.toContain("alpha");
    expect(contexts.at(-1)).toContain("`alpha`: Alpha workflow");
    expect(contexts.at(-1)).toContain("`beta`: Beta workflow");
    expect(disk.lists("/config/.dsh/skills")).toBe(1);
    expect(disk.lists("/config/.skills")).toBe(0);
  });

  it("probes a missing skill folder again only after a command names it", async () => {
    const dirs: Record<string, string[]> = {};
    const disk = computer(
      {
        "/config/.agents/skills/alpha/SKILL.md": skillFile("alpha", "Alpha workflow"),
        "/config/.dsh/skills/gamma/SKILL.md": skillFile("gamma", "Gamma workflow"),
      },
      dirs,
    );
    const { contexts } = await run(
      { installed: [], read: disk.read },
      [
        shell("install-alpha", "npx skills add owner/alpha"),
        shell("install-gamma", "mkdir -p ~/.dsh/skills && cp -r /tmp/gamma ~/.dsh/skills/"),
      ],
      (id) => {
        if (id === "install-alpha") dirs["/config/.agents/skills"] = ["alpha"];
        if (id === "install-gamma") dirs["/config/.dsh/skills"] = ["gamma"];
      },
    );
    expect(disk.lists("/config/.dsh/skills")).toBe(2);
    expect(contexts.at(-1)).toContain("`gamma`: Gamma workflow");
  });

  it("counts only installs and writes into the agent's skill folders as skill changes", () => {
    const shellChange = (command: string) => skillChange("shell", { command });
    for (const command of [
      "pnpm test",
      "python3 ~/.skills/office-files/scripts/convert.py in.docx > out.pdf",
      "python3 ~/.agents/skills/report/build.py 2>&1",
      "cat ~/.agents/skills/report/SKILL.md",
      "cp ~/.skills/slides/template.pptx ~/Desktop/",
    ])
      expect(shellChange(command), command).toBeUndefined();
    for (const command of [
      "npx skills add owner/report",
      "git clone https://github.com/owner/report ~/.agents/skills/report",
      "mkdir -p ~/.dsh/skills && cp -r /tmp/report ~/.dsh/skills/",
      "cat > ~/.agents/skills/report/SKILL.md <<'EOF'",
      "rm -rf ~/.agents/skills/report",
    ])
      expect(shellChange(command), command).toBe(command);
    expect(skillChange("files", { op: "write", path: "/config/.dsh/skills/x/SKILL.md" })).toBe(
      "/config/.dsh/skills/x/SKILL.md",
    );
    expect(skillChange("files", { op: "write", path: "/config/.skills/x/SKILL.md" })).toBe(
      undefined,
    );
    expect(skillChange("shell", {})).toBeUndefined();
  });

  it("leaves out an installed skill whose name the harness cannot address", async () => {
    const { contexts } = await run(
      {
        installed: [installed("bad--name", "Unaddressable"), installed("good", "Addressable")],
        read: computer({}).read,
      },
      [],
    );
    expect(contexts[0]).toContain("`good`: Addressable");
    expect(contexts[0]).not.toContain("Unaddressable");
  });
});

it.each([
  ["coder", "webapp-testing"],
  ["design", "interface-quality"],
] as const)(
  "loads the actual %s skill pack on demand through the native harness",
  async (persona, selected) => {
    const root = new URL("../../../skills/", import.meta.url);
    const names = PERSONAS[persona].skills;
    const files = Object.fromEntries(
      names.map((name) => [
        `/config/.skills/${name}/SKILL.md`,
        readFileSync(new URL(`${name}/SKILL.md`, root), "utf8"),
      ]),
    );
    const disk = computer(files);
    const { contexts, outputs } = await run(
      {
        installed: names.map((name) => installed(name, name)),
        read: disk.read,
      },
      [load("load", selected)],
    );
    expect(outputs.get("load")?.ok).toBe(true);
    const body = files[`/config/.skills/${selected}/SKILL.md`]
      ?.replace(/^---[\s\S]*?\n---\n/, "")
      .trim();
    if (!body) throw new Error("Missing skill body");
    const loaded = outputs
      .get("load")
      ?.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    expect(loaded).toContain(body);
    expect(disk.calls).toEqual([`read /config/.skills/${selected}/SKILL.md`]);
    expect(contexts[0]).toContain("skill-discovery");
    expect(contexts[0]).not.toContain(files[`/config/.skills/${selected}/SKILL.md`]);
  },
);
