import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingHttpHeaders, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { hostAddress } from "../cells/ipv4.ts";
import {
  DOCKER_TESTS,
  docker,
  dockerExec,
  publishedPort,
  removeAll,
  subnetOf,
  waitFor,
} from "../cells/testing/docker-cli.ts";
import { type CellEndpoints, type CellSummary, NO_STREAM } from "../cells/types.ts";
import { previewFronts } from "./fronts.ts";
import { Previews } from "./previews.ts";
import { listServers } from "./tunnel.ts";

// A desktop and its gate as the daemon wires them, a Vite-like server with hot reload and a
// Portless-like HTTPS server inside, and the daemon's preview listener on this Mac's loopback.
const DESKTOP_IMAGE = process.env.LOCALDOT_DESKTOP_IMAGE || "localdot/desktop:dev";
const GATE_IMAGE = process.env.LOCALDOT_GATE_IMAGE || "localdot/gate:dev";
// A gate image from before previews, to check that its computer is asked to update.
const OLD_GATE_IMAGE = process.env.LOCALDOT_OLD_GATE_IMAGE;
const names = {
  containers: [
    "localdot-test-preview-desktop",
    "localdot-test-preview-gate",
    "localdot-test-preview-oldgate",
  ],
  networks: ["localdot-test-preview-sbx", "localdot-test-preview-egress"],
};
const TOKEN = "d".repeat(43);
const CELL = "01JXYZ0000000000000000CELL";
const TASK = "01JXYZ0000000000000000TASK";
const FRONT = "100.64.0.7";
const ASKED = `${FRONT}:4744`;

// Vite answers only its own names and opens its hot-reload socket only for its own pages; the
// HTTPS server answers any *.localhost name, as Portless does.
const SERVERS = String.raw`
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttps } from "node:https";

const sockets = new Set();
const frame = (text) => {
  const body = Buffer.from(text);
  return Buffer.concat([Buffer.from([0x81, body.length]), body]);
};
const unmask = (data) => {
  const length = data[1] & 0x7f;
  const mask = data.subarray(2, 6);
  return Buffer.from(data.subarray(6, 6 + length).map((b, i) => b ^ mask[i % 4])).toString();
};
const accept = (req, socket, protocol) => {
  const key = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + key + "\r\n" + (protocol ? "Sec-WebSocket-Protocol: " + protocol + "\r\n" : "") + "\r\n");
  socket.on("error", () => {});
};
const own = (host) => /^(localhost|127\.0\.0\.1):5173$/.test(host ?? "");
const vite = createServer((req, res) => {
  if (!own(req.headers.host)) {
    res.writeHead(403);
    return res.end("Blocked request. This host is not allowed.");
  }
  if (req.url === "/") {
    res.setHeader("content-type", "text/html");
    return res.end('<!doctype html><script type="module" src="/src/main.js"></script><div id="app"></div>');
  }
  if (req.url === "/src/main.js") {
    res.setHeader("content-type", "text/javascript");
    return res.end("new WebSocket('ws://' + location.host + '/', 'vite-hmr');");
  }
  if (req.url === "/old") {
    res.writeHead(302, { location: "http://localhost:5173/new" });
    return res.end();
  }
  if (req.url === "/__update") {
    for (const socket of sockets) socket.write(frame('{"type":"update","path":"/src/main.js"}'));
    return res.end("sent");
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ url: req.url, host: req.headers.host, origin: req.headers.origin ?? null }));
});
vite.on("upgrade", (req, socket) => {
  if (req.headers.origin !== "http://localhost:5173" || req.headers["sec-websocket-protocol"] !== "vite-hmr" || !own(req.headers.host)) {
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  accept(req, socket, "vite-hmr");
  sockets.add(socket);
  socket.write(frame('{"type":"connected"}'));
  socket.on("data", (data) => socket.write(frame("echo:" + unmask(data))));
  socket.on("close", () => sockets.delete(socket));
});
// As Vite does by default: Node picks the address localhost names, often ::1 alone.
vite.listen(5173, "localhost");

execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=thema.localhost",
  "-addext", "subjectAltName=DNS:thema.localhost,DNS:localhost", "-keyout", "/tmp/preview-key.pem", "-out", "/tmp/preview-cert.pem"], { stdio: "ignore" });
const secure = createHttps({ key: readFileSync("/tmp/preview-key.pem"), cert: readFileSync("/tmp/preview-cert.pem") }, (req, res) =>
  res.end("secure " + req.headers.host + " " + req.socket.servername));
secure.on("upgrade", (req, socket) => {
  accept(req, socket);
  socket.write(frame("live " + req.headers.host));
});
secure.listen(1355, "127.0.0.1");
`;

let previews: Previews;
let previewPort = 0;
let scratch = "";

function send(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = "GET",
  body?: string,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
      );
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function signIn(link: string) {
  const url = new URL(link);
  const answer = await send(
    Number(url.port),
    url.pathname,
    { host: url.host, origin: `https://${url.host}`, "content-type": "text/plain" },
    "POST",
    url.hash.slice(1),
  );
  expect(answer.status).toBe(200);
  return {
    port: Number(url.port),
    host: url.host,
    next: (JSON.parse(answer.body) as { next: string }).next,
    cookie: String(answer.headers["set-cookie"]?.[0]).split(";")[0] ?? "",
  };
}

function gate(name: string, image: string, egress: string, internal: string, desktop: string) {
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--network",
    "localdot-test-preview-egress",
    "--ip",
    egress,
    ...["-p", "127.0.0.1:0:8081", "-p", "127.0.0.1:0:8082", "-p", "127.0.0.1:0:8083"],
    ...["--cap-drop", "ALL", "--read-only", "--security-opt", "no-new-privileges"],
    ...["--memory", "128m", "--pids-limit", "320"],
    ...["-e", `LD_INTERNAL_ADDR=${internal}`, "-e", `LD_EGRESS_ADDR=${egress}`],
    ...["-e", `LD_DESKTOP_ADDR=${desktop}`, "-e", "LD_KEYD_PORT=4799", "-e", "LD_PREVIEWS=1"],
    image,
  );
  docker("network", "connect", "--ip", internal, "localdot-test-preview-sbx", name);
  return publishedPort(name, "8083");
}

describe.skipIf(!DOCKER_TESTS)("previews of servers in a desktop, through its gate", () => {
  let cells: ReturnType<typeof fakeCells>;

  beforeAll(async () => {
    removeAll(names);
    for (const name of names.networks) docker("network", "create", name);
    const internalSubnet = subnetOf("localdot-test-preview-sbx");
    const egressSubnet = subnetOf("localdot-test-preview-egress");
    for (const name of names.networks) docker("network", "rm", name);
    docker(
      "network",
      "create",
      "--subnet",
      internalSubnet,
      "--internal",
      "-o",
      "com.docker.network.bridge.gateway_mode_ipv4=isolated",
      "localdot-test-preview-sbx",
    );
    docker("network", "create", "--subnet", egressSubnet, "localdot-test-preview-egress");
    const desktopIp = hostAddress(internalSubnet, 11);
    docker(
      "run",
      "-d",
      "--name",
      "localdot-test-preview-desktop",
      "--network",
      "localdot-test-preview-sbx",
      "--ip",
      desktopIp,
      "--shm-size=1g",
      "--memory",
      "3g",
      "--tmpfs",
      "/run/localdot-desktop-browser:rw,nosuid,nodev,noexec,size=256m,uid=1000,gid=1000,mode=0700",
      ...["-e", `LOCALDOT_DESKTOPD_TOKEN=${TOKEN}`, "-e", "PASSWORD=preview-fixture-password"],
      ...["-e", "PUID=1000", "-e", "PGID=1000"],
      DESKTOP_IMAGE,
    );
    previewPort = gate(
      "localdot-test-preview-gate",
      GATE_IMAGE,
      hostAddress(egressSubnet, 10),
      hostAddress(internalSubnet, 10),
      desktopIp,
    );
    scratch = mkdtempSync(join(tmpdir(), "localdot-preview-docker-"));
    writeFileSync(join(scratch, "servers.mjs"), SERVERS);
    docker("cp", join(scratch, "servers.mjs"), "localdot-test-preview-desktop:/tmp/servers.mjs");
    waitFor(
      "desktopd",
      () =>
        dockerExec(
          "localdot-test-preview-desktop",
          "curl",
          "-sf",
          "-o",
          "/dev/null",
          "-H",
          `Authorization: Bearer ${TOKEN}`,
          "http://127.0.0.1:7700/healthz",
        ).status === 0,
      180_000,
    );
    docker(
      "exec",
      "-d",
      "-u",
      "abc",
      "localdot-test-preview-desktop",
      "/opt/node/bin/node",
      "/tmp/servers.mjs",
    );
    cells = fakeCells(previewPort);
    previews = new Previews({
      range: { from: 4931, to: 4934 },
      cells,
      cellOf: (id) => (id === TASK ? CELL : undefined),
      fronts: async () => previewFronts([`https://${ASKED}`]),
    });
    for (let i = 0; i < 100; i++) {
      const listing = await listServers({ port: previewPort, token: TOKEN }).catch(() => undefined);
      if (
        listing?.listeners.some((l) => l.port === 5173) &&
        listing.listeners.some((l) => l.port === 1355)
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  });

  afterAll(async () => {
    await previews?.close();
    removeAll(names);
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("lists the servers inside, without localDot's own", async () => {
    const status = await previews.status(TASK, ASKED);
    expect(status.state).toBe("ready");
    expect(status.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ port: 1355, url: "https://localhost:1355/", state: "answering" }),
        expect.objectContaining({ port: 5173, url: "http://localhost:5173/", state: "answering" }),
      ]),
    );
    const ports = status.servers.map((server) => server.port);
    for (const own of [3000, 3001, 3129, 7700, 7701, 8082]) expect(ports).not.toContain(own);
    expect(status.addresses).toContain(
      docker(
        "inspect",
        "-f",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        "localdot-test-preview-desktop",
      ),
    );
  });

  it("opens a Vite-like app with its modules, redirects and hot reload", async () => {
    const opened = await previews.open(TASK, { url: "http://localhost:5173/" }, ASKED);
    const device = await signIn(opened.open);
    const headers = { host: device.host, cookie: device.cookie };
    const page = await send(device.port, device.next, headers);
    expect(page.status, page.body).toBe(200);
    expect(page.body).toContain('<script type="module" src="/src/main.js">');
    expect((await send(device.port, "/src/main.js", headers)).body).toContain("vite-hmr");
    const echo = JSON.parse(
      (await send(device.port, "/api/x", { ...headers, origin: `https://${device.host}` })).body,
    );
    expect(echo).toEqual({
      url: "/api/x",
      host: "localhost:5173",
      origin: "http://localhost:5173",
    });
    const moved = await send(device.port, "/old", headers);
    expect(moved.status).toBe(302);
    expect(moved.headers.location).toBe(`https://${device.host}/new`);

    const socket = new WebSocket(`ws://127.0.0.1:${device.port}/`, "vite-hmr", {
      headers: { ...headers, origin: `https://${device.host}` },
    });
    const messages: string[] = [];
    socket.on("message", (data) => messages.push(String(data)));
    await once(socket, "open");
    await expect.poll(() => messages).toEqual(['{"type":"connected"}']);
    expect((await send(device.port, "/__update", headers)).body).toBe("sent");
    await expect.poll(() => messages.at(-1)).toBe('{"type":"update","path":"/src/main.js"}');
    socket.send("ping");
    await expect.poll(() => messages.at(-1)).toBe("echo:ping");
    socket.close();
  });

  it("keeps up with a page that loads many modules at once", async () => {
    const opened = await previews.open(TASK, { url: "http://localhost:5173/" }, ASKED);
    const device = await signIn(opened.open);
    const answers = await Promise.all(
      Array.from({ length: 120 }, (_, i) =>
        send(device.port, `/module-${i}.js`, { host: device.host, cookie: device.cookie }),
      ),
    );
    expect(answers.every((answer) => answer.status === 200)).toBe(true);
  });

  it("opens a *.localhost HTTPS server with its secure live updates", async () => {
    const opened = await previews.open(TASK, { url: "https://thema.localhost:1355/" }, ASKED);
    const device = await signIn(opened.open);
    const page = await send(device.port, "/", { host: device.host, cookie: device.cookie });
    expect(page.body).toBe("secure thema.localhost:1355 thema.localhost");
    const socket = new WebSocket(`ws://127.0.0.1:${device.port}/live`, {
      headers: { host: device.host, cookie: device.cookie, origin: `https://${device.host}` },
    });
    const [message] = await once(socket, "message");
    expect(String(message)).toBe("live thema.localhost:1355");
    socket.close();
  });

  it("never opens localDot's own services", async () => {
    // The computer never lists them, so there is nothing running there to open.
    await expect(
      previews.open(TASK, { url: "http://localhost:7700/healthz" }, ASKED),
    ).rejects.toMatchObject({ status: 409 });
  });

  it.skipIf(!OLD_GATE_IMAGE)(
    "asks to update a computer whose gate is from before previews",
    async () => {
      const internal = subnetOf("localdot-test-preview-sbx");
      const egress = subnetOf("localdot-test-preview-egress");
      const old = gate(
        "localdot-test-preview-oldgate",
        OLD_GATE_IMAGE as string,
        hostAddress(egress, 20),
        hostAddress(internal, 20),
        hostAddress(internal, 11),
      );
      const before = new Previews({
        range: { from: 4935, to: 4935 },
        cells: fakeCells(old),
        cellOf: () => CELL,
        fronts: async () => previewFronts([`https://${ASKED}`]),
      });
      try {
        expect(await before.status(TASK, ASKED)).toMatchObject({ state: "needs-update" });
      } finally {
        await before.close();
      }
    },
  );
});

function fakeCells(port: number) {
  const summary: CellSummary = {
    id: CELL,
    state: "ready",
    scale: 2,
    createdAt: "2026-10-22T00:00:00.000Z",
    stream: NO_STREAM,
  };
  return {
    get: (id: string) => (id === CELL ? summary : undefined),
    endpoints: (id: string): CellEndpoints | undefined =>
      id === CELL
        ? {
            desktopd: { baseUrl: "http://127.0.0.1:1", token: TOKEN },
            stream: { baseUrl: "http://127.0.0.1:2", authorization: "Basic x" },
            preview: { port, token: TOKEN },
          }
        : undefined,
    subscribe: () => () => {},
  };
}
