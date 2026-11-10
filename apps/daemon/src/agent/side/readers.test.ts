import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAREFUL_AUTONOMY, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoredFiles } from "../../deliverables/stored.ts";
import { EventLog } from "../../event-log.ts";
import { FrameStore } from "../../gateway/frames.ts";
import { redactor } from "../redact.ts";
import { AgentSession } from "../session.ts";
import type { AgentSettings } from "../settings.ts";
import { type SideReaderDeps, sideReaders } from "./readers.ts";

const homes: string[] = [];
const logs: EventLog[] = [];
afterEach(() => {
  for (const log of logs.splice(0)) log.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const CELL = ulid();

function setup(settings: AgentSettings = {}) {
  const home = mkdtempSync(join(tmpdir(), "ld-side-readers-"));
  homes.push(home);
  const log = new EventLog(home);
  logs.push(log);
  const id = log.createSession("task");
  const frames = new FrameStore(home);
  const observe = vi.fn();
  const deps: SideReaderDeps = {
    frames,
    png: { png: vi.fn(async () => Buffer.from("png")) },
    desktop: vi.fn(() => undefined),
    device: vi.fn(() => ({ client: { observe } as never })),
    owners: vi.fn(() => ({ foreign: () => false, known: () => true })),
    holder: vi.fn(() => undefined),
    scale: vi.fn(() => 1),
    cellOf: vi.fn(() => undefined),
    scanner: { scan: vi.fn(async () => undefined) },
    stored: new StoredFiles(home),
    chain: vi.fn((sessionId: string) => [sessionId]),
    settings: () => settings,
    redactor: () => redactor([]),
    now: () => Date.now(),
  };
  return { home, log, id, frames, deps, observe, file: log.logFile(id) };
}
const live = (f: ReturnType<typeof setup>, autonomy = CAREFUL_AUTONOMY) =>
  new AgentSession(f.id, CELL, "Task", f.log, autonomy);

describe("what a side question may read, by the user's own settings", () => {
  it("lets a live task read under its settings, with no card to wait on", () => {
    const f = setup();
    const readers = sideReaders(f.deps, f.id, live(f), f.file);
    expect(readers.permitted?.("files", { op: "read", path: "a.txt" })).toBe(true);
    expect(readers.permitted?.("recall", { query: "x" })).toBe(true);
    expect(readers.permitted?.("computer", { action: "screenshot" })).toBe(true);
    expect(readers.permitted?.("web_fetch", { url: "https://example.org/" })).toBe(true);
    expect(readers.permitted?.("web_search", { query: "x" })).toBe(true);
  });

  it("refuses what the user set to ask about, having no one to ask", () => {
    const f = setup();
    const strict = {
      ...CAREFUL_AUTONOMY,
      reading: "ask",
      browsing: "ask",
    } as typeof CAREFUL_AUTONOMY;
    const readers = sideReaders(f.deps, f.id, live(f, strict), f.file);
    expect(readers.permitted?.("files", { op: "read", path: "a.txt" })).toBe(false);
    expect(readers.permitted?.("web_fetch", { url: "https://example.org/" })).toBe(false);
  });

  it("follows the same settings for a task that has ended", () => {
    const f = setup();
    const ended = sideReaders(f.deps, f.id, undefined, f.file);
    expect(ended.permitted?.("files", { op: "read", path: "a.txt" })).toBe(true);
    const g = setup({
      permissionMode: "custom",
      autonomy: { ...CAREFUL_AUTONOMY, reading: "ask" } as typeof CAREFUL_AUTONOMY,
    });
    const strict = sideReaders(g.deps, g.id, undefined, g.file);
    expect(strict.permitted?.("files", { op: "read", path: "a.txt" })).toBe(false);
  });

  it("offers a new look only for a live task, never one that has ended", () => {
    const f = setup();
    f.deps.cellOf = () => CELL;
    expect(sideReaders(f.deps, f.id, undefined, f.file).freshScreen).toBeUndefined();
    expect(sideReaders(f.deps, f.id, live(f), f.file).freshScreen).toBeDefined();
  });

  it("takes no new look while the user has the computer or the task is on the web browser", async () => {
    const f = setup();
    const session = live(f);
    Object.defineProperty(session, "controlHeld", { value: true });
    const readers = sideReaders(f.deps, f.id, session, f.file);
    await expect(
      readers.freshScreen?.(60_000, new AbortController().signal),
    ).resolves.toBeUndefined();
    const browser = live(f);
    Object.defineProperty(browser, "screens", {
      value: { selection: { screen: "browser" } },
    });
    await expect(
      sideReaders(f.deps, f.id, browser, f.file).freshScreen?.(
        60_000,
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
    expect(f.observe).not.toHaveBeenCalled();
  });

  it("reads only the frame store for an old look, and says how old it is", async () => {
    const f = setup();
    const frameId = ulid();
    const when = Date.now();
    f.deps.now = () => when + 5000;
    f.frames.save(f.id, frameId, Buffer.from("webp"));
    const readers = sideReaders(f.deps, f.id, undefined, f.file);
    const look = await readers.frame?.(frameId, undefined, new AbortController().signal);
    expect(look?.png.toString()).toBe("png");
    expect(look?.ageMs).toBeGreaterThan(4000);
    await expect(
      readers.frame?.(ulid(), undefined, new AbortController().signal),
    ).resolves.toBeUndefined();
  });

  it("reads the start of a handed-over text file, and not a binary one", () => {
    const f = setup();
    const out = join(f.home, "sessions", f.id, "out");
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(out, { recursive: true, mode: 0o700 });
    writeFileSync(join(out, "plan.md"), "The plan's text".repeat(10), { mode: 0o600 });
    writeFileSync(join(out, "a.bin"), Buffer.from([0, 1, 2, 3, 0, 0]), { mode: 0o600 });
    const readers = sideReaders(f.deps, f.id, undefined, f.file);
    expect(readers.handedFile?.(f.id, "plan.md", 15)).toBe("The plan's text");
    expect(readers.handedFile?.(f.id, "a.bin", 100)).toBeUndefined();
    expect(readers.handedFile?.(f.id, "../../evil", 100)).toBeUndefined();
  });
});
