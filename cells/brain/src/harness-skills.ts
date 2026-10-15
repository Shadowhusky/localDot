import { posix } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { SkillProvider, SkillProviderControl } from "@deepseek-ai/dsh-skill";
import { FileSystemSkillProvider } from "@deepseek-ai/dsh-skill-filesystem";
import type { FilesInput, ToolResult } from "@localdot/protocol";

export interface SkillComputer {
  read(input: FilesInput, signal: AbortSignal): Promise<ToolResult>;
}
const ROOTS = ["/config/.agents/skills", "/config/.dsh/skills", "/config/.skills"];
const fsError = (code: string, message: string) => Object.assign(new Error(message), { code });

/** Upstream discovery/parser, backed only by localDot's authorized virtual computer. */
export function desktopSkillProvider(
  ctx: Context,
  control: SkillProviderControl,
  computer: SkillComputer,
  signal: AbortSignal,
): SkillProvider & { dispose(): Promise<void>; invalidate(): void } {
  let catalog: Awaited<ReturnType<SkillProvider["list"]>> | undefined;
  let catalogAt = 0;
  let catalogCwd: string | undefined;
  let activeSignal = signal;
  let calls = 0;
  const reads = new Map<string, ToolResult>();
  const resolve = async (path: string) => {
    const normalized = posix.normalize(path.replace(/^~(?=\/|$)/, "/config"));
    if (!ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`)))
      throw fsError("FS_NOT_FOUND", "Skills must be inside the computer's skill directories.");
    return { displayPath: normalized };
  };
  const observe = async (op: "read" | "list", path: string) => {
    activeSignal.throwIfAborted();
    const key = `${op}:${path}`;
    let result = reads.get(key);
    if (!result) {
      if (++calls > 200) throw new Error("Skill discovery exceeded its bounded file inventory.");
      result = await computer.read({ op, path }, activeSignal);
      activeSignal.throwIfAborted();
      if (result.fileError === "not_found") throw fsError("FS_NOT_FOUND", "Skill path not found.");
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
    customSkillDirs: ROOTS,
    watch: false,
  });
  const begin = (requestSignal?: AbortSignal) => {
    activeSignal = AbortSignal.any([
      signal,
      control.signal,
      ...(requestSignal ? [requestSignal] : []),
    ]);
    activeSignal.throwIfAborted();
    reads.clear();
    calls = 0;
  };
  return {
    name: provider.name,
    async list(options) {
      begin(options.signal);
      // Shell calls invalidate the upstream registry, but ordinary builds do not need to
      // reread every SKILL.md. Explicit skill changes refresh immediately; other changes
      // are discovered within five minutes. Invocation always rereads the chosen body.
      if (catalog && catalogCwd === options.cwd && Date.now() - catalogAt < 300_000) return catalog;
      const fresh = await provider.list(options);
      if (Array.isArray(fresh) || fresh.complete !== false) {
        catalog = fresh;
        catalogCwd = options.cwd;
        catalogAt = Date.now();
      }
      return fresh;
    },
    async get(candidate, options) {
      begin(options.signal);
      return provider.get(candidate, options);
    },
    invalidate: () => {
      catalog = undefined;
    },
    dispose: () => provider.dispose(),
  };
}

// Unknown commands refresh conservatively. Opaque scripts are covered by the bounded catalog
// lifetime; a skill invocation never relies on the catalog's cached instruction body.
export function changesSkills(name: string, args: unknown): boolean {
  if (!args || typeof args !== "object") return true;
  if (name === "files")
    return (
      "path" in args &&
      typeof args.path === "string" &&
      /(?:^|\/)(?:\.agents\/skills|\.dsh\/skills|\.skills)(?:\/|$)/.test(args.path)
    );
  if (!("command" in args) || typeof args.command !== "string") return true;
  return /(?:\.agents\/skills|\.dsh\/skills|\.skills|SKILL\.md|\bskills?\s+(?:add|install|remove|update)|\b(?:cp|mv|rm|git\s+clone)\b.*\bskills\b)/i.test(
    args.command,
  );
}
