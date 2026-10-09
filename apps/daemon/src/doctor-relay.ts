import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import type { DockerClient } from "./cells/docker.ts";
import {
  type GateRelay,
  gateRelayMounts,
  KEYD_RELAY_MOUNT,
  listenOnSocket,
  makeRelayDirs,
} from "./cells/relay.ts";
import { egressNetworkSpec } from "./cells/spec.ts";

export interface RelayVerdict {
  ok: boolean;
  detail: string;
}

export interface RelayProbeDeps {
  docker: Pick<DockerClient, "request">;
  relay: GateRelay;
  home: string;
  // The gate image: the probe runs its socat the way a gate does.
  image: string;
  // Docker from the Snap Store, which can't share hidden folders.
  snap?: boolean;
}

const LABEL = "localdot.doctor-probe";
// One exit code per way socat fails, so the verdict can name it.
export const RELAY_PROBE_SCRIPT = `out=$(timeout 10 socat -u "$1" STDOUT 2>&1)
code=$?
[ "$out" = "$2" ] && exit 0
case "$out" in
  *"ermission denied"*) exit 13 ;;
  *"o such file"*) exit 2 ;;
  *"esolve"*|*"not known"*) exit 6 ;;
  *"efused"*) exit 111 ;;
esac
[ "$code" -ge 124 ] && exit 124
exit 1`;
const NO_ACCESS = "so computers would have no internet or model access.";

// A throwaway container, made like a gate on a network made like a cell's egress network, connects
// to a listener standing in for keyd: on Docker Engine through the mounted relay folder, on Docker
// Desktop through host.docker.internal.
export async function runRelayProbe(d: RelayProbeDeps): Promise<RelayVerdict> {
  const nonce = randomBytes(12).toString("hex");
  const server = createServer((socket) => socket.end(`${nonce}\n`));
  let network: string | undefined;
  let container: string | undefined;
  try {
    const target = await listen(server, d, nonce);
    network = (
      await d.docker.request<{ Id: string }>({
        method: "POST",
        path: "/networks/create",
        body: {
          ...egressNetworkSpec(`localdot-doctor-relay-${nonce}`),
          Labels: { [LABEL]: nonce },
        },
      })
    ).Id;
    let code: number;
    try {
      container = (
        await d.docker.request<{ Id: string }>({
          method: "POST",
          path: "/containers/create",
          query: { name: `localdot-doctor-relay-${nonce}` },
          body: probeSpec(d, network, target, nonce),
        })
      ).Id;
      await d.docker.request({ method: "POST", path: `/containers/${container}/start` });
      const waited = await d.docker.request<{ StatusCode: number }>({
        method: "POST",
        path: `/containers/${container}/wait`,
        timeoutMs: 30_000,
      });
      code = waited.StatusCode;
    } catch (error) {
      if (
        d.relay.kind === "host" ||
        !/mount|bind|no such file|not a directory/i.test(messageOf(error))
      )
        throw error;
      return { ok: false, detail: shareFailure(d, messageOf(error)) };
    }
    return verdict(code, d);
  } catch (error) {
    return { ok: false, detail: `The connection check couldn't run: ${messageOf(error)}` };
  } finally {
    if (container)
      await d.docker
        .request({ method: "DELETE", path: `/containers/${container}`, query: { force: "true" } })
        .catch(() => {});
    if (network)
      await d.docker.request({ method: "DELETE", path: `/networks/${network}` }).catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
}

async function listen(server: Server, d: RelayProbeDeps, nonce: string): Promise<string> {
  if (d.relay.kind === "socket") {
    makeRelayDirs(d.home);
    await listenOnSocket(server, join(d.relay.keydDir, `probe-${nonce}.sock`));
    return `UNIX-CONNECT:${KEYD_RELAY_MOUNT}/probe-${nonce}.sock`;
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no probe port");
  return `TCP4:host.docker.internal:${address.port},connect-timeout=5`;
}

function probeSpec(d: RelayProbeDeps, network: string, target: string, nonce: string) {
  return {
    Image: d.image,
    User: "nobody",
    Entrypoint: ["/bin/sh", "-c", RELAY_PROBE_SCRIPT, "probe", target, nonce],
    Labels: { [LABEL]: nonce },
    HostConfig: {
      NetworkMode: network,
      ...gateRelayMounts(d.relay, false),
      CapDrop: ["ALL"],
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges"],
      Memory: 64 * 1024 ** 2,
      PidsLimit: 64,
    },
  };
}

function verdict(code: number, d: RelayProbeDeps): RelayVerdict {
  if (d.relay.kind === "socket") {
    if (code === 0)
      return {
        ok: true,
        detail: "Computers reach localDot's key service through a shared folder.",
      };
    if (code === 2) return { ok: false, detail: shareFailure(d) };
    const what = `A test computer couldn't connect to localDot's key service in ${d.relay.keydDir}`;
    return {
      ok: false,
      detail:
        code === 13
          ? `${what} (permission denied), ${NO_ACCESS} A security module such as SELinux may be blocking containers from it; sudo journalctl -k | grep -i denied shows what.`
          : `${what}, ${NO_ACCESS} Restart localDot (localdot restart), then run localdot doctor again.`,
    };
  }
  if (code === 0)
    return { ok: true, detail: "Computers reach localDot's key service through Docker Desktop." };
  const what = "A test computer couldn't reach localDot's key service at host.docker.internal";
  return {
    ok: false,
    detail:
      code === 6
        ? `Computers can't find this machine at host.docker.internal, ${NO_ACCESS} Update Docker Desktop, then restart it.`
        : `${what}, ${NO_ACCESS} Restart Docker Desktop; if it still fails, check that no firewall blocks local connections.`,
  };
}

function shareFailure(d: RelayProbeDeps, reason?: string): string {
  const folder = d.relay.kind === "socket" ? d.relay.keydDir : d.home;
  const what = `Docker couldn't share ${folder} with computers${reason ? ` (${reason})` : ""}, ${NO_ACCESS}`;
  return d.snap
    ? `${what} Docker from the Snap Store can't share hidden folders: remove it (sudo snap remove docker) and install Docker Engine from docs.docker.com/engine/install.`
    : `${what} Keep localDot's folder (${d.home}) on a local disk that Docker can read, not a network or encrypted home folder.`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
