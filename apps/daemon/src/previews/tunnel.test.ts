import { once } from "node:events";
import { type AddressInfo, createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createPreviewForwarder } from "../../../../cells/desktop/desktopd/src/preview-forwarder.ts";
import { ForwarderMissing, ForwarderRefused, listServers, openTunnel } from "./tunnel.ts";

const TOKEN = "t".repeat(43);
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

const forwarder = (listening = async () => [] as { address: string; port: number }[]) =>
  listen(
    createPreviewForwarder({
      token: TOKEN,
      addresses: () => ["172.20.0.11"],
      ownPorts: new Set([7700]),
      listening,
    }),
  );

describe("the daemon's side of the preview forwarder", () => {
  it("opens a connection that carries the server's bytes, greeting included", async () => {
    const server = await listen(
      createServer((socket) => {
        socket.write("hello\n");
        socket.on("data", (chunk) => socket.write(`echo:${chunk}`));
      }),
    );
    const socket = await openTunnel(
      { port: await forwarder(), token: TOKEN },
      `localhost:${server}`,
    );
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk;
    });
    socket.resume();
    socket.write("ping");
    await expect.poll(() => text).toBe("hello\necho:ping");
    socket.destroy();
  });

  it("reports the forwarder's refusals by reason", async () => {
    const port = await forwarder();
    await expect(openTunnel({ port, token: TOKEN }, "localhost:7700")).rejects.toEqual(
      new ForwarderRefused("refused-port"),
    );
    await expect(openTunnel({ port, token: "u".repeat(43) }, "localhost:1")).rejects.toEqual(
      new ForwarderRefused("unauthorized"),
    );
    const closed = await listen(createServer());
    servers.pop()?.close();
    await expect(openTunnel({ port, token: TOKEN }, `127.0.0.1:${closed}`)).rejects.toEqual(
      new ForwarderRefused("unreachable"),
    );
  });

  it("tells a missing forwarder from a hung one", async () => {
    const silent = await listen(createServer((socket) => socket.end()));
    const missing = await openTunnel({ port: silent, token: TOKEN }, "localhost:80").catch(
      (error: unknown) => error,
    );
    expect(missing).toBeInstanceOf(ForwarderMissing);
    expect((missing as ForwarderMissing).silent).toBe(true);
    const hung = await listen(createServer(() => {}));
    const slow = await openTunnel({ port: hung, token: TOKEN }, "localhost:80", 100).catch(
      (error: unknown) => error,
    );
    expect((slow as ForwarderMissing).silent).toBe(false);
  });

  it("lists the computer's servers", async () => {
    const port = await forwarder(async () => [
      { address: "0.0.0.0", port: 5173, name: "node" },
      { address: "0.0.0.0", port: 7700 },
    ]);
    expect(await listServers({ port, token: TOKEN })).toEqual({
      listeners: [{ address: "0.0.0.0", port: 5173, name: "node" }],
      addresses: ["172.20.0.11"],
    });
  });
});
