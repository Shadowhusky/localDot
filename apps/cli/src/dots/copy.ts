import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import type { CopyCategory } from "../../../../packages/protocol/src/dots.ts";

export type FileCategory = Exclude<CopyCategory, "keys" | "computer" | "signins">;
export const FILE_CATEGORIES: readonly FileCategory[] = [
  "settings",
  "memory",
  "skills",
  "connectors",
  "conversations",
];

// Never copied, whatever is chosen: the dot's identity and sign-in token, its remote-access
// identity, phone notification subscriptions, its ChatGPT sign-in, and the key service's own
// files, audit and spending records. Keys move only key service to key service.
export const NEVER_COPY: readonly string[] = [
  "instance.json",
  "daemon-token",
  "daemon.lock",
  "remote-access.json",
  "remote-links.json",
  "remote-service.json",
  "tailscale-serve.json",
  "notify/subscriptions.json",
  "codex",
  "keyd",
  "audit",
  "safety",
  "cells",
  "install",
  "logs",
  "relay",
  "passphrase-chosen",
];

export const CATEGORY_PATHS: Readonly<Record<FileCategory, readonly string[]>> = {
  settings: ["agent.json", "rules.json", "notify/settings.json"],
  memory: ["memory", "people.json"],
  skills: ["skills"],
  connectors: ["connectors.json", "connector-tools.json"],
  conversations: ["sessions", "user-uploads", "index.sqlite"],
};

export function neverCopied(path: string): boolean {
  const clean = normalize(path);
  return NEVER_COPY.some((never) => clean === never || clean.startsWith(`${never}${sep}`));
}

export class CopyError extends Error {}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

// Copy-on-write clones where the disk has them (APFS), a plain copy elsewhere. Sockets, links and
// anything else that isn't a file or a folder stay behind, as does a folder being deleted.
async function copyTree(source: string, destination: string): Promise<void> {
  const stat = await lstat(source);
  if (stat.isFile()) {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    return;
  }
  if (!stat.isDirectory()) return;
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(source)) {
    if (entry === ".deleting") continue;
    await copyTree(join(source, entry), join(destination, entry));
  }
}

// agent.json without the source's name and its list of other localDots: the new dot has its own.
async function copySettings(source: string, destination: string, name: string): Promise<void> {
  let settings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(join(source, "agent.json"), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    settings = parsed;
  } catch (error) {
    if (!missing(error)) throw new CopyError("The source dot's settings can't be read.");
  }
  const { name: _name, localDots: _links, ...kept } = settings;
  await writeFile(
    join(destination, "agent.json"),
    `${JSON.stringify({ ...kept, name }, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  );
}

// SQLite's backup API, so a database the source dot is writing copies whole. Without memory, the
// notes it indexed stay behind too.
export async function copyIndex(source: string, destination: string, notes: boolean) {
  // Loaded here, so other localdot commands don't print SQLite's experimental-feature warning.
  const { backup, DatabaseSync } = await import("node:sqlite");
  const from = new DatabaseSync(source, { timeout: 5_000 });
  try {
    await backup(from, destination);
  } finally {
    from.close();
  }
  const to = new DatabaseSync(destination);
  try {
    if (!notes) {
      const tables = new Set(
        (to.prepare("SELECT name FROM sqlite_master").all() as { name: string }[]).map(
          (row) => row.name,
        ),
      );
      for (const table of ["docs", "docs_plain", "doc_keys"])
        if (tables.has(table)) to.exec(`DELETE FROM ${table} WHERE kind = 'note'`);
    }
  } finally {
    to.close();
  }
}

export interface CopyPlan {
  source: string;
  destination: string;
  // The new dot's name, which its settings take.
  name: string;
  categories: readonly CopyCategory[];
}

export async function copyFiles(plan: CopyPlan): Promise<FileCategory[]> {
  const chosen = FILE_CATEGORIES.filter((category) => plan.categories.includes(category));
  for (const category of chosen) {
    for (const path of CATEGORY_PATHS[category]) {
      if (neverCopied(path)) throw new CopyError(`${path} is never copied.`);
      const from = join(plan.source, path),
        to = join(plan.destination, path);
      if (path === "agent.json") {
        await copySettings(plan.source, plan.destination, plan.name);
        continue;
      }
      try {
        await lstat(from);
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      if (path === "index.sqlite") {
        await copyIndex(from, to, plan.categories.includes("memory"));
        continue;
      }
      await copyTree(from, to);
    }
  }
  return chosen;
}
