import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brainGateSpec } from "../agent/brain-spec.ts";
import {
  gateRelay,
  gateRelaySource,
  HOST_RELAY,
  listenOnSocket,
  makeRelayDirs,
  relayDirs,
} from "./relay.ts";
import { gateSpec } from "./spec.ts";
import { sampleRecord } from "./testing/sample-record.ts";

const desktopInfo = { OperatingSystem: "Docker Desktop", SecurityOptions: [] };
const engineInfo = { OperatingSystem: "Ubuntu 24.04.1 LTS", SecurityOptions: ["name=apparmor"] };
const rootlessInfo = { OperatingSystem: "Ubuntu 24.04.1 LTS", SecurityOptions: ["name=rootless"] };

// macOS caps a socket path at 104 bytes, so the folder stays short.
const dirs: string[] = [];
function home() {
  const dir = mkdtempSync("/tmp/ld-relay-");
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("gateRelay", () => {
  it("uses Docker Desktop's host name, and the sockets on Docker Engine", () => {
    expect(gateRelay(engineInfo, "/h", "darwin")).toEqual(HOST_RELAY);
    expect(gateRelay(desktopInfo, "/h", "linux")).toEqual(HOST_RELAY);
    const socket = { kind: "socket", keydDir: "/h/keyd/relay", toolDir: "/h/relay" };
    expect(gateRelay(engineInfo, "/h", "linux")).toEqual(socket);
    expect(gateRelay(rootlessInfo, "/h", "linux")).toEqual(socket);
  });

  it("asks Docker once, again after a failure, and makes the folders before any gate", async () => {
    const dir = home();
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("docker is starting"))
      .mockResolvedValue(engineInfo);
    const relay = gateRelaySource({ request }, dir, "linux");
    await expect(relay()).rejects.toThrow("docker is starting");
    expect(await relay()).toMatchObject({ kind: "socket" });
    expect(await relay()).toMatchObject({ kind: "socket" });
    expect(request).toHaveBeenCalledTimes(2);
    const { keydDir, toolDir } = relayDirs(dir);
    expect(statSync(keydDir).isDirectory()).toBe(true);
    expect(statSync(toolDir).mode & 0o777).toBe(0o711);
    expect(statSync(join(dir, "keyd")).mode & 0o777).toBe(0o700);
  });

  it("never asks Docker on macOS", async () => {
    const request = vi.fn();
    expect(await gateRelaySource({ request }, "/h", "darwin")()).toEqual(HOST_RELAY);
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps folders that exist", () => {
    const dir = home();
    mkdirSync(relayDirs(dir).toolDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(relayDirs(dir).toolDir, "keep"), "");
    makeRelayDirs(dir);
    makeRelayDirs(dir);
    expect(statSync(join(relayDirs(dir).toolDir, "keep")).isFile()).toBe(true);
    expect(statSync(relayDirs(dir).toolDir).mode & 0o777).toBe(0o711);
  });
});

describe("gate specs", () => {
  const record = sampleRecord("01JXYZ0000000000000000ABCD");
  const socket = gateRelay(engineInfo, "/h", "linux");

  it("are unchanged on Docker Desktop", () => {
    expect(gateSpec(record, "g", HOST_RELAY)).toEqual(gateSpec(record, "g"));
    expect("Mounts" in gateSpec(record, "g").HostConfig).toBe(false);
  });

  it("mount keyd's relay folder read-only and name the cell's socket on Docker Engine", () => {
    const spec = gateSpec(record, "g", socket);
    expect(spec.Env).toContain("LD_KEYD_SOCKET=/run/localdot/keyd/4760.sock");
    expect(spec.HostConfig.Mounts).toEqual([
      { Type: "bind", Source: "/h/keyd/relay", Target: "/run/localdot/keyd", ReadOnly: true },
    ]);
    expect(spec.HostConfig).toMatchObject({ CapDrop: ["ALL"], ReadonlyRootfs: true });
  });

  it("give a brain's gate the tool API's folder as well", () => {
    const layout = {
      id: "b1",
      sessionId: "s1",
      keydPort: 4770,
      names: { internalNetwork: "i", egressNetwork: "e", gate: "g", brain: "b" },
      gateInternalIp: "172.30.4.10",
      gateEgressIp: "172.30.5.10",
      brainIp: "172.30.4.11",
      home: "/h",
    };
    const spec = brainGateSpec(layout, "g", 4999, "e", socket);
    expect(spec.Env).toEqual(
      expect.arrayContaining([
        "LD_KEYD_SOCKET=/run/localdot/keyd/4770.sock",
        "LD_TOOL_SOCKET=/run/localdot/tool/tool.sock",
      ]),
    );
    expect(spec.HostConfig.Mounts).toEqual([
      { Type: "bind", Source: "/h/keyd/relay", Target: "/run/localdot/keyd", ReadOnly: true },
      { Type: "bind", Source: "/h/relay", Target: "/run/localdot/tool", ReadOnly: true },
    ]);
    expect("Mounts" in brainGateSpec(layout, "g", 4999, "e").HostConfig).toBe(false);
  });
});

describe("listenOnSocket", () => {
  it("replaces a stale socket and lets anyone who can reach the folder connect", async () => {
    const { toolDir } = relayDirs(home());
    mkdirSync(toolDir, { recursive: true });
    const path = join(toolDir, "tool.sock");
    writeFileSync(path, "stale");
    const server = createServer((socket) => socket.end("hello"));
    await listenOnSocket(server, path);
    try {
      expect(statSync(path).isSocket()).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o666);
      const reply = await new Promise<string>((resolve, reject) => {
        let text = "";
        connect(path)
          .on("data", (chunk) => {
            text += chunk;
          })
          .on("end", () => resolve(text))
          .on("error", reject);
      });
      expect(reply).toBe("hello");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
