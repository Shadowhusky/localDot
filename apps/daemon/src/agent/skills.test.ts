import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { frontMatter, listSkills, skillDesktopPath, skillFiles } from "./skills.ts";

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
