import { chmodSync, mkdirSync, rmSync } from "node:fs";
import type { Server } from "node:net";
import { dirname, join } from "node:path";
import { dockerRuntime } from "../platform/docker-runtime.ts";
import type { DockerClient } from "./docker.ts";

// Docker Desktop gives containers the host's loopback as host.docker.internal. Docker Engine has
// no such name, and its containers can't reach 127.0.0.1, so there a gate reaches keyd and the
// daemon's tool API through their Unix sockets in read-only folder mounts (cells/gate/relay.sh).
export type GateRelay = { kind: "host" } | { kind: "socket"; keydDir: string; toolDir: string };

export const HOST_RELAY: GateRelay = { kind: "host" };
export const KEYD_RELAY_MOUNT = "/run/localdot/keyd";
export const TOOL_RELAY_MOUNT = "/run/localdot/tool";
export const TOOL_SOCKET = "tool.sock";

// keyd serves each cell on <home>/keyd/relay/<port>.sock; the daemon its tool API on
// <home>/relay/tool.sock.
export function relayDirs(home: string): { keydDir: string; toolDir: string } {
  return { keydDir: join(home, "keyd", "relay"), toolDir: join(home, "relay") };
}

export function gateRelay(info: unknown, home: string, platform = process.platform): GateRelay {
  if (platform === "darwin" || dockerRuntime(info)?.flavor === "desktop") return HOST_RELAY;
  return { kind: "socket", ...relayDirs(home) };
}

// Asks Docker which kind it is the first time a gate is made, and again after a failed answer.
// Docker refuses to mount a folder that doesn't exist, so both are made before any gate needs them.
export function gateRelaySource(
  docker: Pick<DockerClient, "request">,
  home: string,
  platform = process.platform,
): () => Promise<GateRelay> {
  let known: Promise<GateRelay> | undefined;
  return () => {
    if (platform === "darwin") return Promise.resolve(HOST_RELAY);
    known ??= docker.request<unknown>({ method: "GET", path: "/info" }).then((info) => {
      const relay = gateRelay(info, home, platform);
      if (relay.kind === "socket") makeRelayDirs(home);
      return relay;
    });
    known.catch(() => {
      known = undefined;
    });
    return known;
  };
}

export function makeRelayDirs(home: string): void {
  const { keydDir, toolDir } = relayDirs(home);
  mkdirSync(join(home, "keyd"), { recursive: true, mode: 0o700 });
  for (const dir of [keydDir, toolDir]) {
    try {
      mkdirSync(dir, { mode: 0o711 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  chmodSync(toolDir, 0o711);
}

export function gateRelayEnv(relay: GateRelay, keydPort: number, tool: boolean): string[] {
  if (relay.kind === "host") return [];
  return [
    `LD_KEYD_SOCKET=${KEYD_RELAY_MOUNT}/${keydPort}.sock`,
    ...(tool ? [`LD_TOOL_SOCKET=${TOOL_RELAY_MOUNT}/${TOOL_SOCKET}`] : []),
  ];
}

export function gateRelayMounts(relay: GateRelay, tool: boolean) {
  if (relay.kind === "host") return {};
  return {
    Mounts: [
      { Type: "bind", Source: relay.keydDir, Target: KEYD_RELAY_MOUNT, ReadOnly: true },
      ...(tool
        ? [{ Type: "bind", Source: relay.toolDir, Target: TOOL_RELAY_MOUNT, ReadOnly: true }]
        : []),
    ],
  };
}

// The daemon holds its home's lock, so a socket already at path is a stale one. Gates connect as
// nobody; the tool token guards the API, as on the TCP port.
export async function listenOnSocket(server: Server, path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o711 });
  chmodSync(dirname(path), 0o711);
  rmSync(path, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(path, 0o666);
}
