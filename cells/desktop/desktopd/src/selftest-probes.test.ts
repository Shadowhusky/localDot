import { execFile } from "node:child_process";
import { promises as dns } from "node:dns";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeProbes } from "./selftest.ts";

const probes = nodeProbes();
const servers: Server[] = [];
const sockets = new Set<Socket>();
afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function listen(server: Server) {
  servers.push(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { host: "127.0.0.1", port: (server.address() as AddressInfo).port };
}

describe("self-test probe boundaries", () => {
  it("retains a DNS answer when the other family hangs, and fails local lookup errors", async () => {
    const cancel = vi.spyOn(dns.Resolver.prototype, "cancel").mockImplementation(() => {});
    vi.spyOn(dns.Resolver.prototype, "resolve4").mockImplementation(async () => ["192.0.2.10"]);
    const v6 = vi
      .spyOn(dns.Resolver.prototype, "resolve6")
      .mockImplementation(() => new Promise(() => {}));
    expect(await probes.resolve("host.example", 20)).toEqual(["192.0.2.10"]);
    expect(cancel).toHaveBeenCalled();
    v6.mockRejectedValue(Object.assign(new Error("local failure"), { code: "EMFILE" }));
    expect(await probes.resolve("host.example", 20)).toBe("EMFILE");
  });

  it.each(["Content-Length: 100\r\n\r\n{}", "Transfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n"])(
    "refuses truncated HTTP framing %#",
    async (reply) => {
      const proxy = await listen(
        createServer((s) => {
          s.once("data", () => s.end(`HTTP/1.1 200 OK\r\n${reply}`));
        }),
      );
      expect(typeof (await probes.proxyGet(proxy, "http://keyd.ldot/health", undefined, 500))).toBe(
        "string",
      );
    },
  );

  it("refuses an oversized response instead of accepting its small valid prefix", async () => {
    const proxy = await listen(
      createServer((s) => {
        s.once("data", () => {
          s.write("HTTP/1.1 200 OK\r\nContent-Length: 70002\r\n\r\n{}");
          const tail = setTimeout(() => s.end(" ".repeat(70_000)), 10);
          s.once("close", () => clearTimeout(tail));
        });
      }),
    );
    expect(await probes.proxyGet(proxy, "http://keyd.ldot/health", undefined, 500)).toBe(
      "proxy response too large",
    );
  });

  it("ends a trickling response at the absolute deadline", async () => {
    const proxy = await listen(
      createServer((s) => {
        s.once("data", () => {
          s.write("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n");
          const trickle = setInterval(() => s.write(" "), 5);
          const end = setTimeout(() => s.end(), 180);
          s.once("close", () => {
            clearInterval(trickle);
            clearTimeout(end);
          });
        });
      }),
    );
    expect(await probes.proxyGet(proxy, "http://keyd.ldot/health", undefined, 40)).toBe("timeout");
  });

  it("contacts its selected proxy even when Node's environment proxy points elsewhere", async () => {
    let gateRequests = 0;
    let trapRequests = 0;
    const gate = await listen(
      httpServer((_req, res) => {
        gateRequests++;
        res.end("gate");
      }),
    );
    const trap = await listen(
      httpServer((_req, res) => {
        trapRequests++;
        res.end("trap");
      }),
    );
    const trapUrl = `http://${trap.host}:${trap.port}`;
    const main = new URL("./selftest.ts", import.meta.url).href;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `import { nodeProbes } from ${JSON.stringify(main)}; console.log(JSON.stringify(await nodeProbes().proxyGet(${JSON.stringify(gate)}, "http://keyd.ldot/health", undefined, 1000)));`,
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        timeout: 5000,
        env: {
          ...process.env,
          NODE_USE_ENV_PROXY: "1",
          HTTP_PROXY: trapUrl,
          http_proxy: trapUrl,
          HTTPS_PROXY: trapUrl,
          https_proxy: trapUrl,
          NO_PROXY: "",
          no_proxy: "",
        },
      },
    );
    expect(JSON.parse(stdout)).toEqual({ status: 200, body: "gate" });
    expect(gateRequests).toBe(1);
    expect(trapRequests).toBe(0);
  });

  it("bounds files read from the cell filesystem", async () => {
    const dir = await mkdtemp(join(tmpdir(), "localdot-selftest-"));
    try {
      const path = join(dir, "bundle");
      await writeFile(path, Buffer.alloc(4 * 1024 * 1024 + 1, "x"));
      expect(await probes.readFile(path)).toBeUndefined();
      expect(await probes.readFile(dir)).toBeUndefined();
      await writeFile(path, "ordinary certificate material");
      expect(await probes.readFile(path)).toBe("ordinary certificate material");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
