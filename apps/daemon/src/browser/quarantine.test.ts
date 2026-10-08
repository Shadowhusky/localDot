import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PlacementReceipt,
  PlacementRequest,
  QuarantineItem,
} from "../../../../packages/protocol/src/quarantine.ts";
import { Transfers } from "../agent/transfers.ts";
import { type PlaceDownload, QuarantineStore } from "./quarantine.ts";

const homes: string[] = [];
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
async function fixture(limits: Parameters<typeof QuarantineStore.open>[1] = {}) {
  const home = await mkdtemp(join(tmpdir(), "localdot-quarantine-"));
  homes.push(home);
  const parent = ulid(),
    browser = ulid();
  const origin = {
    parentCellId: parent,
    browserCellId: browser,
    browserInstance: randomUUID(),
    sessionId: ulid(),
    name: "report.txt",
    source: "downloads.example.test",
  };
  const abort = new AbortController();
  const transfers = new Transfers();
  const scope = transfers.acquire(parent, [abort.signal], () => {});
  const store = await QuarantineStore.open(home, limits);
  const add = (value = "approved bytes", extra = {}) =>
    store.ingest({ ...origin, ...extra }, Readable.from([Buffer.from(value)]), scope);
  return { home, parent, origin, abort, transfers, scope, store, add };
}
function release(item: QuarantineItem) {
  return {
    revision: item.revision,
    bytes: item.bytes,
    sha256: item.sha256,
    name: item.name,
    to: "computer",
  };
}
function destination() {
  const files = new Map<string, Buffer>();
  const receipts = new Map<string, PlacementReceipt>();
  const place = vi.fn<PlaceDownload>(async (request, chunks, scope, options) => {
    scope.check();
    const prior = receipts.get(request.transferId);
    if (prior) return prior;
    if (options.reconcileOnly) throw new Error("placement evidence missing");
    const data: Buffer[] = [];
    for await (const chunk of chunks) {
      scope.check();
      data.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(data);
    if (bytes.length !== request.bytes || sha(bytes) !== request.sha256)
      throw new Error("digest mismatch before placement");
    scope.check();
    const receipt = { ...request, path: `~/Downloads/${request.name}` };
    files.set(request.transferId, bytes);
    receipts.set(request.transferId, receipt);
    return receipt;
  });
  return { files, receipts, place };
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("browser download ingestion", () => {
  async function browserFixture(options: Parameters<typeof QuarantineStore.open>[1] = {}) {
    const f = await fixture(options);
    const value = Buffer.from("a completed browser download");
    const offer = { guid: randomUUID(), bytes: value.length, sha256: sha(value), origin: f.origin };
    const open = vi.fn(async () => Readable.from([value]));
    return { ...f, value, offer, open };
  }

  it("reuses the same durable item after a lost acknowledgement and host restart", async () => {
    const f = await browserFixture();
    const first = await f.store.ingestBrowser(f.offer, f.open, f.scope);
    expect(first.browserDownloadGuid).toBe(f.offer.guid);
    const restarted = await QuarantineStore.open(f.home);
    expect(await restarted.ingestBrowser(f.offer, f.open, f.scope)).toEqual(first);
    expect(f.open).toHaveBeenCalledOnce();
    expect(restarted.list(f.parent)).toEqual([first]);
    f.scope.release();
  });

  it.each(["sha256", "bytes", "parentCellId", "sessionId", "source", "name"])(
    "refuses a retry whose %s changed without opening a second transport",
    async (field) => {
      const f = await browserFixture();
      await f.store.ingestBrowser(f.offer, f.open, f.scope);
      const offer = structuredClone(f.offer);
      if (field === "sha256") offer.sha256 = sha("different");
      else if (field === "bytes") offer.bytes++;
      else if (field === "parentCellId" || field === "sessionId") offer.origin[field] = ulid();
      else if (field === "source") offer.origin.source = "changed.example.test";
      else offer.origin.name = "changed.txt";
      await expect(f.store.ingestBrowser(offer, f.open, f.scope)).rejects.toThrow("corrupt");
      expect(f.open).toHaveBeenCalledOnce();
      f.scope.release();
    },
  );

  it.each(["short", "long", "digest"])("publishes no item on a %s mismatch", async (kind) => {
    const f = await browserFixture();
    const value =
      kind === "short"
        ? f.value.subarray(1)
        : kind === "long"
          ? Buffer.concat([f.value, Buffer.from("x")])
          : Buffer.alloc(f.value.length);
    await expect(
      f.store.ingestBrowser(f.offer, async () => Readable.from([value]), f.scope),
    ).rejects.toThrow("corrupt");
    expect(f.store.list(f.parent)).toEqual([]);
    expect(await readdir(join(f.home, "quarantine"))).toEqual([]);
    expect((await f.store.ingestBrowser(f.offer, f.open, f.scope)).state).toBe("held");
    f.scope.release();
  });

  it("serializes the same GUID before awaiting a lazy transport", async () => {
    const f = await browserFixture();
    let opened!: (stream: Readable) => void;
    const source = new Promise<Readable>((resolve) => {
      opened = resolve;
    });
    const work = f.store.ingestBrowser(f.offer, () => source, f.scope);
    await expect(f.store.ingestBrowser(f.offer, f.open, f.scope)).rejects.toThrow("busy");
    expect(f.open).not.toHaveBeenCalled();
    opened(Readable.from([f.value]));
    await work;
    expect(f.store.list(f.parent)).toHaveLength(1);
    f.scope.release();
  });

  it("reserves capacity before opening any browser transport", async () => {
    const f = await browserFixture({ limits: { file: 32, total: 32 } });
    await f.add("occupy capacity");
    await expect(f.store.ingestBrowser(f.offer, f.open, f.scope)).rejects.toThrow("capacity");
    expect(f.open).not.toHaveBeenCalled();
    f.scope.release();
  });

  it("refuses acknowledgement when a stored duplicate's payload has been corrupted", async () => {
    const f = await browserFixture();
    const item = await f.store.ingestBrowser(f.offer, f.open, f.scope);
    await writeFile(join(f.home, "quarantine", item.id, "payload"), Buffer.alloc(item.bytes));
    await expect(f.store.ingestBrowser(f.offer, f.open, f.scope)).rejects.toThrow("corrupt");
    expect(f.open).toHaveBeenCalledOnce();
    f.scope.release();
  });

  it.each(["released", "discarded"] as const)(
    "never resurrects a %s download on retry",
    async (state) => {
      const f = await browserFixture();
      const item = await f.store.ingestBrowser(f.offer, f.open, f.scope);
      const terminal =
        state === "released"
          ? await f.store.release(f.parent, item.id, release(item), f.scope, destination().place)
          : await f.store.discard(f.parent, item.id, item.revision, f.scope);
      const restarted = await QuarantineStore.open(f.home);
      expect(await restarted.ingestBrowser(f.offer, f.open, f.scope)).toEqual(terminal);
      expect(f.open).toHaveBeenCalledOnce();
      expect(await readdir(join(f.home, "quarantine", item.id))).toEqual(["item.json"]);
      f.scope.release();
    },
  );

  it("keeps GUIDs distinct across browser process instances", async () => {
    const f = await browserFixture();
    const first = await f.store.ingestBrowser(f.offer, f.open, f.scope);
    const offer = { ...f.offer, origin: { ...f.origin, browserInstance: randomUUID() } };
    const second = await f.store.ingestBrowser(offer, f.open, f.scope);
    expect(first.id).not.toBe(second.id);
    expect(f.open).toHaveBeenCalledTimes(2);
    f.scope.release();
  });

  it("refuses conflicting duplicate GUID records during recovery", async () => {
    const f = await browserFixture();
    const first = await f.store.ingestBrowser(f.offer, f.open, f.scope);
    const second = await f.store.ingestBrowser({ ...f.offer, guid: randomUUID() }, f.open, f.scope);
    const path = join(f.home, "quarantine", second.id, "item.json");
    await writeFile(
      path,
      JSON.stringify({ ...second, browserDownloadGuid: first.browserDownloadGuid }),
    );
    await expect(QuarantineStore.open(f.home)).rejects.toThrow("corrupt");
    f.scope.release();
  });

  it("drains an already supplied stream even if preflight refuses it", async () => {
    const f = await fixture();
    let finishDestroy!: (error?: Error | null) => void;
    const source = new Readable({
      read() {},
      destroy(_error, done) {
        finishDestroy = done;
      },
    });
    let settled = false;
    const work = f.store
      .ingest({}, source, f.scope)
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    finishDestroy();
    expect(await work).toBeInstanceOf(Error);
    f.scope.release();
  });
});

describe("host download quarantine", () => {
  it("keeps reserved-name normalization within the UTF-8 filename bound", async () => {
    const f = await fixture();
    const item = await f.add("one", { name: `CON.${"x".repeat(176)}` });
    expect(item.name.startsWith("_CON.")).toBe(true);
    expect(Buffer.byteLength(item.name)).toBe(180);
    const target = destination();
    expect(
      (await f.store.release(f.parent, item.id, release(item), f.scope, target.place)).state,
    ).toBe("released");
    f.scope.release();
  });
  it("holds exact bytes privately with immutable owner metadata before any desktop placement", async () => {
    const f = await fixture();
    const item = await f.add("你好 world", {
      name: "../../a\u202e.sh",
      source: "downloads.example.test",
    });
    expect(item).toMatchObject({
      ...f.origin,
      name: "_.._a_.sh",
      state: "held",
      revision: 1,
      bytes: Buffer.byteLength("你好 world"),
      sha256: sha("你好 world"),
      kind: "program",
    });
    expect((await lstat(join(f.home, "quarantine"))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(f.home, "quarantine", item.id))).mode & 0o777).toBe(0o700);
    for (const name of ["payload", "item.json"])
      expect((await lstat(join(f.home, "quarantine", item.id, name))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(f.home, "quarantine", item.id, "payload"), "utf8")).toBe(
      "你好 world",
    );
    expect(f.store.list(f.parent)).toEqual([item]);
    item.name = "mutated.txt";
    expect(f.store.get(f.parent, item.id)?.name).toBe("_.._a_.sh");
    f.scope.release();
  });

  it.each([
    "https://example.test/?token=secret",
    "user:secret@example.test",
    "example.test/path",
    "example.test#secret",
    "example.test\nsecret",
  ])("rejects raw/private source metadata: %s", async (source) => {
    const f = await fixture();
    await expect(f.add("x", { source })).rejects.toThrow("request");
    expect(await readdir(join(f.home, "quarantine"))).toEqual([]);
    f.scope.release();
  });

  it("reserves the whole maximum download before awaiting any bytes", async () => {
    const f = await fixture({ limits: { file: 16, total: 16 } });
    const stream = new Readable({ read() {} });
    const first = f.store.ingest(f.origin, stream, f.scope);
    await expect(f.add("x")).rejects.toThrow("capacity");
    stream.push(Buffer.from("hello"));
    stream.push(null);
    expect((await first).bytes).toBe(5);
    expect(f.store.list(f.parent)).toHaveLength(1);
    f.scope.release();
  });

  it("removes an over-limit partial and returns its reservation", async () => {
    const f = await fixture({ limits: { file: 5, total: 10 } });
    await expect(f.add("123456")).rejects.toThrow("too-large");
    expect(await readdir(join(f.home, "quarantine"))).toEqual([]);
    expect((await f.add("12345")).bytes).toBe(5);
    f.scope.release();
  });

  it("waits for physical source closure after takeover cancellation and publishes no item", async () => {
    const f = await fixture();
    let finishDestroy: ((error?: Error | null) => void) | undefined;
    const stream = new Readable({
      read() {},
      destroy(_error, callback) {
        finishDestroy = callback;
      },
    });
    let finished = false;
    const work = f.store
      .ingest(f.origin, stream, f.scope)
      .catch((error: unknown) => error)
      .finally(() => {
        finished = true;
      });
    f.abort.abort();
    await new Promise((resolve) => setImmediate(resolve));
    expect(finishDestroy).toBeDefined();
    expect(finished).toBe(false);
    finishDestroy?.(new Error("closed"));
    expect(await work).toBeInstanceOf(Error);
    expect(f.store.list(f.parent)).toEqual([]);
    expect(await readdir(join(f.home, "quarantine"))).toEqual([]);
    f.scope.release();
  });

  it("releases only the exact approved file and returns the same durable receipt on retry", async () => {
    const f = await fixture();
    const item = await f.add();
    const target = destination();
    const released = await f.store.release(f.parent, item.id, release(item), f.scope, target.place);
    expect(released).toMatchObject({ state: "released", revision: 3 });
    expect([...target.files.values()].map((x) => x.toString())).toEqual(["approved bytes"]);
    expect(await readdir(join(f.home, "quarantine", item.id))).toEqual(["item.json"]);
    expect(await f.store.release(f.parent, item.id, release(item), f.scope, target.place)).toEqual(
      released,
    );
    expect(target.place).toHaveBeenCalledOnce();
    f.scope.release();
  });

  it.each(["revision", "sha256", "bytes", "name", "to"] as const)(
    "refuses a changed approval %s before placement",
    async (key) => {
      const f = await fixture();
      const item = await f.add();
      const target = destination();
      const request = {
        ...release(item),
        [key]: key === "revision" || key === "bytes" ? 99 : "changed",
      };
      await expect(
        f.store.release(f.parent, item.id, request, f.scope, target.place),
      ).rejects.toThrow();
      expect(target.place).not.toHaveBeenCalled();
      expect(f.store.get(f.parent, item.id)?.state).toBe("held");
      f.scope.release();
    },
  );

  it("does not expose or release another parent's item", async () => {
    const f = await fixture();
    const item = await f.add();
    const other = ulid();
    const target = destination();
    expect(f.store.get(other, item.id)).toBeUndefined();
    expect(f.store.list(other)).toEqual([]);
    await expect(
      f.store.release(other, item.id, release(item), f.scope, target.place),
    ).rejects.toThrow("missing");
    expect(target.place).not.toHaveBeenCalled();
    f.scope.release();
  });

  it("detects same-size payload substitution before invoking the desktop", async () => {
    const f = await fixture();
    const item = await f.add("good");
    const target = destination();
    await writeFile(join(f.home, "quarantine", item.id, "payload"), "evil", { mode: 0o600 });
    await expect(
      f.store.release(f.parent, item.id, release(item), f.scope, target.place),
    ).rejects.toThrow("corrupt");
    expect(target.place).not.toHaveBeenCalled();
    f.scope.release();
  });

  it("refuses a payload symlink and never reads its outside target", async () => {
    const f = await fixture();
    const item = await f.add();
    const target = destination();
    const outside = join(f.home, "outside");
    await writeFile(outside, "private outside", { mode: 0o600 });
    const path = join(f.home, "quarantine", item.id, "payload");
    await unlink(path);
    await symlink(outside, path);
    await expect(
      f.store.release(f.parent, item.id, release(item), f.scope, target.place),
    ).rejects.toThrow("corrupt");
    expect(target.place).not.toHaveBeenCalled();
    expect(await readFile(outside, "utf8")).toBe("private outside");
    f.scope.release();
  });

  it("refuses a world-readable quarantine or a replaced metadata file", async () => {
    const f = await fixture();
    const item = await f.add();
    const target = destination();
    const path = join(f.home, "quarantine", item.id, "item.json");
    await writeFile(path, JSON.stringify({ ...item, name: "swapped.txt" }), { mode: 0o600 });
    await expect(
      f.store.release(f.parent, item.id, release(item), f.scope, target.place),
    ).rejects.toThrow("stale");
    expect(target.place).not.toHaveBeenCalled();
    await chmod(join(f.home, "quarantine"), 0o755);
    await expect(QuarantineStore.open(f.home)).rejects.toThrow("corrupt");
    f.scope.release();
  });

  it("keeps an uncertain release ID through restart so reconciliation never creates a second file", async () => {
    const f = await fixture();
    const item = await f.add();
    const target = destination();
    const lost: PlaceDownload = async (...args) => {
      await target.place(...args);
      throw new Error("lost reply after placement");
    };
    await expect(f.store.release(f.parent, item.id, release(item), f.scope, lost)).rejects.toThrow(
      "lost reply",
    );
    const pending = f.store.get(f.parent, item.id);
    expect(pending?.state).toBe("releasing");
    expect(target.files.size).toBe(1);
    const recovered = await QuarantineStore.open(f.home);
    const result = await recovered.release(f.parent, item.id, release(item), f.scope, target.place);
    expect(result.state).toBe("released");
    expect(target.files.size).toBe(1);
    expect(target.place.mock.calls[0]?.[0].transferId).toBe(
      target.place.mock.calls[1]?.[0].transferId,
    );
    expect(target.place.mock.calls[0]?.[3]).toEqual({ reconcileOnly: false });
    expect(target.place.mock.calls[1]?.[3]).toEqual({ reconcileOnly: true });
    f.scope.release();
  });

  it("requires a new revision approval after the desktop permanently acknowledges not-placed", async () => {
    const f = await fixture();
    const item = await f.add();
    const target = destination();
    const lost: PlaceDownload = async () => {
      throw new Error("interrupted before commit");
    };
    await expect(f.store.release(f.parent, item.id, release(item), f.scope, lost)).rejects.toThrow(
      "interrupted",
    );
    const pending = f.store.get(f.parent, item.id);
    const negative: PlaceDownload = async (request, _chunks, _scope, options) => {
      expect(options.reconcileOnly).toBe(true);
      return { ...request, status: "not-placed" };
    };
    const recovered = await f.store.release(f.parent, item.id, release(item), f.scope, negative);
    expect(recovered).toMatchObject({
      state: "held",
      revision: 3,
      recovery: { approvedRevision: 1, result: { status: "not-placed" } },
    });
    expect(await readFile(join(f.home, "quarantine", item.id, "payload"), "utf8")).toBe(
      "approved bytes",
    );
    const reopened = await QuarantineStore.open(f.home);
    expect(reopened.get(f.parent, item.id)).toEqual(recovered);
    await expect(
      reopened.release(f.parent, item.id, release(item), f.scope, target.place),
    ).rejects.toThrow("stale");
    expect(target.place).not.toHaveBeenCalled();
    const placed = await reopened.release(
      f.parent,
      item.id,
      release(recovered),
      f.scope,
      target.place,
    );
    expect(placed).toMatchObject({ state: "released", revision: 5 });
    if (placed.state !== "released" || pending?.state !== "releasing")
      throw new Error("missing state");
    expect(placed.receipt.transferId).not.toBe(pending.release.transferId);
    expect(target.place).toHaveBeenCalledOnce();
    expect(target.place.mock.calls[0]?.[3]).toEqual({ reconcileOnly: false });
    f.scope.release();
  });

  it.each(["parentCellId", "transferId", "name", "bytes", "sha256"] as const)(
    "does not reset a pending transfer using a not-placed result with substituted %s",
    async (key) => {
      const f = await fixture();
      const item = await f.add();
      const lie: PlaceDownload = async (request) => ({
        ...request,
        status: "not-placed",
        [key]:
          key === "bytes"
            ? 999
            : key.endsWith("Id")
              ? ulid()
              : key === "sha256"
                ? "a".repeat(64)
                : "changed",
      });
      await expect(f.store.release(f.parent, item.id, release(item), f.scope, lie)).rejects.toThrow(
        "corrupt",
      );
      expect(f.store.get(f.parent, item.id)?.state).toBe("releasing");
      f.scope.release();
    },
  );

  it("can discard a recovered held item without retaining an invalid recovery proof", async () => {
    const f = await fixture();
    const item = await f.add();
    const recovered = await f.store.release(
      f.parent,
      item.id,
      release(item),
      f.scope,
      async (request) => ({ ...request, status: "not-placed" }),
    );
    const discarded = await f.store.discard(f.parent, item.id, recovered.revision, f.scope);
    expect(discarded.state).toBe("discarded");
    expect("recovery" in discarded).toBe(false);
    expect((await QuarantineStore.open(f.home)).get(f.parent, item.id)).toEqual(discarded);
    f.scope.release();
  });

  it("does not authorize fresh placement when an uncertain transfer loses its destination evidence", async () => {
    const f = await fixture();
    const item = await f.add();
    const target = destination();
    const lost: PlaceDownload = async (...args) => {
      await target.place(...args);
      throw new Error("lost reply after placement");
    };
    await expect(f.store.release(f.parent, item.id, release(item), f.scope, lost)).rejects.toThrow(
      "lost reply",
    );
    const pending = f.store.get(f.parent, item.id);
    const original = [...target.files.entries()];
    target.receipts.clear();
    const recovered = await QuarantineStore.open(f.home);
    await expect(
      recovered.release(f.parent, item.id, release(item), f.scope, target.place),
    ).rejects.toThrow("placement evidence missing");
    expect([...target.files.entries()]).toEqual(original);
    expect(recovered.get(f.parent, item.id)).toEqual(pending);
    expect(target.place.mock.calls[1]?.[3]).toEqual({ reconcileOnly: true });
    expect(Object.isFrozen(target.place.mock.calls[1]?.[3])).toBe(true);
    f.scope.release();
  });

  it.each(["releasing", "released"] as const)(
    "refuses a %s record with a substituted approved revision on restart",
    async (state) => {
      const f = await fixture();
      const item = await f.add();
      const target = destination();
      const lost: PlaceDownload = async (...args) => {
        const receipt = await target.place(...args);
        if (state === "releasing") throw new Error("lost reply after placement");
        return receipt;
      };
      const work = f.store.release(f.parent, item.id, release(item), f.scope, lost);
      if (state === "releasing") await expect(work).rejects.toThrow("lost reply");
      else await work;
      const path = join(f.home, "quarantine", item.id, "item.json");
      const persisted = JSON.parse(await readFile(path, "utf8"));
      persisted.release.approvedRevision += 1;
      await writeFile(path, JSON.stringify(persisted), { mode: 0o600 });
      await expect(QuarantineStore.open(f.home)).rejects.toThrow();
      expect(target.place).toHaveBeenCalledOnce();
      f.scope.release();
    },
  );

  it("refuses discard while placement is pending", async () => {
    const f = await fixture();
    const item = await f.add();
    const target = destination();
    const entered = Promise.withResolvers<void>(),
      proceed = Promise.withResolvers<void>();
    const place: PlaceDownload = async (...args) => {
      entered.resolve();
      await proceed.promise;
      return target.place(...args);
    };
    const work = f.store.release(f.parent, item.id, release(item), f.scope, place);
    await entered.promise;
    await expect(f.store.discard(f.parent, item.id, 2, f.scope)).rejects.toThrow("busy");
    proceed.resolve();
    expect((await work).state).toBe("released");
    f.scope.release();
  });

  it("does not claim success for a substituted placement receipt", async () => {
    const f = await fixture();
    const item = await f.add();
    const place: PlaceDownload = async (request) => ({
      ...request,
      sha256: "a".repeat(64),
      path: "~/Downloads/report.txt",
    });
    await expect(f.store.release(f.parent, item.id, release(item), f.scope, place)).rejects.toThrow(
      "corrupt",
    );
    expect(f.store.get(f.parent, item.id)?.state).toBe("releasing");
    f.scope.release();
  });

  it("recovers interrupted ingest and expires held bytes after the configured TTL", async () => {
    let now = 1000;
    const f = await fixture({ now: () => now, limits: { ttl: 100 } });
    const item = await f.add();
    const orphan = join(f.home, "quarantine", ulid());
    await mkdir(orphan, { mode: 0o700 });
    await writeFile(join(orphan, "payload.part"), "half", { mode: 0o600 });
    now = 1100;
    const recovered = await QuarantineStore.open(f.home, { now: () => now, limits: { ttl: 100 } });
    expect(recovered.get(f.parent, item.id)?.state).toBe("discarded");
    expect(await readdir(join(f.home, "quarantine"))).toEqual([item.id]);
    expect(await readdir(join(f.home, "quarantine", item.id))).toEqual(["item.json"]);
    f.scope.release();
  });

  it("never expires an uncertain placement, even after seven days", async () => {
    let now = 1000;
    const f = await fixture({ now: () => now, limits: { ttl: 100 } });
    const item = await f.add();
    const place: PlaceDownload = async (_request: PlacementRequest) => {
      throw new Error("uncertain");
    };
    await expect(f.store.release(f.parent, item.id, release(item), f.scope, place)).rejects.toThrow(
      "uncertain",
    );
    now = 2000;
    const recovered = await QuarantineStore.open(f.home, { now: () => now, limits: { ttl: 100 } });
    expect(recovered.get(f.parent, item.id)?.state).toBe("releasing");
    expect(await readdir(join(f.home, "quarantine", item.id))).toEqual(["item.json", "payload"]);
    f.scope.release();
  });
});
