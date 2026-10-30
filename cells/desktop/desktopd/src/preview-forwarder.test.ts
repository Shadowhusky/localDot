import { once } from "node:events";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { type AddressInfo, connect, createServer, type Server } from "node:net";
import { previewPreface } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createPreviewForwarder, dialTarget, ownAddresses } from "./preview-forwarder.ts";

const TOKEN = "f".repeat(43);
const open: (Server | HttpServer)[] = [];
afterEach(async () => {
  for (const server of open.splice(0)) {
    server.close();
    if ("closeAllConnections" in server) server.closeAllConnections();
  }
});

async function listen<T extends Server | HttpServer>(
  server: T,
  host = "127.0.0.1",
): Promise<number> {
  open.push(server);
  server.listen(0, host);
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

async function forwarder(options: Partial<Parameters<typeof createPreviewForwarder>[0]> = {}) {
  return listen(createPreviewForwarder({ token: TOKEN, addresses: () => [], ...options }));
}

// Sends `first`, then reads until the forwarder closes or `until` has arrived.
async function exchange(port: number, first: string, until?: string): Promise<string> {
  const socket = connect(port, "127.0.0.1");
  socket.write(first);
  let text = "";
  socket.on("data", (chunk) => {
    text += chunk.toString("utf8");
    if (until && text.includes(until)) socket.end();
  });
  await once(socket, "close");
  return text;
}

function echoHttp(): HttpServer {
  return createHttpServer((req, res) => {
    res.setHeader("content-type", "text/plain");
    res.end(`${req.method} ${req.url} host=${req.headers.host}`);
  });
}

describe("the preview forwarder", () => {
  it("carries an HTTP exchange to a server on loopback after one line", async () => {
    const server = await listen(echoHttp());
    const port = await forwarder();
    const reply = await exchange(
      port,
      `${previewPreface(TOKEN, { open: `localhost:${server}` })}GET /app HTTP/1.1\r\nHost: localhost:${server}\r\nConnection: close\r\n\r\n`,
    );
    expect(reply.startsWith("OK\nHTTP/1.1 200 OK")).toBe(true);
    expect(reply).toContain(`GET /app host=localhost:${server}`);
  });

  it("reaches a server that listens on only one of the loopback families", async () => {
    const v6 = await listen(echoHttp(), "::1").catch(() => undefined);
    const port = await forwarder();
    if (v6 !== undefined) {
      const reply = await exchange(
        port,
        `${previewPreface(TOKEN, { open: `localhost:${v6}` })}GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
      );
      expect(reply).toContain("OK\nHTTP/1.1 200 OK");
    }
    const v4 = await listen(echoHttp());
    const named = await exchange(
      port,
      `${previewPreface(TOKEN, { open: `thema.localhost:${v4}` })}GET / HTTP/1.1\r\nHost: thema.localhost\r\nConnection: close\r\n\r\n`,
    );
    expect(named).toContain("host=thema.localhost");
  });

  it("refuses a wrong token, a malformed line and an overlong one", async () => {
    const port = await forwarder();
    expect(await exchange(port, previewPreface("g".repeat(43), { list: true }))).toBe(
      "NO unauthorized\n",
    );
    expect(await exchange(port, `LOCALDOT-PREVIEW/1 ${TOKEN} OPEN example.com\n`)).toBe(
      "NO bad-request\n",
    );
    expect(await exchange(port, "x".repeat(600))).toBe("NO bad-request\n");
  });

  it("gives up on a connection that never sends its line", async () => {
    const port = await forwarder({ prefaceMs: 50 });
    expect(await exchange(port, "LOCALDOT-PREVIEW/1")).toBe("NO bad-request\n");
  });

  it("never opens localDot's own services, even when they listen", async () => {
    const own = await listen(echoHttp());
    const port = await forwarder({ ownPorts: new Set([own]) });
    expect(await exchange(port, previewPreface(TOKEN, { open: `127.0.0.1:${own}` }))).toBe(
      "NO refused-port\n",
    );
  });

  it("dials the computer's own addresses but no other", async () => {
    const server = await listen(echoHttp());
    const port = await forwarder({ addresses: () => ["127.0.0.1"] });
    expect(dialTarget("10.0.0.5:80", ["127.0.0.1"])).toBeUndefined();
    expect(dialTarget("172.20.0.11:80", ["172.20.0.11"])).toEqual({
      host: "172.20.0.11",
      port: 80,
    });
    expect(await exchange(port, previewPreface(TOKEN, { open: `10.0.0.5:${server}` }))).toBe(
      "NO bad-request\n",
    );
  });

  it("dials the computer's name at its address, and lists it after its addresses", () => {
    expect(dialTarget("3f2a9c1b7d4e:8888", ["172.20.0.11", "3f2a9c1b7d4e"])).toEqual({
      host: "172.20.0.11",
      port: 8888,
    });
    expect(dialTarget("3f2a9c1b7d4e:8888", ["3f2a9c1b7d4e"])).toBeUndefined();
    expect(dialTarget("other-name:8888", ["172.20.0.11", "3f2a9c1b7d4e"])).toBeUndefined();
    expect(ownAddresses("3f2a9c1b7d4e").at(-1)).toBe("3f2a9c1b7d4e");
    expect(ownAddresses("localhost")).not.toContain("localhost");
    expect(ownAddresses("evil.example")).not.toContain("evil.example");
  });

  it("tries both loopback addresses for localhost names, whatever the computer resolves", () => {
    const target = dialTarget("app.localhost:5173", []);
    expect(target).toMatchObject({ host: "localhost", port: 5173 });
    let found: unknown;
    target?.lookup?.("localhost", { all: true }, (_error, all) => {
      found = all;
    });
    expect(found).toEqual([
      { address: "127.0.0.1", family: 4 },
      { address: "::1", family: 6 },
    ]);
  });

  it("says when nothing answers", async () => {
    const closed = await listen(createServer());
    open.pop()?.close();
    const port = await forwarder();
    expect(await exchange(port, previewPreface(TOKEN, { open: `127.0.0.1:${closed}` }))).toBe(
      "NO unreachable\n",
    );
  });

  it("lists listening servers without localDot's own and with the computer's addresses", async () => {
    const port = await forwarder({
      ownPorts: new Set([3000]),
      addresses: () => ["172.20.0.11"],
      listening: async () => [
        { address: "0.0.0.0", port: 3000 },
        { address: "127.0.0.1", port: 5173, name: "node" },
        { address: "::", port: 8000 },
      ],
    });
    const reply = await exchange(port, previewPreface(TOKEN, { list: true }));
    expect(reply.startsWith("OK ")).toBe(true);
    expect(JSON.parse(reply.slice(3))).toEqual({
      listeners: [
        { address: "127.0.0.1", port: 5173, name: "node" },
        { address: "::", port: 8000 },
      ],
      addresses: ["172.20.0.11"],
    });
  });

  it("keeps a long-lived upgraded connection open in both directions", async () => {
    const server = await listen(
      createServer((socket) => {
        socket.on("data", (chunk) => socket.write(`echo:${chunk.toString()}`));
      }),
    );
    const port = await forwarder();
    const socket = connect(port, "127.0.0.1");
    socket.write(previewPreface(TOKEN, { open: `127.0.0.1:${server}` }));
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk.toString();
    });
    await expect.poll(() => text).toBe("OK\n");
    for (const word of ["one", "two"]) {
      socket.write(word);
      await expect.poll(() => text.endsWith(`echo:${word}`)).toBe(true);
    }
    socket.destroy();
  });
});
