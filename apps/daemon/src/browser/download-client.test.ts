import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserDownloadBinding } from "../../../../packages/protocol/src/browser-downloads.ts";
import { BrowserClient } from "./client.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const json = (response: ServerResponse, body: unknown) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
const binary = (response: ServerResponse, value: Uint8Array) => {
  response.writeHead(200, {
    "content-type": "application/octet-stream",
    "transfer-encoding": "chunked",
  });
  response.end(value);
};

async function fixture(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
  value = Buffer.from("hello 下载"),
) {
  const server = createServer(handle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address missing");
  const endpoint = {
    browserCellId: ulid(),
    parentCellId: ulid(),
    instance: randomUUID(),
    browserd: { baseUrl: `http://127.0.0.1:${address.port}`, token: "d".repeat(43) },
    stream: { baseUrl: "http://127.0.0.1:4999", authorization: "fixture" },
  };
  const client = new BrowserClient(endpoint);
  cleanups.push(() => client.close());
  const binding: BrowserDownloadBinding = {
    holder: "user",
    sessionId: ulid(),
    permit: {
      browserCellId: endpoint.browserCellId,
      parentCellId: endpoint.parentCellId,
      instance: endpoint.instance,
      revision: 1,
      requestId: ulid(),
    },
  };
  const offer = {
    guid: randomUUID(),
    bytes: value.byteLength,
    sha256: hash(value),
    origin: {
      parentCellId: endpoint.parentCellId,
      browserCellId: endpoint.browserCellId,
      browserInstance: endpoint.instance,
      sessionId: binding.sessionId,
      name: "report.txt",
      source: "download.example.test",
    },
  };
  const abort = new AbortController();
  const scope = { signal: abort.signal, check: vi.fn() };
  const read = async () => {
    const source = client.readDownload(binding, offer, scope);
    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  };
  return { client, binding, offer, scope, abort, read, value, endpoint };
}

describe("browser download client", () => {
  it.each([Buffer.alloc(0), Buffer.from("你好 English"), Buffer.alloc(200000, 7)])(
    "reads exact bytes only after authenticated chunked EOF %#",
    async (value) => {
      let authorization: string | undefined;
      const f = await fixture((request, response) => {
        authorization = request.headers.authorization;
        binary(response, value);
      }, value);
      expect(await f.read()).toEqual(value);
      expect(authorization).toBe(`Bearer ${f.endpoint.browserd.token}`);
    },
  );

  it("arms, lists and acknowledges an exact session-bound download", async () => {
    const requests: { path: string | undefined; body: unknown }[] = [];
    const f = await fixture((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
        json(
          response,
          request.url === "/downloads/arm"
            ? { armed: true }
            : request.url === "/downloads/list"
              ? { downloads: [f.offer] }
              : { acknowledged: true },
        );
      })();
    });
    await f.client.armDownloads(f.binding, f.scope);
    expect(await f.client.downloads(f.binding, f.scope)).toEqual([f.offer]);
    await f.client.acknowledgeDownload(f.binding, f.offer, f.scope);
    expect(requests).toEqual([
      { path: "/downloads/arm", body: { binding: f.binding } },
      { path: "/downloads/list", body: { binding: f.binding } },
      {
        path: "/downloads/ack",
        body: {
          binding: f.binding,
          guid: f.offer.guid,
          bytes: f.offer.bytes,
          sha256: f.offer.sha256,
        },
      },
    ]);
  });

  it.each(["browserCellId", "parentCellId", "browserInstance", "sessionId", "name"] as const)(
    "rejects a list reply with changed %s",
    async (field) => {
      const f = await fixture((_request, response) => {
        const offer = structuredClone(f.offer);
        if (field === "browserInstance") offer.origin.browserInstance = randomUUID();
        else offer.origin[field] = field === "name" ? "../report.txt" : ulid();
        json(response, { downloads: [offer] });
      });
      await expect(f.client.downloads(f.binding, f.scope)).rejects.toThrow("stale");
    },
  );

  it("does not open transport for a stale binding, or an unread/destroyed lazy stream", async () => {
    const called = vi.fn((_request, response) => binary(response, Buffer.alloc(0)));
    const f = await fixture(called);
    await expect(
      f.client.armDownloads(
        { ...f.binding, permit: { ...f.binding.permit, instance: randomUUID() } },
        f.scope,
      ),
    ).rejects.toThrow("stale");
    const source = f.client.readDownload(f.binding, f.offer, f.scope);
    const closed = finished(source).catch(() => {});
    source.destroy();
    await closed;
    expect(called).not.toHaveBeenCalled();
  });

  it.each(["length", "encoding", "type", "redirect"])(
    "refuses unsafe %s response",
    async (kind) => {
      const f = await fixture((_request, response) => {
        response.writeHead(kind === "redirect" ? 302 : 200, {
          "content-type": kind === "type" ? "application/json" : "application/octet-stream",
          ...(kind === "length"
            ? { "content-length": f.value.length }
            : { "transfer-encoding": "chunked" }),
          ...(kind === "encoding" ? { "content-encoding": "gzip" } : {}),
          ...(kind === "redirect" ? { location: "http://127.0.0.1:1/never-follow" } : {}),
        });
        response.end(f.value);
      });
      await expect(f.read()).rejects.toThrow();
    },
  );

  it.each(["short", "long", "digest"])(
    "refuses a %s body before a successful EOF",
    async (kind) => {
      const f = await fixture((_request, response) =>
        binary(
          response,
          kind === "short"
            ? f.value.subarray(1)
            : kind === "long"
              ? Buffer.concat([f.value, Buffer.from("x")])
              : Buffer.alloc(f.value.length),
        ),
      );
      await expect(f.read()).rejects.toThrow("reply");
    },
  );

  it("does not accept all expected bytes without the server's terminal chunk", async () => {
    const f = await fixture((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "transfer-encoding": "chunked",
      });
      response.write(f.value, () => response.destroy());
    });
    await expect(f.read()).rejects.toThrow();
  });

  it.each(["headers", "body"])(
    "local destruction interrupts a pending %s read and drains it",
    async (phase) => {
      let received!: () => void;
      let disconnected!: () => void;
      const arrival = new Promise<void>((resolve) => {
        received = resolve;
      });
      const disconnect = new Promise<void>((resolve) => {
        disconnected = resolve;
      });
      const f = await fixture((request, response) => {
        request.socket.once("close", disconnected);
        if (phase === "body") {
          response.writeHead(200, {
            "content-type": "application/octet-stream",
            "transfer-encoding": "chunked",
          });
          response.write(f.value.subarray(0, 1));
        }
        received();
      });
      const source = f.client.readDownload(f.binding, f.offer, f.scope);
      const closed = finished(source).catch(() => {});
      source.resume();
      await arrival;
      source.destroy();
      await closed;
      await disconnect;
      expect(source.closed).toBe(true);
    },
  );

  it.each(["scope", "client"])(
    "cancels an unfinished download when its %s closes",
    async (kind) => {
      let received!: () => void;
      const arrival = new Promise<void>((resolve) => {
        received = resolve;
      });
      const f = await fixture((_request, response) => {
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "transfer-encoding": "chunked",
        });
        response.write(f.value);
        received();
      });
      const work = f.read();
      const failed = expect(work).rejects.toThrow();
      await arrival;
      if (kind === "scope") f.abort.abort();
      else f.client.close();
      await failed;
    },
  );
});
