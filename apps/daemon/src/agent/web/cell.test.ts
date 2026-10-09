import { describe, expect, it } from "vitest";
import { WEB_CELL_ID, WebCell, WebError } from "./cell.ts";

const signal = new AbortController().signal;
const options = { signal, accept: "text/html", maxBytes: 1024 };

function harness(
  answer: (url: string, init: RequestInit) => Response | Promise<Response>,
  open: () => unknown = () => undefined,
) {
  const opened: unknown[] = [];
  const closed: string[] = [];
  const reserved: number[] = [];
  const released: number[] = [];
  const asked: { url: string; headers: Record<string, string> }[] = [];
  let next = 4770;
  const cell = new WebCell({
    keyd: {
      openCell: async (request) => {
        opened.push(request);
        open();
        return {
          cellId: request.cellId,
          port: request.port,
          proxyToken: "p".repeat(43),
          caCertPem: "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n",
          caPath: "/tmp/ca.pem",
        };
      },
      closeCell: async (id) => {
        closed.push(id);
        return true;
      },
    },
    ports: {
      reserve: () => {
        reserved.push(next);
        return next++;
      },
      release: (port) => void released.push(port),
    },
    fetch: (async (url: URL, init: RequestInit) => {
      asked.push({ url: String(url), headers: init.headers as Record<string, string> });
      return answer(String(url), init);
    }) as never,
    idleMs: 60_000,
  });
  return { cell, opened, closed, reserved, released, asked };
}

describe("the web tools' keyd listener", () => {
  it("opens one keyless listener with the web browser's egress and reuses it", async () => {
    const h = harness(
      () => new Response("<p>hi</p>", { headers: { "content-type": "text/html" } }),
    );
    const first = await h.cell.get(new URL("https://example.org/a"), options);
    await h.cell.get(new URL("https://example.org/b"), options);
    expect(first).toMatchObject({ status: 200, contentType: "text/html", truncated: false });
    expect(first.body.toString()).toBe("<p>hi</p>");
    expect(h.opened).toEqual([{ cellId: WEB_CELL_ID, role: "browser", port: 4770, secrets: [] }]);
    expect(h.asked[0]?.headers["user-agent"]).toMatch(/Chrome/);
    expect(h.asked[0]?.headers).not.toHaveProperty("cookie");
    await h.cell.close();
    expect(h.closed.filter((id) => id === WEB_CELL_ID)).toHaveLength(2);
    expect(h.released).toEqual([4770]);
  });

  it("follows redirects only to public addresses on the usual ports", async () => {
    const h = harness((url) =>
      url === "https://example.org/old"
        ? new Response(null, { status: 301, headers: { location: "/new" } })
        : url === "https://example.org/new"
          ? new Response("moved", { headers: { "content-type": "text/plain" } })
          : new Response(null, { status: 302, headers: { location: "http://127.0.0.1:4750/api" } }),
    );
    const moved = await h.cell.get(new URL("https://example.org/old"), options);
    expect(moved.url.href).toBe("https://example.org/new");
    await expect(h.cell.get(new URL("https://example.org/sneaky"), options)).rejects.toThrow(
      WebError,
    );
    expect(h.asked.map((a) => a.url)).not.toContain("http://127.0.0.1:4750/api");
    for (const address of [
      "http://localhost/",
      "https://example.org:8443/",
      "https://192.168.1.1/",
      "https://user:pw@example.org/",
      "https://printer.local/",
    ])
      await expect(h.cell.get(new URL(address), options), address).rejects.toThrow(WebError);
  });

  it("reads no more than it was asked to, and says it cut the rest", async () => {
    const h = harness(() => new Response("x".repeat(5000)));
    const reply = await h.cell.get(new URL("https://example.org/"), options);
    expect(reply.body.length).toBe(1024);
    expect(reply.truncated).toBe(true);
  });

  it("opens a fresh listener after one stops answering, and gives its port back", async () => {
    let fail = true;
    const h = harness(() => {
      if (fail)
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
        });
      return new Response("ok");
    });
    await expect(h.cell.get(new URL("https://example.org/"), options)).rejects.toThrow(
      "The site could not be reached, or the network rules don't allow it.",
    );
    expect(h.released).toEqual([4770]);
    fail = false;
    await h.cell.get(new URL("https://example.org/"), options);
    expect(h.reserved).toEqual([4770, 4771]);
    await h.cell.close();
  });

  it("keeps the listener when only a site fails behind it", async () => {
    const h = harness((url) => {
      if (url.includes("down"))
        throw new TypeError("fetch failed", {
          cause: new Error("Proxy response (502) !== 200 when HTTP Tunneling"),
        });
      return new Response("ok");
    });
    await expect(h.cell.get(new URL("https://down.example.org/"), options)).rejects.toThrow(
      "could not be reached",
    );
    await h.cell.get(new URL("https://up.example.org/"), options);
    expect(h.opened).toHaveLength(1);
    expect(h.released).toEqual([]);
    await h.cell.close();
  });

  it("says so when keyd won't open the listener, and keeps no port", async () => {
    const h = harness(
      () => new Response("unused"),
      () => {
        throw new Error("keyd is not running");
      },
    );
    await expect(h.cell.get(new URL("https://example.org/"), options)).rejects.toThrow(
      "The web can't be reached",
    );
    expect(h.released).toEqual([4770]);
    expect(h.asked).toEqual([]);
  });
});
