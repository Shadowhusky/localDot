import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserDownloadBinding } from "../../../../packages/protocol/src/browser-downloads.ts";
import { Transfers } from "../agent/transfers.ts";
import { BrowserClient } from "./client.ts";
import { BrowserDownloadCollector } from "./download-collector.ts";
import { QuarantineStore } from "./quarantine.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(value = Buffer.from("completed download 中文 English")) {
  const home = await mkdtemp(join(tmpdir(), "localdot-browser-collector-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const store = await QuarantineStore.open(home);
  const transfers = new Transfers();
  const collector = new BrowserDownloadCollector({ store, transfers });
  const id = { browserCellId: ulid(), parentCellId: ulid(), instance: randomUUID() };
  const binding: BrowserDownloadBinding = {
    holder: "user",
    sessionId: ulid(),
    permit: {
      ...id,
      revision: 1,
      requestId: ulid(),
    },
  };
  const offer = {
    guid: randomUUID(),
    bytes: value.length,
    sha256: createHash("sha256").update(value).digest("hex"),
    origin: {
      browserCellId: id.browserCellId,
      parentCellId: id.parentCellId,
      browserInstance: id.instance,
      sessionId: binding.sessionId,
      name: "report.txt",
      source: "download.example.test",
    },
  };
  const state = {
    held: true,
    failAck: "none" as "none" | "before" | "after",
    reads: 0,
    acks: 0,
    badBody: false,
    durableAtAck: false,
    requests: [] as string[],
  };
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (
        request.headers.authorization !== `Bearer ${"c".repeat(43)}` ||
        JSON.stringify(body.binding) !== JSON.stringify(binding)
      )
        throw new Error("fixture authority mismatch");
      state.requests.push(request.url ?? "");
      if (request.url === "/downloads/read") {
        state.reads++;
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "transfer-encoding": "chunked",
        });
        response.end(state.badBody ? Buffer.alloc(value.length) : value);
        return;
      }
      if (request.url === "/downloads/ack") {
        state.acks++;
        const held = store.list(id.parentCellId)[0];
        state.durableAtAck =
          held?.browserDownloadGuid === offer.guid &&
          (await readFile(join(home, "quarantine", held.id, "payload"))).equals(value);
        if (body.guid !== offer.guid || body.bytes !== offer.bytes || body.sha256 !== offer.sha256)
          throw new Error("fixture acknowledgement mismatch");
        if (state.failAck !== "before") state.held = false;
        if (state.failAck !== "none") {
          response.destroy();
          return;
        }
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          request.url === "/downloads/list"
            ? { downloads: state.held ? [offer] : [] }
            : { acknowledged: true },
        ),
      );
    })().catch(() => response.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture port missing");
  const client = new BrowserClient({
    ...id,
    browserd: { baseUrl: `http://127.0.0.1:${address.port}`, token: "c".repeat(43) },
    stream: { baseUrl: "http://127.0.0.1:4888", authorization: "fixture" },
  });
  cleanups.push(() => client.close());
  const abort = new AbortController();
  const scope = { signal: abort.signal, check: () => {} };
  return {
    home,
    store,
    transfers,
    collector,
    client,
    id,
    binding,
    offer,
    value,
    state,
    scope,
    abort,
  };
}

describe("browser download collection", () => {
  it.each([Buffer.alloc(0), Buffer.from("download")])(
    "durably stores bytes before acknowledging, including empty files %#",
    async (value) => {
      const f = await fixture(value);
      const [item] = await f.collector.collect(f.client, f.binding, f.scope);
      expect(item).toMatchObject({
        state: "held",
        browserDownloadGuid: f.offer.guid,
        sha256: f.offer.sha256,
      });
      expect(f.state.durableAtAck).toBe(true);
      expect(f.state.requests).toEqual(["/downloads/list", "/downloads/read", "/downloads/ack"]);
      expect(f.state.held).toBe(false);
      await f.transfers.wait(f.id.parentCellId);
    },
  );

  it("reconciles a lost acknowledgement after daemon restart without copying bytes again", async () => {
    const f = await fixture();
    f.state.failAck = "before";
    await expect(f.collector.collect(f.client, f.binding, f.scope)).rejects.toThrow();
    const original = f.store.list(f.id.parentCellId)[0];
    expect(original?.state).toBe("held");
    const restarted = await QuarantineStore.open(f.home);
    const collector = new BrowserDownloadCollector({ store: restarted, transfers: f.transfers });
    f.state.failAck = "none";
    expect(await collector.collect(f.client, f.binding, f.scope)).toEqual([original]);
    expect(f.state.reads).toBe(1);
    expect(f.state.acks).toBe(2);
    expect(restarted.list(f.id.parentCellId)).toEqual([original]);
  });

  it("keeps the durable item if the browser removed its copy but its acknowledgement reply was lost", async () => {
    const f = await fixture();
    f.state.failAck = "after";
    await expect(f.collector.collect(f.client, f.binding, f.scope)).rejects.toThrow();
    expect(f.state.held).toBe(false);
    expect(await f.collector.collect(f.client, f.binding, f.scope)).toEqual([]);
    expect(f.store.list(f.id.parentCellId)).toHaveLength(1);
    expect(f.state.reads).toBe(1);
    expect(f.state.acks).toBe(1);
  });

  it("does not acknowledge a corrupt body or publish an incomplete item", async () => {
    const f = await fixture();
    f.state.badBody = true;
    await expect(f.collector.collect(f.client, f.binding, f.scope)).rejects.toThrow();
    expect(f.state.acks).toBe(0);
    expect(f.store.list(f.id.parentCellId)).toEqual([]);
    f.state.badBody = false;
    expect(await f.collector.collect(f.client, f.binding, f.scope)).toHaveLength(1);
  });

  it("retains its TransferLease until a cancelled source physically closes", async () => {
    const f = await fixture();
    let started!: () => void;
    let destroy!: () => void;
    const reading = new Promise<void>((done) => {
      started = done;
    });
    const source = new Readable({
      read() {
        started();
      },
      destroy(_error, done) {
        destroy = () => done();
      },
    });
    const client = {
      downloads: async () => [f.offer],
      readDownload: () => source,
      acknowledgeDownload: vi.fn(),
    };
    const work = f.collector.collect(client, f.binding, f.scope);
    const failed = expect(work).rejects.toThrow();
    await reading;
    f.transfers.abortCell(f.id.parentCellId);
    let drained = false;
    const drain = f.transfers.wait(f.id.parentCellId).then(() => {
      drained = true;
    });
    await new Promise((done) => setImmediate(done));
    expect(drained).toBe(false);
    destroy();
    await failed;
    await drain;
    expect(drained).toBe(true);
    expect(client.acknowledgeDownload).not.toHaveBeenCalled();
    expect(f.store.list(f.id.parentCellId)).toEqual([]);
  });

  it("serializes collectors for a parent while its prior source is still draining", async () => {
    const f = await fixture();
    const list = Promise.withResolvers<never[]>();
    const client = {
      downloads: () => list.promise,
      readDownload: vi.fn(),
      acknowledgeDownload: vi.fn(),
    };
    const first = f.collector.collect(client, f.binding, f.scope);
    await expect(f.collector.collect(f.client, f.binding, f.scope)).rejects.toThrow(
      "already active",
    );
    list.resolve([]);
    await first;
    expect(await f.collector.collect(f.client, f.binding, f.scope)).toHaveLength(1);
  });

  it("rejects another session's offered file before opening a source", async () => {
    const f = await fixture();
    const client = {
      downloads: async () => [{ ...f.offer, origin: { ...f.offer.origin, sessionId: ulid() } }],
      readDownload: vi.fn(),
      acknowledgeDownload: vi.fn(),
    };
    await expect(f.collector.collect(client, f.binding, f.scope)).rejects.toThrow("owner changed");
    expect(client.readDownload).not.toHaveBeenCalled();
    expect(client.acknowledgeDownload).not.toHaveBeenCalled();
  });
});
