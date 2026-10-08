import { createHash, randomUUID } from "node:crypto";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserDownloadBinding } from "../../../../packages/protocol/src/browser-downloads.ts";
import { BrowserControl } from "./control.ts";
import { BrowserDownloadService } from "./download-service.ts";
import type { BrowserSpoolFile, DownloadScope } from "./download-spool.ts";
import { BrowserHttp } from "./http.ts";
import { browserRuntimeConfig } from "./runtime-config.ts";

const config = browserRuntimeConfig({
  LOCALDOT_BROWSER_CELL_ID: "01J00000000000000000000001",
  LOCALDOT_PARENT_CELL_ID: "01J00000000000000000000002",
  LOCALDOT_BROWSERD_TOKEN: "a".repeat(43),
  LOCALDOT_STREAM_TOKEN: "b".repeat(43),
  LOCALDOT_GATE_ADDR: "172.20.0.2",
  LOCALDOT_SCALE: "1",
});
const instance = "b6adbffb-ad25-4d50-9297-5078b1d2cb4a";
const identity = {
  browserCellId: config.browserCellId,
  parentCellId: config.parentCellId,
  instance,
};
const sessionId = "01J00000000000000000000003";
const requestId = "01J00000000000000000000004";
const binding: BrowserDownloadBinding = {
  holder: "user",
  sessionId,
  permit: { ...identity, requestId, revision: 1 },
};
const guid = "88a2f22b-686d-43f5-aa33-078a16a368f1";
const bytes = Buffer.from("a verified report 中文");
const digest = createHash("sha256").update(bytes).digest("hex");
const cleanups: (() => Promise<void>)[] = [];
const signal = () => new AbortController().signal;
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

async function fixture() {
  const control = new BrowserControl({
    ...identity,
    clearSelections: async () => {},
    secretPages: async () => [],
    reload: async () => {},
  });
  await control.set({ ...binding.permit, holder: "user" });
  let ready = true;
  let retired: Promise<void> | undefined;
  let validation = async () => {};
  const records = new Set<string>();
  const spool = {
    reserve: vi.fn((id: string) => {
      records.add(id);
    }),
    rejected: vi.fn((id: string) => {
      records.add(id);
    }),
    completed: vi.fn(async (id: string, count: number, scope: DownloadScope) => {
      scope.check();
      return Object.freeze({ guid: id, bytes: count, sha256: digest });
    }),
    cancelled: vi.fn(),
    remove: vi.fn(async (id: string) => {
      records.delete(id);
    }),
    close: vi.fn(async () => {}),
    read: vi.fn(async function* (_file: BrowserSpoolFile, scope: DownloadScope) {
      scope.check();
      yield bytes;
      await validation();
      scope.signal.throwIfAborted();
      scope.check();
    }),
  };
  const openSpool = vi.fn(async () => spool);
  const targets = {
    downloadBehavior: vi.fn(async (_enabled: boolean, _signal?: AbortSignal) => {}),
    cancelDownload: vi.fn(async (_guid: string) => {}),
  };
  const stop = (): Promise<void> => {
    if (retired) return retired;
    const done = Promise.withResolvers<void>();
    retired = done.promise;
    ready = false;
    const controlling = control.close();
    const transferring = service.close();
    // Process-supervisor tests separately verify this marker requires full physical group exit.
    service.writersExited();
    void Promise.all([controlling, transferring]).then(() => done.resolve(), done.reject);
    return done.promise;
  };
  const fence = vi.fn(() => {
    void stop().catch(() => {});
  });
  const service = new BrowserDownloadService({
    config,
    instance,
    control,
    targets,
    openSpool,
    fence,
  });
  const http = new BrowserHttp({
    config,
    instance,
    control,
    targets: { tabs: () => [] },
    downloads: service,
    input: {
      inject: async () => {
        throw new Error("unused");
      },
      type: async () => {
        throw new Error("unused");
      },
    },
    observation: {
      observe: async () => {
        throw new Error("unused");
      },
    },
    ready: () => ready,
    fence,
    stop,
    retirement: () => retired,
  });
  await new Promise<void>((resolve, reject) => {
    http.server.once("error", reject);
    http.server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(() => http.close());
  const port = (http.server.address() as AddressInfo).port;
  const begin = () =>
    service.begin({
      guid,
      frameId: "frame-1",
      url: "https://files.example.test/a?secret=private",
      suggestedFilename: "report.txt",
    });
  const complete = async () => {
    service.progress({
      guid,
      receivedBytes: bytes.length,
      totalBytes: bytes.length,
      state: "completed",
    });
    await flush();
  };
  return {
    control,
    service,
    targets,
    openSpool,
    spool,
    fence,
    http,
    port,
    begin,
    complete,
    records,
    validation(effect: () => Promise<void>) {
      validation = effect;
    },
  };
}

interface Reply {
  status: number;
  headers: Record<string, unknown>;
  bytes: Buffer;
  complete: boolean;
}
function post(
  port: number,
  path: string,
  body: unknown,
  options: { token?: string; origin?: string; onBytes?: (bytes: Buffer) => void } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        agent: false,
        headers: {
          authorization: `Bearer ${options.token ?? config.serviceToken}`,
          "content-type": "application/json",
          ...(options.origin ? { origin: options.origin } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          options.onBytes?.(chunk);
        });
        const result = (complete: boolean) =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            bytes: Buffer.concat(chunks),
            complete,
          });
        res.once("end", () => result(true));
        res.once("error", () => result(false));
        res.once("aborted", () => result(false));
      },
    );
    req.once("error", reject);
    req.end(JSON.stringify(body));
  });
}

afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

describe("authenticated session-bound browser downloads", () => {
  it("requires authentication, no browser Origin, strict envelopes and current control before arming", async () => {
    const f = await fixture();
    expect((await post(f.port, "/downloads/arm", { binding }, { token: "bad" })).status).toBe(401);
    expect(
      (await post(f.port, "/downloads/arm", { binding }, { origin: "https://evil.example" }))
        .status,
    ).toBe(400);
    expect((await post(f.port, "/downloads/arm", { binding, path: "/profile" })).status).toBe(400);
    expect(
      (
        await post(f.port, "/downloads/arm", {
          binding: { ...binding, permit: { ...binding.permit, instance: randomUUID() } },
        })
      ).status,
    ).toBe(409);
    expect(f.openSpool).not.toHaveBeenCalled();
    expect(f.targets.downloadBehavior).not.toHaveBeenCalled();
  });

  it("arms idempotently, lists sanitized offers and transfers exact bytes through real HTTP", async () => {
    const f = await fixture();
    for (let i = 0; i < 2; i++)
      expect((await post(f.port, "/downloads/arm", { binding })).status).toBe(200);
    expect(f.openSpool).toHaveBeenCalledOnce();
    expect(f.targets.downloadBehavior.mock.calls.map(([enabled]) => enabled)).toEqual([
      false,
      true,
    ]);
    f.begin();
    await f.complete();
    const list = await post(f.port, "/downloads/list", { binding });
    expect(JSON.parse(list.bytes.toString()).downloads[0]).toMatchObject({
      guid,
      bytes: bytes.length,
      sha256: digest,
      origin: { sessionId, source: "files.example.test", name: "report.txt" },
    });
    expect(list.bytes.toString()).not.toMatch(/secret|private|filePath/u);
    const read = await post(f.port, "/downloads/read", { binding, guid });
    expect(read.complete).toBe(true);
    expect(read.bytes).toEqual(bytes);
    expect(read.headers["content-type"]).toBe("application/octet-stream");
    expect(read.headers["content-length"]).toBeUndefined();
    expect(read.headers["transfer-encoding"]).toBe("chunked");
    expect(f.records.has(guid)).toBe(true);
    expect(
      (await post(f.port, "/downloads/ack", { binding, guid, bytes: bytes.length, sha256: digest }))
        .status,
    ).toBe(200);
    expect(f.records.has(guid)).toBe(false);
  });

  it("cannot expose success EOF before the final source validation; failure destroys the body without appending JSON", async () => {
    const f = await fixture();
    await f.service.arm(binding, signal());
    f.begin();
    await f.complete();
    const finalCheck = Promise.withResolvers<void>();
    const received = Promise.withResolvers<void>();
    f.validation(async () => {
      await finalCheck.promise;
      throw new Error("changed private source");
    });
    let done = false;
    const read = post(
      f.port,
      "/downloads/read",
      { binding, guid },
      {
        onBytes() {
          received.resolve();
        },
      },
    ).then((reply) => {
      done = true;
      return reply;
    });
    await received.promise;
    expect(done).toBe(false);
    finalCheck.resolve();
    const reply = await read;
    expect(reply.complete).toBe(false);
    expect(reply.bytes).toEqual(bytes);
    expect(reply.bytes.toString()).not.toMatch(/error|private/u);
    expect(f.records.has(guid)).toBe(true);
  });

  it("refuses substituted acknowledgements and unknown GUIDs before deleting a file", async () => {
    const f = await fixture();
    await f.service.arm(binding, signal());
    f.begin();
    await f.complete();
    expect(
      (
        await post(f.port, "/downloads/ack", {
          binding,
          guid,
          bytes: bytes.length,
          sha256: "b".repeat(64),
        })
      ).status,
    ).toBe(409);
    expect((await post(f.port, "/downloads/read", { binding, guid: randomUUID() })).status).toBe(
      409,
    );
    expect(f.records.has(guid)).toBe(true);
  });

  it("takeover waits for terminal download progress and rejects the previous binding afterward", async () => {
    const f = await fixture();
    await f.service.arm(binding, signal());
    f.begin();
    let changed = false;
    const next = { ...binding.permit, revision: 2 };
    const transition = f.control.set({ ...next, holder: "user" }).then(() => {
      changed = true;
    });
    await flush();
    expect(changed).toBe(false);
    expect(f.targets.cancelDownload).toHaveBeenCalledWith(guid);
    f.service.progress({ guid, state: "canceled", receivedBytes: 0 });
    await transition;
    expect((await post(f.port, "/downloads/list", { binding })).status).toBe(409);
    const second = { ...binding, permit: next };
    expect((await post(f.port, "/downloads/arm", { binding: second })).status).toBe(200);
    expect(f.openSpool).toHaveBeenCalledTimes(2);
  });

  it("Stop contains writers and drains download-held control leases without waiting for stop() to signal exit", async () => {
    const f = await fixture();
    await f.service.arm(binding, signal());
    f.begin();
    const result = await post(f.port, "/stop", identity);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.bytes.toString()).stopped).toBe(true);
    expect(f.spool.remove).toHaveBeenCalledWith(guid);
    expect(f.spool.close).toHaveBeenCalled();
    expect((await post(f.port, "/downloads/list", { binding })).status).toBe(503);
  });

  it("a session binding inconsistent with the agent's owner cannot arm downloads", async () => {
    const f = await fixture();
    const agent = {
      ...binding,
      holder: "agent",
      permit: {
        ...binding.permit,
        owner: { sessionId: "01J00000000000000000000009", generation: 1 },
      },
    };
    expect((await post(f.port, "/downloads/arm", { binding: agent })).status).toBe(400);
    expect(f.openSpool).not.toHaveBeenCalled();
  });

  it("shutdown while a private spool opens closes it before finishing the arming lease", async () => {
    const f = await fixture();
    const opening = Promise.withResolvers<typeof f.spool>();
    f.openSpool.mockImplementation(() => opening.promise);
    const arm = f.service.arm(binding, signal());
    const rejected = expect(arm).rejects.toThrow();
    await flush();
    expect(f.openSpool).toHaveBeenCalledOnce();
    let closed = false;
    const closing = f.service.close().then(() => {
      closed = true;
    });
    await flush();
    expect(closed).toBe(false);
    opening.resolve(f.spool);
    await rejected;
    await closing;
    expect(f.spool.close).toHaveBeenCalledOnce();
    await f.control.close();
    expect(f.targets.downloadBehavior.mock.calls.some(([enabled]) => enabled)).toBe(false);
  });
});
