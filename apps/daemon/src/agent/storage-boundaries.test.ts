import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "./memory.ts";
import { PrivateFiles } from "./private-files.ts";
import { AgentSettings, RoleChoice, SettingsStore } from "./settings.ts";
import { frontMatter, listSkills, skillDesktopPath, skillFiles } from "./skills.ts";

const owned: string[] = [];
const temp = () => {
  const h = realpathSync(mkdtempSync(join(tmpdir(), "localdot-agent-storage-")));
  owned.push(h);
  return h;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const p of owned.splice(0)) rmSync(p, { recursive: true, force: true });
});
const skill = (root: string, extras: Record<string, string> = {}) => {
  const d = join(root, "one");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), "---\nname: one\ndescription: A test skill\n---\n");
  for (const [n, v] of Object.entries(extras)) writeFileSync(join(d, n), v);
  return d;
};

describe("memory persistence boundaries", () => {
  it("rejects runtime traversal, malformed history and oversized manual memory files", () => {
    const h = temp();
    const memory = new MemoryStore(h);
    expect(() => memory.read("../outside" as "USER.md")).toThrow(/invalid/);
    const id = ulid();
    writeFileSync(
      join(h, "memory/.history", `${id}.json`),
      JSON.stringify({ file: "../outside", before: "x", after: "y", sessionId: ulid() }),
    );
    expect(() => memory.undo(id)).toThrow(/invalid memory history/);
    writeFileSync(join(h, "memory/USER.md"), "x".repeat(20_001));
    expect(() => memory.read("USER.md")).toThrow(/exceeds/);
  });
  it("rejects symlinked memory roots, notes and history directories without modifying targets", () => {
    for (const kind of ["root", "notes", "history"]) {
      const h = temp(),
        outside = temp();
      writeFileSync(join(outside, "sentinel"), "keep");
      if (kind === "root") symlinkSync(outside, join(h, "memory"));
      else {
        mkdirSync(join(h, "memory"));
        if (kind === "notes") symlinkSync(join(outside, "sentinel"), join(h, "memory/USER.md"));
        else symlinkSync(outside, join(h, "memory/.history"));
      }
      expect(() => new MemoryStore(h).apply(ulid(), "USER.md", "append", "x")).toThrow();
      expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("keep");
      expect(readdirSync(outside)).toEqual(["sentinel"]);
    }
  });
  it("recovers an interrupted content write from the private journal exactly once", () => {
    const h = temp();
    const memory = new MemoryStore(h);
    const original = PrivateFiles.prototype.write;
    let fail = true;
    vi.spyOn(PrivateFiles.prototype, "write").mockImplementation(function (
      this: PrivateFiles,
      rel,
      text,
    ) {
      if (rel === "USER.md" && fail) {
        fail = false;
        throw new Error("fixture disk failure");
      }
      return original.call(this, rel, text);
    });
    expect(() => memory.apply(ulid(), "USER.md", "append", "- recovered")).toThrow(
      "fixture disk failure",
    );
    const recovered = new MemoryStore(h);
    expect(recovered.read("USER.md")).toBe("# About the user\n\n- recovered\n");
    expect(new MemoryStore(h).read("USER.md")).toBe(recovered.read("USER.md"));
    expect(readdirSync(join(h, "memory")).sort()).toEqual([".history", "USER.md"]);
    expect(readdirSync(join(h, "memory/.history"))).toHaveLength(1);
    for (const name of readdirSync(join(h, "memory/.history")))
      expect(statSync(join(h, "memory/.history", name)).mode & 0o777).toBe(0o600);
  });
  it("completes interrupted undo and never permits undoing that change twice", () => {
    const h = temp();
    const memory = new MemoryStore(h);
    const c = memory.apply(ulid(), "USER.md", "append", "- A");
    const original = PrivateFiles.prototype.write;
    let fail = true;
    vi.spyOn(PrivateFiles.prototype, "write").mockImplementation(function (
      this: PrivateFiles,
      rel,
      text,
    ) {
      if (rel === `.history/${c.changeId}.json` && fail) {
        fail = false;
        throw new Error("fixture marker failure");
      }
      return original.call(this, rel, text);
    });
    expect(() => memory.undo(c.changeId)).toThrow("fixture marker failure");
    const recovered = new MemoryStore(h);
    expect(recovered.read("USER.md")).toBe("# About the user\n\n");
    expect(() => recovered.undo(c.changeId)).toThrow(/already undone/);
  });
  it("does not undo the same change again even after its old after-text is restored externally", () => {
    const h = temp();
    const memory = new MemoryStore(h);
    const change = memory.apply(ulid(), "USER.md", "append", "- A");
    const after = memory.read("USER.md");
    memory.undo(change.changeId);
    writeFileSync(join(h, "memory/USER.md"), after);
    expect(() => memory.undo(change.changeId)).toThrow(/already undone/);
    expect(memory.read("USER.md")).toBe(after);
  });
  it("does not overwrite an external edit when recovering a conflicting pending change", () => {
    const h = temp();
    const memory = new MemoryStore(h);
    const original = PrivateFiles.prototype.write;
    vi.spyOn(PrivateFiles.prototype, "write").mockImplementation(function (
      this: PrivateFiles,
      rel,
      text,
    ) {
      if (rel === "USER.md") throw new Error("fixture failure");
      return original.call(this, rel, text);
    });
    expect(() => memory.apply(ulid(), "USER.md", "append", "- A")).toThrow("fixture failure");
    vi.restoreAllMocks();
    writeFileSync(join(h, "memory/USER.md"), "manual edit\n");
    expect(() => new MemoryStore(h)).toThrow(/pending update/);
    expect(readFileSync(join(h, "memory/USER.md"), "utf8")).toBe("manual edit\n");
  });
});

describe("strict model settings", () => {
  const choice = { provider: "openai-compatible", model: "custom/model", key: "gateway" };
  it("requires both explicit finite manual prices and permits zero on either one side", () => {
    for (const price of [
      { inputUSDPerMTok: 0, outputUSDPerMTok: 1 },
      { inputUSDPerMTok: 1, outputUSDPerMTok: 0 },
    ])
      expect(RoleChoice.safeParse({ ...choice, price }).success).toBe(true);
    for (const price of [
      { inputUSDPerMTok: 0, outputUSDPerMTok: 0 },
      { inputUSDPerMTok: 1 },
      { inputUSDPerMTok: Infinity, outputUSDPerMTok: 1 },
      { inputUSDPerMTok: -1, outputUSDPerMTok: 1 },
      { inputUSDPerMTok: 10001, outputUSDPerMTok: 1 },
      { inputUSDPerMTok: "", outputUSDPerMTok: 1 },
    ])
      expect(RoleChoice.safeParse({ ...choice, price }).success).toBe(false);
    expect(RoleChoice.safeParse({ ...choice, model: "../not a model" }).success).toBe(false);
    expect(AgentSettings.safeParse({ main: choice, taskBudgetUSD: 0.000000001 }).success).toBe(
      false,
    );
  });
  it("persists a strict whole document privately and surfaces incompatible saved data", () => {
    const h = temp(),
      s = new SettingsStore(h);
    expect(s.get()).toEqual({});
    expect(s.put({ main: choice, taskBudgetUSD: 5 })).toEqual({ main: choice, taskBudgetUSD: 5 });
    expect(new SettingsStore(h).get()).toEqual(s.get());
    expect(statSync(join(h, "agent.json")).mode & 0o777).toBe(0o600);
    expect(() => s.put({ main: choice, unexpected: true } as never)).toThrow(/invalid/);
    writeFileSync(join(h, "agent.json"), JSON.stringify({ main: choice, futureField: true }));
    expect(() => s.get()).toThrow(/saved agent settings/);
  });
  it("refuses symlinked or oversized settings and keeps outside content unchanged", () => {
    const h = temp(),
      out = temp();
    writeFileSync(join(out, "data"), "keep");
    symlinkSync(join(out, "data"), join(h, "agent.json"));
    const settings = new SettingsStore(h);
    expect(() => settings.get()).toThrow();
    expect(() => settings.put({ main: choice })).toThrow();
    expect(readFileSync(join(out, "data"), "utf8")).toBe("keep");
    rmSync(join(h, "agent.json"));
    writeFileSync(join(h, "agent.json"), " ".repeat(64 * 1024 + 1));
    expect(() => settings.get()).toThrow(/saved agent settings/);
  });
});

describe("bounded skill collection", () => {
  it("skips linked roots, skill folders and front matter files", () => {
    const root = temp(),
      out = temp();
    const dir = skill(out);
    symlinkSync(dir, join(root, "linked"));
    expect(listSkills(undefined, root)).toEqual([]);
    const actual = skill(root);
    rmSync(join(actual, "SKILL.md"));
    symlinkSync(join(dir, "SKILL.md"), join(actual, "SKILL.md"));
    expect(listSkills(undefined, root)).toEqual([]);
    const rootLink = join(temp(), "root");
    symlinkSync(out, rootLink);
    expect(listSkills(undefined, rootLink)).toEqual([]);
  });
  it("never collects linked nested trees or special paths and validates desktop names", () => {
    const root = temp(),
      out = temp();
    const dir = skill(root);
    writeFileSync(join(out, "secret"), "not copied");
    symlinkSync(out, join(dir, "nested"));
    const [info] = listSkills(undefined, root);
    if (!info) throw new Error("fixture missing");
    expect(skillFiles(info).map((f) => f.rel)).toEqual(["SKILL.md"]);
    expect(() => skillDesktopPath("../escape")).toThrow(/invalid/);
    expect(frontMatter("---\nname: one\nname: two\ndescription: duplicate\n---")).toEqual({});
    expect(Object.getPrototypeOf(frontMatter("---\n__proto__: evil\nname: good\n---"))).toBeNull();
  });
  it("refuses more than 200 files or 10 MiB before copying an oversized skill", () => {
    const root = temp(),
      dir = skill(root);
    for (let i = 0; i < 200; i++) writeFileSync(join(dir, `f${i}`), "");
    const info = listSkills(undefined, root)[0];
    if (!info) throw new Error("fixture missing");
    expect(() => skillFiles(info)).toThrow(/200 files/);
    for (let i = 0; i < 200; i++) rmSync(join(dir, `f${i}`));
    writeFileSync(join(dir, "big"), "");
    truncateSync(join(dir, "big"), 10 * 1024 * 1024 + 1);
    expect(() => skillFiles(info)).toThrow(/byte limit/);
  });
  it("rejects a replaced skill root and bounds deep empty trees", () => {
    const root = temp(),
      dir = skill(root);
    const info = listSkills(undefined, root)[0];
    if (!info) throw new Error("fixture missing");
    let nested = dir;
    for (let i = 0; i < 34; i++) {
      nested = join(nested, "d");
      mkdirSync(nested);
    }
    expect(() => skillFiles(info)).toThrow(/tree is too large/);
    rmSync(dir, { recursive: true });
    symlinkSync(temp(), dir);
    expect(() => skillFiles(info)).toThrow(/invalid skill/);
  });
});
