import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESKTOP_IMAGE } from "./testing/desktop-container.ts";
import {
  DOCKER_TESTS,
  docker,
  dockerExecAs,
  removeAll,
  sleepSync,
  waitFor,
} from "./testing/docker-cli.ts";

// A CONNECT-logging proxy on 127.0.0.1:4798: every outbound TLS attempt from a container that honours
// HTTPS_PROXY shows up as a "CONNECT host:443" line. The driver is Rust/reqwest, which honours the
// variable; the control run proves the method before the opt-out run is trusted. The proxy answers
// from its own thread, because runDriver's Docker calls block this one (spawnSync) while the driver
// runs, and keeps its log until asked for it.
const PROXY_PORT = 4798;
const PROXY = `const { parentPort } = require("node:worker_threads");
const connects = [];
const server = require("node:net").createServer((socket) => {
  socket.once("data", (d) => {
    connects.push(String(d).split("\\r\\n")[0] ?? "");
    socket.end("HTTP/1.1 403 Forbidden\\r\\n\\r\\n");
  });
  socket.on("error", () => {});
});
parentPort.on("message", () => parentPort.postMessage(connects.splice(0)));
server.listen(${PROXY_PORT}, "127.0.0.1", () => parentPort.postMessage("listening"));
`;
let proxy: Worker;

// The CONNECT lines logged since the last call.
async function connectsSince(): Promise<string[]> {
  proxy.postMessage("read");
  const [lines] = await once(proxy, "message");
  return lines as string[];
}

function runDriver(name: string, env: Record<string, string>): string {
  removeAll({ containers: [name] });
  const flags = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--shm-size=1g",
    "--cap-drop",
    "NET_RAW",
    "-e",
    `HTTPS_PROXY=http://host.docker.internal:${PROXY_PORT}`,
    "-e",
    `HTTP_PROXY=http://host.docker.internal:${PROXY_PORT}`,
    "-e",
    "LOCALDOT_DESKTOPD_TOKEN=x".padEnd(60, "x"),
    ...flags,
    DESKTOP_IMAGE,
  );
  waitFor(
    "panel",
    () => dockerExecAs(name, "abc", "pgrep", "-x", "xfce4-panel").status === 0,
    180_000,
  );
  sleepSync(3000);
  const run = dockerExecAs(
    name,
    "abc",
    "env",
    "DISPLAY=:1",
    "DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/localdot-session-bus",
    "sh",
    "-c",
    'timeout 20 cua-driver doctor; timeout 20 cua-driver telemetry status; printf \'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}\\n{"jsonrpc":"2.0","method":"notifications/initialized"}\\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_windows","arguments":{}}}\\n\' | timeout 20 cua-driver mcp --no-overlay | head -c 20000',
  );
  expect(run.status, run.out).toBe(0);
  sleepSync(5000);
  return run.out;
}

// The driver's JSON-RPC replies among the run's output lines.
const replies = (out: string) =>
  out.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line) as { id?: number; result?: unknown; error?: unknown }];
    } catch {
      return [];
    }
  });

describe.skipIf(!DOCKER_TESTS)("Cua Driver telemetry and update checks are off on the wire", () => {
  beforeAll(async () => {
    proxy = new Worker(PROXY, { eval: true });
    await once(proxy, "message");
  });
  afterAll(async () => {
    removeAll({ containers: ["localdot-test-optout-control", "localdot-test-optout"] });
    await proxy?.terminate();
  });

  it("control: with the opt-outs removed the driver tries to phone home through the proxy", async () => {
    runDriver("localdot-test-optout-control", {
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "1",
      CUA_DRIVER_RS_UPDATE_CHECK: "1",
    });
    const connects = await connectsSince();
    const outbound = connects.filter((l) => /posthog|github/i.test(l));
    expect(
      outbound.length,
      `control run saw no telemetry or update traffic (${connects.join(" | ")}): the proxy method cannot confirm the opt-out; trace the driver with strace in a container with CAP_SYS_PTRACE instead`,
    ).toBeGreaterThan(0);
  });

  it("with the image's opt-outs the driver sends nothing", async () => {
    const out = runDriver("localdot-test-optout", {});
    // The driver ran for real: it answered the list_windows call (JSON-RPC id 2) with a result.
    expect(replies(out).find((r) => r.id === 2)?.result, out).toBeDefined();
    expect((await connectsSince()).filter((l) => /posthog|github/i.test(l))).toEqual([]);
  });
});
