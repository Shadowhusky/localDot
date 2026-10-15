import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join, relative } from "node:path";
import { PERSONA_SKILLS, type PersonaId, personaOf } from "@localdot/protocol";
export interface SkillInfo {
  name: string;
  description: string;
  dir: string;
  source: "builtin" | "user";
}
export interface SkillFile {
  rel: string;
  bytes: Buffer;
  mode: number;
}
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_FILES = 200,
  MAX_BYTES = 10 * 1024 * 1024,
  MAX_DIRS = 1000,
  MAX_DEPTH = 32;
function entries(dir: string): string[] {
  const names: string[] = [];
  const handle = opendirSync(dir);
  try {
    for (let e = handle.readSync(); e; e = handle.readSync()) {
      if (names.length >= MAX_DIRS) throw new Error("too many entries in skill directory");
      names.push(e.name);
    }
  } finally {
    handle.closeSync();
  }
  return names.sort();
}
function regular(path: string, max: number): { bytes: Buffer; mode: number } {
  const before = lstatSync(path);
  if (!before.isFile()) throw new Error("skill file must be regular");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino)
      throw new Error("skill file changed");
    if (st.size > max) throw new Error("skill is larger than its byte limit");
    const parts: Buffer[] = [];
    let total = 0;
    while (total <= max) {
      const b = Buffer.allocUnsafe(Math.min(64 * 1024, max + 1 - total));
      const n = readSync(fd, b, 0, b.length, null);
      if (!n) break;
      total += n;
      if (total > max) throw new Error("skill is larger than its byte limit");
      parts.push(b.subarray(0, n));
    }
    return { bytes: Buffer.concat(parts, total), mode: st.mode & 0o111 ? 0o755 : 0o644 };
  } finally {
    closeSync(fd);
  }
}
export function frontMatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const out: Record<string, string> = Object.create(null);
  if (!match) return out;
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const key = pair[1] as string;
    if (Object.hasOwn(out, key)) return {};
    let value = (pair[2] ?? "").trim();
    if (/^("|').*\1$/.test(value)) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}
export function listSkills(builtinDir: string | undefined, userDir: string): SkillInfo[] {
  const byName = new Map<string, SkillInfo>();
  for (const [root, source] of [
    [builtinDir, "builtin"],
    [userDir, "user"],
  ] as const) {
    if (!root) continue;
    const st = lstatSync(root, { throwIfNoEntry: false });
    if (!st?.isDirectory()) continue;
    const canonical = realpathSync(root);
    for (const entry of entries(canonical)) {
      const dir = join(canonical, entry);
      if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
      let meta: Record<string, string>;
      try {
        meta = frontMatter(
          new TextDecoder("utf-8", { fatal: true }).decode(
            regular(join(dir, "SKILL.md"), 128 * 1024).bytes,
          ),
        );
      } catch {
        continue;
      }
      const name = meta.name ?? "";
      const description = meta.description?.trim() ?? "";
      if (!NAME.test(name) || !description || description.length > 1024) continue;
      byName.set(name, { name, description, dir, source });
    }
  }
  if (byName.size > 100) throw new Error("at most 100 skills may be loaded");
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function skillFiles(skill: SkillInfo): SkillFile[] {
  if (!NAME.test(skill.name) || !lstatSync(skill.dir).isDirectory())
    throw new Error("invalid skill directory");
  const root = realpathSync(skill.dir);
  const files: SkillFile[] = [];
  let total = 0,
    dirs = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || ++dirs > MAX_DIRS)
      throw new Error("skill directory tree is too large");
    if (!lstatSync(dir).isDirectory()) throw new Error("skill directory changed");
    for (const entry of entries(dir)) {
      const path = join(dir, entry);
      const st = lstatSync(path);
      if (st.isDirectory()) walk(path, depth + 1);
      else if (st.isFile()) {
        if (files.length >= MAX_FILES)
          throw new Error(`skill ${skill.name} is larger than ${MAX_FILES} files`);
        // The root and every traversed directory are checked without following links. This does
        // not promise openat confinement against concurrent hostile ancestor replacement.
        let parent = dir;
        while (parent !== root) {
          if (!lstatSync(parent).isDirectory()) throw new Error("skill directory changed");
          parent = join(parent, "..");
        }
        if (!lstatSync(root).isDirectory()) throw new Error("skill root changed");
        const data = regular(path, MAX_BYTES - total);
        total += data.bytes.length;
        files.push({ rel: relative(root, path), ...data });
      }
    }
  };
  walk(root, 0);
  return files;
}
export function skillDesktopPath(name: string): string {
  if (!NAME.test(name)) throw new Error("invalid skill name");
  return `~/.skills/${name}`;
}

// A dot carries its own built-in skills and every skill the user added.
export function skillsFor(persona: PersonaId | undefined, all: readonly SkillInfo[]): SkillInfo[] {
  const own = new Set(personaOf(persona).skills);
  return all.filter((skill) => skill.source === "user" || own.has(skill.name));
}

// The built-in skills an earlier task's dot left in the computer; anything else there is the
// user's or one dot installed, and stays.
export function leftoverSkills(present: readonly string[], kept: readonly SkillInfo[]): string[] {
  const keep = new Set(kept.map((skill) => skill.name));
  return present.filter((name) => PERSONA_SKILLS.includes(name) && !keep.has(name));
}
