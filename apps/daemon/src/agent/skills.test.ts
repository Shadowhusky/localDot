import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERSONA_SKILLS, PERSONAS } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  frontMatter,
  leftoverSkills,
  listSkills,
  skillDesktopPath,
  skillFiles,
  skillsFor,
} from "./skills.ts";

const ownedHomes: string[] = [];
afterEach(() => {
  for (const home of ownedHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function ownedTemp(prefix: string): string {
  const home = mkdtempSync(prefix);
  ownedHomes.push(home);
  return home;
}

function skill(root: string, folder: string, md: string, extra: Record<string, string> = {}) {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, folder, "SKILL.md"), md);
  for (const [name, text] of Object.entries(extra)) {
    mkdirSync(join(root, folder, name, ".."), { recursive: true });
    writeFileSync(join(root, folder, name), text);
  }
}

describe("skills", () => {
  it("reads name and description from the front matter", () => {
    expect(
      frontMatter('---\nname: pdf-tools\ndescription: "Fill and merge PDFs"\n---\n# Body'),
    ).toEqual({ name: "pdf-tools", description: "Fill and merge PDFs" });
    expect(frontMatter("# no front matter")).toEqual({});
  });

  it("lists built-in and user skills, the user's winning a shared name, invalid ones skipped", () => {
    const builtin = ownedTemp(join(tmpdir(), "skills-builtin-"));
    const user = ownedTemp(join(tmpdir(), "skills-user-"));
    skill(builtin, "office", "---\nname: office-files\ndescription: Built-in office help\n---\n");
    skill(builtin, "maps", "---\nname: maps\ndescription: Maps\n---\n");
    skill(user, "office2", "---\nname: office-files\ndescription: My office help\n---\n");
    skill(user, "bad", "---\nname: Bad Name\ndescription: x\n---\n");
    skill(user, "nodesc", "---\nname: nodesc\n---\n");
    expect(listSkills(builtin, user).map((s) => [s.name, s.description, s.source])).toEqual([
      ["maps", "Maps", "builtin"],
      ["office-files", "My office help", "user"],
    ]);
    expect(listSkills(undefined, join(user, "missing"))).toEqual([]);
  });

  it("collects a skill's files with their executable bit, never through a symlink", () => {
    const root = ownedTemp(join(tmpdir(), "skills-files-"));
    skill(root, "s", "---\nname: s\ndescription: d\n---\n", { "scripts/run.sh": "echo hi\n" });
    chmodSync(join(root, "s", "scripts/run.sh"), 0o755);
    symlinkSync("/etc/hosts", join(root, "s", "hosts"));
    const [info] = listSkills(undefined, root);
    if (!info) throw new Error("no skill");
    expect(skillFiles(info).map((f) => [f.rel, f.mode])).toEqual([
      ["SKILL.md", 0o644],
      ["scripts/run.sh", 0o755],
    ]);
    expect(skillDesktopPath("s")).toBe("~/.skills/s");
  });
});

describe("a dot's skills", () => {
  const skill = (name: string, source: "builtin" | "user" = "builtin") => ({
    name,
    description: `${name} skill`,
    dir: `/skills/${name}`,
    source,
  });
  const all = [
    skill("office-files"),
    skill("video-editing"),
    skill("coding-workflow"),
    skill("my-notes", "user"),
  ];
  it("brings its own built-in skills and every one of the user's", () => {
    expect(skillsFor("video", all).map((s) => s.name)).toEqual([
      "office-files",
      "video-editing",
      "my-notes",
    ]);
    expect(skillsFor(undefined, all).map((s) => s.name)).toEqual(["office-files", "my-notes"]);
  });
  it("lets go of another dot's built-in skills only, never one the user or dot added", () => {
    const kept = skillsFor("video", all);
    expect(
      leftoverSkills(["coding-workflow", "video-editing", "my-notes", "agent-made"], kept),
    ).toEqual(["coding-workflow"]);
  });
});

describe("the built-in skills", () => {
  it("has every skill each dot names, each with a name and a description", () => {
    const repo = new URL("../../../../skills", import.meta.url).pathname;
    const found = new Map(
      listSkills(repo, ownedTemp(join(tmpdir(), "ld-user-skills-"))).map((s) => [s.name, s]),
    );
    for (const persona of Object.values(PERSONAS))
      for (const name of persona.skills) {
        expect(found.get(name), `${persona.id} needs ${name}`).toBeDefined();
        expect(found.get(name)?.description.length).toBeGreaterThan(40);
      }
    expect([...found.keys()].sort()).toEqual([...PERSONA_SKILLS].sort());
  });
});

describe("reviewed upstream skill bundles", () => {
  it("ships the reviewed files, references and licenses through the same copier used by the agent", () => {
    const repo = new URL("../../../../skills/", import.meta.url);
    const lock = JSON.parse(readFileSync(new URL("upstream-lock.json", repo), "utf8")) as {
      sources: {
        name: string;
        revision: string;
        license: string;
        files: Record<string, { sha256: string }>;
      }[];
    };
    const found = listSkills(repo.pathname, ownedTemp(join(tmpdir(), "ld-skill-lock-")));
    for (const source of lock.sources) {
      expect(source.revision).toMatch(/^[a-f0-9]{40}$/);
      const skill = found.find((item) => item.name === source.name);
      if (!skill) throw new Error(`Missing installed skill: ${source.name}`);
      const files = skillFiles(skill);
      expect(files.map((f) => f.rel).sort()).toEqual(Object.keys(source.files).sort());
      expect(files.find((f) => f.rel === "LICENSE.txt")?.bytes.toString()).toContain(
        "Apache License",
      );
      for (const file of files)
        expect(
          createHash("sha256").update(file.bytes).digest("hex"),
          `${source.name}/${file.rel}`,
        ).toBe(source.files[file.rel]?.sha256);
    }
  });
});
