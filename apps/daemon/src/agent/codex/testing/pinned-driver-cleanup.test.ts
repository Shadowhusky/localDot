import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PinnedFixture } from "../../../../../../harness/codex/src/testing/pinned-fixture.ts";
import { EventLog } from "../../../event-log.ts";
import { pinnedDriver } from "./pinned-driver.ts";

const mock = vi.hoisted(() => ({ close: vi.fn(async () => {}), acquired: vi.fn() }));
vi.mock("./openai-mock.ts", () => ({
  fakeAuthJson: () => '{"inert":true}',
  startOpenAiMock: async () => {
    mock.acquired();
    return {
      close: mock.close,
      errors: [],
      requests: [],
      responses: [],
      base: "http://127.0.0.1:1",
    };
  },
}));

// Only owner handles are fake. Real disposable journals expose artifact/setup errors; this
// suite independently drains journals after injected close failures. It launches no process.
const roots: string[] = [];
const journals = new Set<EventLog>();
const createSession = EventLog.prototype.createSession;
const closeJournal = EventLog.prototype.close;
beforeEach(() => {
  vi.stubEnv("LOCALDOT_CODEX_PROBE_OUTPUT", undefined);
  mock.close.mockReset().mockResolvedValue(undefined);
  mock.acquired.mockClear();
  vi.spyOn(EventLog.prototype, "createSession").mockImplementation(function (
    this: EventLog,
    ...args
  ) {
    journals.add(this);
    return createSession.apply(this, args);
  });
  vi.spyOn(EventLog.prototype, "close").mockImplementation(function (this: EventLog) {
    closeJournal.call(this);
    journals.delete(this);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const journal of journals) closeJournal.call(journal);
  journals.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync("/tmp/ld13-cleanup-unit-");
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const close = vi.fn(async (_options?: { readonly retain?: boolean }) => {});
  const value = {
    root,
    roots: { home },
    close,
    signal: new AbortController().signal,
  } as unknown as PinnedFixture;
  return { root, home, close, value };
}

describe("offline driver ownership on setup and cleanup failure", () => {
  it("returns one successful retirement promise and closes every owner once", async () => {
    const f = fixture(),
      h = await pinnedDriver(f.value);
    const first = h.close(),
      second = h.close();
    expect(second).toBe(first);
    await first;
    expect(h.close()).toBe(first);
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ retain: false });
    expect(mock.close).toHaveBeenCalledOnce();
    expect(journals.size).toBe(0);
  });
  it("drains all owners after a wire write fails and retains private evidence", async () => {
    const f = fixture(),
      h = await pinnedDriver(f.value);
    const output = join(f.root, "wire");
    vi.stubEnv("LOCALDOT_CODEX_PROBE_OUTPUT", output);
    mkdirSync(join(output, `${h.session.id}.json`), { recursive: true });
    await expect(h.close()).rejects.toThrow(AggregateError);
    expect(mock.close).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ retain: true });
    expect(journals.size).toBe(0);
    expect(existsSync(join(output, `${h.session.id}.json`))).toBe(true);
  });
  it("keeps a rejected retirement observable to concurrent and later callers", async () => {
    const f = fixture(),
      h = await pinnedDriver(f.value);
    const fault = new Error("inert mock retirement uncertain");
    mock.close.mockRejectedValueOnce(fault);
    const first = h.close();
    expect(h.close()).toBe(first);
    const error = await first.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toContain(fault);
    expect(h.close()).toBe(first);
    await expect(h.close()).rejects.toBe(error);
    expect(mock.close).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ retain: true });
  });
  it("attempts process retirement even when journal and listener retirement both fail", async () => {
    const f = fixture(),
      h = await pinnedDriver(f.value);
    const journalFault = new Error("inert journal retirement uncertain");
    const listenerFault = new Error("inert listener retirement uncertain");
    const processFault = new Error("inert process retirement uncertain");
    vi.spyOn(EventLog.prototype, "close").mockImplementation(() => {
      throw journalFault;
    });
    mock.close.mockRejectedValueOnce(listenerFault);
    f.close.mockRejectedValueOnce(processFault);
    const error = await h.close().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([journalFault, listenerFault, processFault]);
    expect(mock.close).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ retain: true });
  });
  it("unwinds acquired owners when fake auth preparation fails before a handle is returned", async () => {
    const f = fixture();
    mkdirSync(join(f.home, "auth.json"));
    await expect(pinnedDriver(f.value)).rejects.toThrow(AggregateError);
    expect(mock.acquired).toHaveBeenCalledOnce();
    expect(mock.close).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ retain: true });
    expect(journals.size).toBe(0);
  });
  it("preserves the setup cause and subsequent retirement failures", async () => {
    const f = fixture();
    mkdirSync(join(f.home, "auth.json"));
    const journalFault = new Error("inert setup journal retirement uncertain");
    const listenerFault = new Error("inert setup listener retirement uncertain");
    const processFault = new Error("inert setup process retirement uncertain");
    vi.spyOn(EventLog.prototype, "close").mockImplementation(() => {
      throw journalFault;
    });
    mock.close.mockRejectedValueOnce(listenerFault);
    f.close.mockRejectedValueOnce(processFault);
    const error = await pinnedDriver(f.value).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toMatchObject({ code: "EISDIR" });
    expect((error as AggregateError).errors.slice(1)).toEqual([
      journalFault,
      listenerFault,
      processFault,
    ]);
    expect(mock.close).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ retain: true });
  });
});
