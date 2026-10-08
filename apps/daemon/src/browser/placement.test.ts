import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopPlacement } from "./placement.ts";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function fixture(handler?: (request: IncomingMessage, response: ServerResponse) => void) {
  const data = Buffer.from("approved bytes");
  const request = {
    transferId: ulid(),
    parentCellId: ulid(),
    name: "report.txt",
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
  const receipt = { ...request, path: "~/Downloads/report.txt" };
  const received: { headers: IncomingMessage["headers"]; bytes: Buffer }[] = [];
  const server = createServer(
    handler ??
      ((incoming, response) => {
        const parts: Buffer[] = [];
        incoming.on("data", (chunk) => parts.push(chunk));
        incoming.on("end", () => {
          received.push({ headers: incoming.headers, bytes: Buffer.concat(parts) });
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(receipt));
        });
      }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address missing");
  let endpoint = { baseUrl: `http://127.0.0.1:${address.port}`, token: "t".repeat(43) };
  const lookup = vi.fn((parent: string) =>
    parent === request.parentCellId ? endpoint : undefined,
  );
  const abort = new AbortController();
  const scope = { signal: abort.signal, check: () => abort.signal.throwIfAborted() };
  const place = desktopPlacement(lookup, 1000);
  async function* chunks() {
    yield data;
  }
  return {
    request,
    receipt,
    data,
    received,
    lookup,
    abort,
    scope,
    place,
    chunks,
    endpoint,
    replace: () => {
      endpoint = { ...endpoint, token: "z".repeat(43) };
    },
  };
}

describe("desktop quarantine placement transport", () => {
  it("accepts only the exact durable not-placed result during reconciliation", async () => {
    const f = await fixture((request, response) => {
      request.resume();
      request.on("end", () =>
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ ...f.request, status: "not-placed" })),
      );
    });
    expect(await f.place(f.request, f.chunks(), f.scope, { reconcileOnly: true })).toEqual({
      ...f.request,
      status: "not-placed",
    });
  });

  it.each(["wrong-transfer", "extra-path"])(
    "refuses a malformed not-placed result: %s",
    async (kind) => {
      const f = await fixture((request, response) => {
        request.resume();
        request.on("end", () =>
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              ...f.request,
              status: "not-placed",
              ...(kind === "wrong-transfer"
                ? { transferId: ulid() }
                : { path: "~/Downloads/report.txt" }),
            }),
          ),
        );
      });
      await expect(
        f.place(f.request, f.chunks(), f.scope, { reconcileOnly: true }),
      ).rejects.toThrow("receipt");
    },
  );
  it("binds the endpoint, exact tuple, header and bytes; sends EOF only after source completion", async () => {
    const f = await fixture();
    expect(await f.place(f.request, f.chunks(), f.scope, { reconcileOnly: false })).toEqual(
      f.receipt,
    );
    expect(f.received).toHaveLength(1);
    expect(f.received[0]?.bytes).toEqual(f.data);
    const headers = f.received[0]?.headers;
    expect(headers?.authorization).toBe(`Bearer ${f.endpoint.token}`);
    expect(headers?.["content-length"]).toBeUndefined();
    expect(headers?.["transfer-encoding"]).toBe("chunked");
    expect(
      JSON.parse(Buffer.from(headers?.["x-localdot-placement"] as string, "base64url").toString()),
    ).toEqual({ ...f.request, reconcileOnly: false });
  });

  it("reconciles without reading or sending the held payload again", async () => {
    const f = await fixture();
    const next = vi.fn(async () => {
      throw new Error("must not read payload");
    });
    const chunks = { [Symbol.asyncIterator]: () => ({ next }) };
    expect(await f.place(f.request, chunks, f.scope, { reconcileOnly: true })).toEqual(f.receipt);
    expect(next).not.toHaveBeenCalled();
    expect(f.received[0]?.bytes.length).toBe(0);
    expect(f.received[0]?.headers["content-length"]).toBe("0");
  });

  it("refuses a parent with no current endpoint before contacting another cell", async () => {
    const f = await fixture();
    await expect(
      f.place({ ...f.request, parentCellId: ulid() }, f.chunks(), f.scope, {
        reconcileOnly: false,
      }),
    ).rejects.toThrow("changed");
    expect(f.received).toEqual([]);
  });

  it.each([
    "http://example.test:7700",
    "http://127.0.0.1:7700/other",
    "http://u:p@127.0.0.1:7700",
    "https://127.0.0.1:7700",
  ])("never sends the cell token to an invalid endpoint: %s", async (baseUrl) => {
    const f = await fixture();
    const place = desktopPlacement(() => ({ ...f.endpoint, baseUrl }));
    await expect(place(f.request, f.chunks(), f.scope, { reconcileOnly: false })).rejects.toThrow(
      "unavailable",
    );
  });

  it("refuses endpoint replacement during the final source check without emitting commit EOF", async () => {
    let ended = false;
    const seen = Promise.withResolvers<void>();
    const f = await fixture((request) => {
      request.on("data", () => seen.resolve());
      request.on("end", () => {
        ended = true;
      });
      request.on("error", () => {});
    });
    async function* chunks() {
      yield f.data;
      await seen.promise;
      f.replace();
    }
    await expect(f.place(f.request, chunks(), f.scope, { reconcileOnly: false })).rejects.toThrow(
      "changed",
    );
    expect(ended).toBe(false);
  });

  it("does not accept a success response that arrives before source EOF", async () => {
    const answered = Promise.withResolvers<void>();
    const f = await fixture((request, response) => {
      request.once("data", () => {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(f.receipt));
        answered.resolve();
      });
    });
    const release = Promise.withResolvers<void>();
    async function* chunks() {
      yield f.data;
      await release.promise;
    }
    const work = f.place(f.request, chunks(), f.scope, { reconcileOnly: false });
    void work.catch(() => undefined);
    await answered.promise;
    await delay(20);
    release.resolve();
    await expect(work).rejects.toThrow("receipt");
  });

  it("retains the operation during an aborted pending source read", async () => {
    const f = await fixture((request) => {
      request.resume();
      request.on("error", () => {});
    });
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let closed = false;
    async function* chunks() {
      try {
        entered.resolve();
        await release.promise;
        yield f.data;
      } finally {
        closed = true;
      }
    }
    const work = f.place(f.request, chunks(), f.scope, { reconcileOnly: false });
    void work.catch(() => undefined);
    await entered.promise;
    f.abort.abort();
    let settled = false;
    void work
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    await delay(20);
    expect(settled).toBe(false);
    release.resolve();
    await expect(work).rejects.toThrow("aborted");
    expect(closed).toBe(true);
  });

  it.each(["transferId", "parentCellId", "name", "sha256", "bytes", "path"] as const)(
    "rejects a substituted receipt %s",
    async (key) => {
      const f = await fixture((request, response) => {
        request.resume();
        request.on("end", () =>
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              ...f.receipt,
              [key]:
                key === "bytes"
                  ? 99
                  : key === "path"
                    ? "~/Downloads/../outside"
                    : key.endsWith("Id")
                      ? ulid()
                      : "changed",
            }),
          ),
        );
      });
      await expect(
        f.place(f.request, f.chunks(), f.scope, { reconcileOnly: false }),
      ).rejects.toThrow("receipt");
    },
  );

  it("does not follow a redirect or expose its refusal body", async () => {
    const f = await fixture((request, response) => {
      request.resume();
      response.writeHead(302, { location: "https://outside.example.test/" }).end("private content");
    });
    await expect(f.place(f.request, f.chunks(), f.scope, { reconcileOnly: false })).rejects.toThrow(
      "refused",
    );
  });

  it("bounds a response that never finishes", async () => {
    const f = await fixture((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.write("{");
      });
    });
    const place = desktopPlacement(f.lookup, 50);
    await expect(place(f.request, f.chunks(), f.scope, { reconcileOnly: false })).rejects.toThrow(
      "aborted",
    );
  });
});
