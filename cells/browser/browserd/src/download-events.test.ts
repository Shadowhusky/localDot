import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOWNLOAD_BYTES } from "../../../../packages/protocol/src/quarantine.ts";
import {
  BrowserDownloadEvents,
  type BrowserDownloadEventsDeps,
  DOWNLOAD_RETIRE_MS,
} from "./download-events.ts";
import type { BrowserSpoolFile, DownloadScope } from "./download-spool.ts";

const context = {
  parentCellId: "01J00000000000000000000002",
  browserCellId: "01J00000000000000000000001",
  sessionId: "01J00000000000000000000003",
  browserInstance: "b6adbffb-ad25-4d50-9297-5078b1d2cb4a",
};
const hash = "a".repeat(64);
const scope = () => ({ signal: new AbortController().signal, check() {} });
const fixtures: BrowserDownloadEvents[] = [];
async function flush() {
  for (let i = 0; i < 24; i++) await Promise.resolve();
}

function fixture() {
  const abort = new AbortController();
  const finish = vi.fn();
  const admission = { origin: context, signal: abort.signal, check: vi.fn(), finish };
  const tracked = new Set<string>();
  const deps = {
    admit: vi.fn(() => admission),
    cancel: vi.fn(async (_guid: string) => {}),
    fence: vi.fn(),
    spool: {
      reserve: vi.fn((guid: string) => {
        tracked.add(guid);
      }),
      rejected: vi.fn((guid: string) => {
        tracked.add(guid);
      }),
      completed: vi.fn(async (guid: string, bytes: number, current: DownloadScope) => {
        current.signal.throwIfAborted();
        current.check();
        return Object.freeze({ guid, bytes, sha256: hash });
      }),
      cancelled: vi.fn(),
      remove: vi.fn(async (guid: string) => {
        tracked.delete(guid);
      }),
      close: vi.fn(async () => {}),
      read: vi.fn(async function* (_file: BrowserSpoolFile, current: DownloadScope) {
        current.check();
        yield Buffer.from("abc");
        current.signal.throwIfAborted();
        current.check();
      }),
    },
  } satisfies BrowserDownloadEventsDeps;
  const events = new BrowserDownloadEvents(deps);
  fixtures.push(events);
  const guid = randomUUID();
  const begin = (changes: Record<string, unknown> = {}) =>
    events.begin({
      guid,
      frameId: "frame-1",
      url: "https://files.example.test/private?token=very-secret#other-secret",
      suggestedFilename: "../report.pdf",
      ...changes,
    });
  const progress = (state: string, receivedBytes = 3, changes: Record<string, unknown> = {}) =>
    events.progress({ guid, state, receivedBytes, totalBytes: receivedBytes, ...changes });
  return { abort, finish, admission, deps, events, guid, begin, progress, tracked };
}

afterEach(async () => {
  for (const events of fixtures.splice(0)) {
    events.writersExited();
    await events.close();
  }
  vi.useRealTimers();
});

describe("Chromium download lifetime", () => {
  it("holds exact metadata under its session lease, dropping raw URLs and browser paths", async () => {
    const f = fixture();
    f.begin();
    expect(f.events.list()).toEqual([]);
    f.progress("completed", 3, { filePath: "/profile/private/cookies" });
    await flush();
    expect(f.events.list()).toEqual([
      {
        guid: f.guid,
        bytes: 3,
        sha256: hash,
        origin: { ...context, source: "files.example.test", name: "_report.pdf" },
      },
    ]);
    expect(JSON.stringify(f.events.list())).not.toMatch(/secret|private|profile|cookies/u);
    expect(f.finish).not.toHaveBeenCalled();
    const read = f.events.read(f.guid, scope());
    expect((await read.next()).value).toEqual(Buffer.from("abc"));
    expect((await read.next()).done).toBe(true);
    await f.events.acknowledge(f.guid, { bytes: 3, sha256: hash }, scope());
    expect(f.finish).toHaveBeenCalledOnce();
    expect(f.events.list()).toEqual([]);
    expect(f.deps.cancel).not.toHaveBeenCalled();
  });

  it("attributes a blob download to its embedded origin without retaining the blob identifier", async () => {
    const f = fixture();
    f.begin({ url: "blob:https://files.example.test/private-id", suggestedFilename: "下载.txt" });
    f.progress("completed");
    await flush();
    expect(f.events.list()[0]?.origin).toEqual({
      ...context,
      source: "files.example.test",
      name: "下载.txt",
    });
  });

  it("an authority revocation waits for the terminal event after cancelDownload replies", async () => {
    const f = fixture();
    f.begin();
    f.abort.abort();
    await flush();
    expect(f.deps.cancel).toHaveBeenCalledWith(f.guid);
    expect(f.finish).not.toHaveBeenCalled();
    expect(f.deps.spool.remove).not.toHaveBeenCalled();
    f.progress("canceled", 2);
    await flush();
    expect(f.deps.spool.cancelled).toHaveBeenCalledWith(f.guid);
    expect(f.deps.spool.remove).toHaveBeenCalledWith(f.guid);
    expect(f.finish).toHaveBeenCalledOnce();
  });

  it("a completed event racing cancellation cannot expose or retain the rejected bytes", async () => {
    const f = fixture();
    const reply = Promise.withResolvers<void>();
    f.deps.cancel.mockImplementation(() => reply.promise);
    f.begin();
    f.abort.abort();
    f.progress("completed");
    await flush();
    expect(f.deps.spool.completed).not.toHaveBeenCalled();
    expect(f.finish).not.toHaveBeenCalled();
    reply.resolve();
    await flush();
    expect(f.events.list()).toEqual([]);
    expect(f.deps.spool.remove).toHaveBeenCalledOnce();
    expect(f.finish).toHaveBeenCalledOnce();
  });

  it("timeout requests containment but keeps authority until verified writer exit", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.begin();
    f.abort.abort();
    await flush();
    await vi.advanceTimersByTimeAsync(DOWNLOAD_RETIRE_MS);
    expect(f.deps.fence).toHaveBeenCalledOnce();
    expect(f.finish).not.toHaveBeenCalled();
    expect(f.deps.spool.remove).not.toHaveBeenCalled();
    f.events.writersExited();
    await flush();
    expect(f.finish).toHaveBeenCalledOnce();
    expect(f.deps.spool.remove).toHaveBeenCalledOnce();
  });

  it("a failed cancel request cannot release the lease before containment finishes", async () => {
    const f = fixture();
    f.deps.cancel.mockRejectedValue(new Error("private response"));
    f.begin();
    f.abort.abort();
    await flush();
    expect(f.deps.fence).toHaveBeenCalledOnce();
    expect(f.finish).not.toHaveBeenCalled();
    f.events.writersExited();
    await flush();
    expect(f.finish).toHaveBeenCalledOnce();
  });

  it("rejects over-limit totals before capture and drains their GUID", async () => {
    const f = fixture();
    f.begin();
    f.progress("inProgress", 1, { totalBytes: DOWNLOAD_BYTES + 1 });
    await flush();
    expect(f.deps.cancel).toHaveBeenCalledOnce();
    expect(f.deps.spool.completed).not.toHaveBeenCalled();
    expect(f.finish).not.toHaveBeenCalled();
    f.progress("canceled", 1);
    await flush();
    expect(f.finish).toHaveBeenCalledOnce();
  });

  it("a refused concurrent download still has a bounded cancellation owner", async () => {
    const f = fixture();
    f.deps.spool.reserve.mockImplementation(() => {
      throw new Error("full");
    });
    f.begin();
    await flush();
    expect(f.deps.spool.rejected).toHaveBeenCalledWith(f.guid);
    expect(f.events.owns(f.guid)).toBe(true);
    expect(f.finish).not.toHaveBeenCalled();
    f.progress("completed");
    await flush();
    expect(f.deps.spool.completed).not.toHaveBeenCalled();
    expect(f.deps.spool.remove).toHaveBeenCalledWith(f.guid);
    expect(f.finish).toHaveBeenCalledOnce();
  });

  it.each([
    "file:///profile/private",
    "data:text/plain,secret",
    "https://user:secret@files.example.test/a",
  ])("cancels unsupported/private source %s without releasing authority early", async (url) => {
    const f = fixture();
    f.begin({ url });
    await flush();
    expect(f.events.list()).toEqual([]);
    expect(f.deps.spool.reserve).not.toHaveBeenCalled();
    expect(f.finish).not.toHaveBeenCalled();
    f.progress("canceled", 0);
    await flush();
    expect(f.finish).toHaveBeenCalledOnce();
  });

  it("missing session authority is cancelled without ever offering bytes", async () => {
    const f = fixture();
    f.deps.admit.mockImplementation(() => {
      throw new Error("no session");
    });
    f.begin();
    f.progress("completed");
    await flush();
    expect(f.events.list()).toEqual([]);
    expect(f.deps.spool.completed).not.toHaveBeenCalled();
    expect(f.finish).not.toHaveBeenCalled();
  });

  it("capture failing identity/hash validation never becomes a ready offer", async () => {
    const f = fixture();
    f.deps.spool.completed.mockRejectedValue(new Error("file changed"));
    f.begin();
    f.progress("completed");
    await flush();
    expect(f.events.list()).toEqual([]);
    expect(f.deps.spool.remove).toHaveBeenCalledOnce();
    expect(f.finish).toHaveBeenCalledOnce();
  });

  it("wrong byte/digest acknowledgements cannot delete or retire the file", async () => {
    const f = fixture();
    f.begin();
    f.progress("completed");
    await flush();
    for (const receipt of [
      { bytes: 4, sha256: hash },
      { bytes: 3, sha256: "b".repeat(64) },
    ])
      await expect(f.events.acknowledge(f.guid, receipt, scope())).rejects.toThrow("stale");
    expect(f.deps.spool.remove).not.toHaveBeenCalled();
    expect(f.finish).not.toHaveBeenCalled();
  });

  it("returning an unread stream does not strand the file's reader slot", async () => {
    const f = fixture();
    f.begin();
    f.progress("completed");
    await flush();
    await f.events.read(f.guid, scope()).return(undefined);
    const retry = f.events.read(f.guid, scope());
    expect((await retry.next()).value).toEqual(Buffer.from("abc"));
    await retry.return(undefined);
  });

  it("takeover closes an active reader before deleting bytes or finishing its action lease", async () => {
    const f = fixture();
    f.begin();
    f.progress("completed");
    await flush();
    const physicallyClosed = Promise.withResolvers<void>();
    f.deps.spool.read.mockImplementation(async function* () {
      try {
        yield Buffer.from("abc");
      } finally {
        await physicallyClosed.promise;
      }
    });
    const reader = f.events.read(f.guid, scope());
    await reader.next();
    f.abort.abort();
    await flush();
    expect(f.deps.spool.remove).not.toHaveBeenCalled();
    expect(f.finish).not.toHaveBeenCalled();
    physicallyClosed.resolve();
    await flush();
    expect(f.deps.spool.remove).toHaveBeenCalledOnce();
    expect(f.finish).toHaveBeenCalledOnce();
  });

  it("a source cleanup failure holds the lease until browser process containment", async () => {
    const f = fixture();
    f.deps.spool.remove.mockRejectedValue(new Error("directory replaced"));
    f.begin();
    f.progress("completed");
    await flush();
    const acknowledgement = f.events.acknowledge(f.guid, { bytes: 3, sha256: hash }, scope());
    await flush();
    expect(f.deps.fence).toHaveBeenCalledOnce();
    expect(f.finish).not.toHaveBeenCalled();
    f.events.writersExited();
    await acknowledgement;
    expect(f.finish).toHaveBeenCalledOnce();
  });

  it("invalid/unknown/repeated GUID events trigger one containment request", async () => {
    const f = fixture();
    f.begin();
    f.begin();
    f.events.progress({ guid: randomUUID(), state: "completed", receivedBytes: 3 });
    expect(f.deps.fence).toHaveBeenCalledOnce();
    expect(f.finish).not.toHaveBeenCalled();
  });

  it("duplicate terminal progress after retirement cannot create a second offer or action lease", async () => {
    const f = fixture();
    f.begin();
    f.progress("completed");
    await flush();
    await f.events.acknowledge(f.guid, { bytes: 3, sha256: hash }, scope());
    f.progress("completed");
    expect(f.events.list()).toEqual([]);
    expect(f.deps.admit).toHaveBeenCalledOnce();
    expect(f.deps.fence).not.toHaveBeenCalled();
  });

  it("a reentrant containment callback cannot attach a fresh timer to a retired GUID", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.deps.spool.reserve.mockImplementation(() => {
      throw new Error("full");
    });
    f.deps.spool.rejected.mockImplementation(() => {
      throw new Error("corrupt");
    });
    f.deps.fence.mockImplementation(() => f.events.writersExited());
    f.begin();
    await flush();
    await f.events.close();
    expect(f.finish).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
