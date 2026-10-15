import { posix } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import {
  isSkillName,
  type SkillCandidate,
  type SkillProvider,
  type SkillProviderControl,
} from "@deepseek-ai/dsh-skill";
import { FileSystemSkillProvider } from "@deepseek-ai/dsh-skill-filesystem";
import type { FilesInput, SkillSummary, ToolResult } from "@localdot/protocol";

export interface SkillComputer {
  // What the daemon installed in ~/.skills for this task.
  installed: readonly SkillSummary[];
  read(input: FilesInput, signal: AbortSignal): Promise<ToolResult>;
}
const HOME = "/config";
// Where the agent installs the skills it downloads.
const AGENT_ROOTS = ["/config/.agents/skills", "/config/.dsh/skills"];
const ROOTS = [...AGENT_ROOTS, "/config/.skills"];
// dsh-skill-filesystem's rank for custom roots: a duplicate name resolves as it did when ~/.skills
// was scanned after the agent's folders.
const CUSTOM_RANK = 300;
const fsError = (code: string, message: string) => Object.assign(new Error(message), { code });
const inRoots = (path: string) =>
  ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
// A listing stands for its folder, a skill file for its skill's folder.
const folderOf = (key: string) => {
  const path = key.slice(key.indexOf(":") + 1);
  return posix.relative(HOME, key.startsWith("list:") ? path : posix.dirname(path));
};
const forget = (entries: Map<string, unknown> | Set<string>, change: string) => {
  for (const key of [...entries.keys()]) if (change.includes(folderOf(key))) entries.delete(key);
};

function installedCandidate(provider: string, skill: SkillSummary): SkillCandidate | undefined {
  const directory = posix.normalize(skill.path.replace(/^~(?=\/|$)/, HOME));
  if (!isSkillName(skill.name) || !skill.description || !inRoots(directory)) return undefined;
  const path = posix.join(directory, "SKILL.md");
  return {
    name: skill.name,
    description: skill.description,
    invocation: { modelInvocable: true, userInvocable: true },
    source: "custom",
    provider,
    rank: CUSTOM_RANK,
    locator: { path, directory },
    resourceBase: { kind: "directory", path: directory },
    path,
  };
}

/**
 * The catalog is the installed skills, known without a read, and once the agent installs skills of
 * its own, what upstream's discovery/parser finds in its folders. Every read goes through
 * localDot's authorized virtual computer.
 */
export function desktopSkillProvider(
  ctx: Context,
  control: SkillProviderControl,
  computer: SkillComputer,
  signal: AbortSignal,
): SkillProvider & { dispose(): Promise<void>; invalidate(change: string): void } {
  let activeSignal = signal;
  let calls = 0;
  // Listings last one request. Skill files read, and paths found missing, last the task unless a
  // change names their folder: a rescan reads only new skills and probes a missing folder once.
  const reads = new Map<string, ToolResult>();
  const missing = new Set<string>();
  let agentSkills: readonly SkillCandidate[] = [];
  let changes = 0;
  let scanned = 0;
  const resolve = async (path: string) => {
    const normalized = posix.normalize(path.replace(/^~(?=\/|$)/, HOME));
    if (!inRoots(normalized))
      throw fsError("FS_NOT_FOUND", "Skills must be inside the computer's skill directories.");
    return { displayPath: normalized };
  };
  const observe = async (op: "read" | "list", path: string) => {
    activeSignal.throwIfAborted();
    const key = `${op}:${path}`;
    if (missing.has(key)) throw fsError("FS_NOT_FOUND", "Skill path not found.");
    let result = reads.get(key);
    if (!result) {
      if (++calls > 200) throw new Error("Skill discovery exceeded its bounded file inventory.");
      result = await computer.read({ op, path }, activeSignal);
      activeSignal.throwIfAborted();
      if (result.fileError === "not_found") {
        missing.add(key);
        throw fsError("FS_NOT_FOUND", "Skill path not found.");
      }
      if (!result.ok || result.pause || result.final)
        throw new Error("Skill discovery could not read the computer; its catalog is incomplete.");
      reads.set(key, result);
    }
    return result;
  };
  ctx.provide("fs", {
    resolve,
    processPath: (target: { displayPath: string }) => target.displayPath,
    async listDir(target: { displayPath: string }) {
      const observation = (await observe("list", target.displayPath)).fileList;
      if (!observation || observation.truncated) throw new Error("Incomplete skill directory.");
      return observation.entries
        .filter((e) => e.type === "dir" || e.type === "file")
        .map((e) => ({
          name: e.name,
          type: e.type === "dir" ? "directory" : "file",
          target: { displayPath: posix.join(target.displayPath, e.name) },
        }));
    },
    async stat(target: { displayPath: string }) {
      const observation = (await observe("read", target.displayPath)).fileRead;
      if (!observation) throw new Error("Missing structured skill file observation.");
      return { type: "file", size: observation.bytes };
    },
    async readText(target: { displayPath: string }) {
      const observation = (await observe("read", target.displayPath)).fileRead;
      if (!observation || observation.binary || observation.truncated)
        throw fsError("FS_NOT_TEXT", "Skill instructions must be complete text within 64 KiB.");
      return observation.content;
    },
  });
  const provider = new FileSystemSkillProvider(ctx, control, {
    providerName: "localdot-computer",
    includeDefaultRoots: false,
    customSkillDirs: AGENT_ROOTS,
    watch: false,
  });
  const installed = computer.installed.flatMap((skill) => {
    const candidate = installedCandidate(provider.name, skill);
    return candidate ? [candidate] : [];
  });
  const begin = (requestSignal?: AbortSignal) => {
    activeSignal = AbortSignal.any([
      signal,
      control.signal,
      ...(requestSignal ? [requestSignal] : []),
    ]);
    activeSignal.throwIfAborted();
    for (const key of [...reads.keys()]) if (key.startsWith("list:")) reads.delete(key);
    calls = 0;
  };
  return {
    name: provider.name,
    async list(options) {
      begin(options.signal);
      if (scanned !== changes) {
        const at = changes;
        try {
          const fresh = await provider.list(options);
          if (!Array.isArray(fresh) && !fresh.complete)
            return { candidates: [...fresh.candidates, ...installed], complete: false };
          agentSkills = Array.isArray(fresh) ? fresh : fresh.candidates;
          scanned = at;
        } catch {
          activeSignal.throwIfAborted();
          // The last complete scan stays, and the installed skills stay loadable.
          return { candidates: [...agentSkills, ...installed], complete: false };
        }
      }
      return [...agentSkills, ...installed];
    },
    async get(candidate, options) {
      begin(options.signal);
      // Invocation always rereads the chosen body.
      const { path } = candidate.locator as { path: string };
      reads.delete(`read:${path}`);
      missing.delete(`read:${path}`);
      return provider.get(candidate, options);
    },
    invalidate(change) {
      changes += 1;
      forget(reads, change);
      forget(missing, change);
    },
    dispose: () => provider.dispose(),
  };
}

const AGENT_FOLDER = /\.(?:agents|dsh)\/skills\b/;
const WRITES =
  /\b(?:cp|mv|rm|ln|mkdir|rsync|install|touch|tee|tar|unzip|git|curl|wget|sed)\b|[^\d&]>(?!&)/;
const INSTALLER = /\bskills?\s+(?:add|install|remove|update)\b/i;

// The command or written path of a call that may change the agent's skill folders: a skills
// installer, a file written in one, or a command that writes there. Running a skill's own scripts
// changes no catalog.
export function skillChange(name: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  if (name === "files") {
    const path = (args as { path?: unknown }).path;
    return typeof path === "string" && AGENT_FOLDER.test(path) ? path : undefined;
  }
  const command = (args as { command?: unknown }).command;
  if (typeof command !== "string") return undefined;
  return INSTALLER.test(command) || (AGENT_FOLDER.test(command) && WRITES.test(command))
    ? command
    : undefined;
}
