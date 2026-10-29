import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { COPY_CATEGORIES } from "../../../../packages/protocol/src/dots.ts";
import {
  CATEGORY_PATHS,
  CopyError,
  copyFiles,
  copyIndex,
  FILE_CATEGORIES,
  NEVER_COPY,
  neverCopied,
} from "./copy.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "dot-copy-"));
  dirs.push(dir);
  return dir;
};
const put = (root: string, path: string, text = path) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text, { mode: 0o600 });
};

// A home with something in every place a daemon keeps it, private things included.
function sourceHome() {
  const home = folder();
  put(
    home,
    "agent.json",
    JSON.stringify({
      name: "Studio",
      localDots: [{ name: "Office", url: "https://office.example" }],
      persona: "coder",
      taskBudgetUSD: 5,
    }),
  );
  for (const path of [
    "rules.json",
    "notify/settings.json",
    "memory/USER.md",
    "memory/notes/2026-10-01.md",
    "people.json",
    "skills/report/SKILL.md",
    "connectors.json",
    "connector-tools.json",
    "sessions/01JXYZ00000000000000000001/events.jsonl",
    "sessions/.deleting/01JXYZ00000000000000000002/events.jsonl",
    "user-uploads/a.png",
    // Never copied, whatever is chosen:
    "instance.json",
    "daemon-token",
    "daemon.lock",
    "remote-access.json",
    "remote-links.json",
    "remote-service.json",
    "tailscale-serve.json",
    "notify/subscriptions.json",
    "codex/auth.json",
    "keyd/audit.jsonl",
    "keyd/spend.json",
    "keyd/vault.json",
    "safety/fences/x.json",
    "cells/01JXYZ00000000000000000003/cell.json",
    "install/service-owner.json",
    "logs/daemon.log",
    "passphrase-chosen",
  ])
    put(home, path);
  const index = new DatabaseSync(join(home, "index.sqlite"));
  index.exec("PRAGMA journal_mode = WAL");
  index.exec(
    "CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE docs_plain(kind TEXT, session_id TEXT, at TEXT, ref TEXT, text TEXT); CREATE TABLE doc_keys(session_id TEXT, kind TEXT, ref TEXT)",
  );
  index.exec(
    "INSERT INTO sessions VALUES ('01JXYZ00000000000000000001'); INSERT INTO docs_plain VALUES ('user', 's', 'a', 'r', 'hello'), ('note', '', 'd', 'notes/x.md', 'private note'); INSERT INTO doc_keys VALUES ('', 'note', 'notes/x.md')",
  );
  return { home, index };
}

describe("copying a dot's files", () => {
  it("never lists a private path under any category", () => {
    for (const category of FILE_CATEGORIES)
      for (const path of CATEGORY_PATHS[category]) expect(neverCopied(path)).toBe(false);
    expect(FILE_CATEGORIES.every((category) => COPY_CATEGORIES.includes(category))).toBe(true);
    for (const never of NEVER_COPY) {
      expect(neverCopied(never)).toBe(true);
      expect(neverCopied(`${never}${sep}inside`)).toBe(true);
    }
    expect(neverCopied("keydx")).toBe(false);
  });

  it("copies every chosen category and nothing private, whatever is chosen", async () => {
    const { home, index } = sourceHome();
    const destination = folder();
    try {
      const copied = await copyFiles({
        source: home,
        destination,
        name: "Work",
        categories: [...COPY_CATEGORIES],
      });
      expect(copied).toEqual([...FILE_CATEGORIES]);
    } finally {
      index.close();
    }
    for (const path of [
      "rules.json",
      "notify/settings.json",
      "memory/USER.md",
      "memory/notes/2026-10-01.md",
      "people.json",
      "skills/report/SKILL.md",
      "connectors.json",
      "connector-tools.json",
      "sessions/01JXYZ00000000000000000001/events.jsonl",
      "user-uploads/a.png",
      "index.sqlite",
    ])
      expect(existsSync(join(destination, path)), path).toBe(true);
    for (const path of [...NEVER_COPY, "sessions/.deleting"])
      expect(existsSync(join(destination, path)), path).toBe(false);
    expect(JSON.parse(readFileSync(join(destination, "agent.json"), "utf8"))).toEqual({
      persona: "coder",
      taskBudgetUSD: 5,
      name: "Work",
    });
  });

  it("copies only what is chosen, with settings named for the new dot", async () => {
    const { home, index } = sourceHome();
    index.close();
    const destination = folder();
    await copyFiles({ source: home, destination, name: "Work", categories: ["skills"] });
    expect(existsSync(join(destination, "skills/report/SKILL.md"))).toBe(true);
    for (const path of ["agent.json", "memory", "sessions", "index.sqlite", "connectors.json"])
      expect(existsSync(join(destination, path)), path).toBe(false);
  });

  it("refuses settings it can't read rather than copy part of them", async () => {
    const home = folder();
    put(home, "agent.json", "{");
    await expect(
      copyFiles({ source: home, destination: folder(), name: "Work", categories: ["settings"] }),
    ).rejects.toThrow(CopyError);
  });

  it("copies a database the source is writing, whole, and leaves its notes without memory", async () => {
    const { home, index } = sourceHome();
    try {
      index.exec("INSERT INTO sessions VALUES ('01JXYZ00000000000000000009')");
      const destination = join(folder(), "index.sqlite");
      await copyIndex(join(home, "index.sqlite"), destination, false);
      const copy = new DatabaseSync(destination);
      try {
        expect(copy.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 2 });
        expect(copy.prepare("SELECT kind FROM docs_plain").all()).toEqual([{ kind: "user" }]);
        expect(copy.prepare("SELECT count(*) AS n FROM doc_keys").get()).toEqual({ n: 0 });
      } finally {
        copy.close();
      }
      const withNotes = join(folder(), "index.sqlite");
      await copyIndex(join(home, "index.sqlite"), withNotes, true);
      const kept = new DatabaseSync(withNotes);
      try {
        expect(kept.prepare("SELECT count(*) AS n FROM docs_plain").get()).toEqual({ n: 2 });
      } finally {
        kept.close();
      }
    } finally {
      index.close();
    }
  });
});
