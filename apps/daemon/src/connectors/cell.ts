import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { KeydOpened, type LocalServer } from "@localdot/protocol";
import { homeLabel } from "../agent/brain-cell.ts";
import { type DockerClient, DockerError } from "../cells/docker.ts";
import { hostAddress } from "../cells/ipv4.ts";
import { requireNoGateway } from "../cells/orchestrator.ts";
import { type GateRelay, HOST_RELAY } from "../cells/relay.ts";
import type { KeydClient } from "../keyd/client.ts";
import { AttachTransport, attachContainer } from "./attach.ts";
import {
  CONNECTOR_GATE_OFFSET,
  CONNECTOR_OFFSET,
  type ConnectorLayout,
  connectorGateSpec,
  connectorNames,
  connectorNetworkSpecs,
  connectorSpec,
} from "./cell-spec.ts";
import { openConnectorListener } from "./open-listener.ts";

export interface ConnectorCellsDeps {
  docker: Pick<DockerClient, "request" | "socketPath">;
  keyd: Pick<KeydClient, "openCell" | "closeCell">;
  // A keyd listener port no computer or brain holds, and its return.
  ports: { reserve(): number; release(port: number): void };
  images: { connector: string; gate: string };
  home: string;
  relay?: () => Promise<GateRelay>;
  namePrefix?: string;
  attach?: (containerId: string, signal: AbortSignal) => Promise<{ stream: Duplex; head: Buffer }>;
}

export interface ConnectorCell {
  readonly cellId: string;
  readonly transport: AttachTransport;
  close(): Promise<void>;
}

export function connectorImages(env: NodeJS.ProcessEnv = process.env) {
  return {
    connector: env.LOCALDOT_CONNECTOR_IMAGE || "localdot/connector:dev",
    gate: env.LOCALDOT_GATE_IMAGE || "localdot/gate:dev",
  };
}

interface Created {
  kind: "containers" | "networks";
  name: string;
  id?: string;
}
interface NetworkInspect {
  Id: string;
  IPAM?: { Config?: { Subnet?: string; Gateway?: string }[] };
}

export const connectorCellId = (connectorId: string) => `connector-${connectorId}`;

const objectPath = (kind: Created["kind"], name: string, action?: string) =>
  `/${kind}/${encodeURIComponent(name)}${action ? `/${action}` : ""}`;

// Each local connector runs in a cell of its own: an internal network with no way out but its gate,
// which relays keyd's listener for the cell; the program's keys are stand-ins keyd swaps at their
// hosts. Nothing on this Mac is mounted into it.
export class ConnectorCells {
  readonly #home: string;
  readonly #prefix: string;
  constructor(private readonly deps: ConnectorCellsDeps) {
    this.#home = homeLabel(deps.home);
    this.#prefix = deps.namePrefix ?? "localdot-";
  }

  async open(
    connectorId: string,
    server: LocalServer,
    signal: AbortSignal,
  ): Promise<ConnectorCell> {
    // keyd knows the cell by its connector, so a listener an earlier run left is closed first;
    // its Docker objects carry a fresh name each time.
    const cellId = connectorCellId(connectorId);
    const objectsId = `${connectorId}-${randomBytes(4).toString("hex")}`;
    await this.deps.keyd.closeCell(cellId).catch(() => false);
    const secrets = [...new Set(server.env.flatMap((env) => (env.secret ? [env.secret] : [])))];
    const port = this.deps.ports.reserve();
    const layout: ConnectorLayout = {
      cellId,
      connectorId,
      keydPort: port,
      names: connectorNames(objectsId, this.#prefix),
      gateInternalIp: "",
      gateEgressIp: "",
      connectorIp: "",
      home: this.#home,
    };
    const created: Created[] = [];
    let keydOpened = false;
    let stream: Duplex | undefined;
    const cleanup = async () => {
      stream?.destroy();
      for (const object of [...created].reverse())
        await this.deps.docker
          .request({
            method: "DELETE",
            path: objectPath(object.kind, object.id ?? object.name),
            ...(object.kind === "containers" ? { query: { force: "true" } } : {}),
          })
          .catch((error) => {
            if (!(error instanceof DockerError && error.status === 404))
              console.error(`a connector's ${object.kind} could not be removed`);
          });
      if (keydOpened) await this.deps.keyd.closeCell(cellId).catch(() => false);
      this.deps.ports.release(port);
    };
    const create = async (object: Created, body: unknown) => {
      signal.throwIfAborted();
      created.push(object);
      const reply = await this.deps.docker.request<{ Id?: string }>({
        method: "POST",
        path: object.kind === "networks" ? "/networks/create" : "/containers/create",
        ...(object.kind === "containers" ? { query: { name: object.name } } : {}),
        body,
      });
      if (typeof reply?.Id !== "string" || !reply.Id) throw new Error("invalid Docker reply");
      object.id = reply.Id;
    };
    const subnet = async (id: string, isolated = false) => {
      const inspect = await this.deps.docker.request<NetworkInspect>({
        method: "GET",
        path: objectPath("networks", id),
      });
      const value = inspect?.IPAM?.Config?.[0]?.Subnet;
      if (!value) throw new Error("a connector network has no IPv4 subnet");
      if (isolated) requireNoGateway(id, inspect.IPAM?.Config ?? []);
      return value;
    };
    try {
      const networks = connectorNetworkSpecs(layout);
      const internal: Created = { kind: "networks", name: layout.names.internalNetwork };
      const egress: Created = { kind: "networks", name: layout.names.egressNetwork };
      await create(internal, networks.internal);
      await create(egress, networks.egress);
      const internalSubnet = await subnet(internal.id as string, true);
      const egressSubnet = await subnet(egress.id as string);
      layout.gateInternalIp = hostAddress(internalSubnet, CONNECTOR_GATE_OFFSET);
      layout.gateEgressIp = hostAddress(egressSubnet, CONNECTOR_GATE_OFFSET);
      layout.connectorIp = hostAddress(internalSubnet, CONNECTOR_OFFSET);
      signal.throwIfAborted();
      keydOpened = true;
      const opened = KeydOpened.parse(
        await openConnectorListener(this.deps.keyd, { cellId, role: "connector", port, secrets }),
      );
      if (opened.cellId !== cellId || opened.port !== port)
        throw new Error("keyd opened a different listener");
      const surrogates = opened.surrogates ?? {};
      const env: Record<string, string> = {};
      for (const entry of server.env) {
        if (!entry.secret) continue;
        const surrogate = surrogates[entry.secret];
        if (!surrogate) throw new Error("keyd did not hand over the connector's key");
        env[entry.name] = surrogate;
      }
      const relay = await (this.deps.relay?.() ?? HOST_RELAY);
      await create(
        { kind: "containers", name: layout.names.gate },
        connectorGateSpec(layout, this.deps.images.gate, egress.id as string, relay),
      );
      const program: Created = { kind: "containers", name: layout.names.connector };
      await create(
        program,
        connectorSpec(
          layout,
          this.deps.images.connector,
          server,
          { proxyToken: opened.proxyToken, caCertPem: opened.caCertPem, env },
          internal.id as string,
        ),
      );
      await this.deps.docker.request({
        method: "POST",
        path: objectPath("containers", layout.names.gate, "start"),
      });
      await this.deps.docker.request({
        method: "POST",
        path: objectPath("networks", internal.id as string, "connect"),
        body: {
          Container: layout.names.gate,
          EndpointConfig: { IPAMConfig: { IPv4Address: layout.gateInternalIp } },
        },
      });
      signal.throwIfAborted();
      const attach =
        this.deps.attach ??
        ((id: string, s: AbortSignal) => attachContainer(this.deps.docker.socketPath, id, s));
      const attached = await attach(program.id as string, signal);
      stream = attached.stream;
      await this.deps.docker.request({
        method: "POST",
        path: objectPath("containers", layout.names.connector, "start"),
      });
      signal.throwIfAborted();
      const transport = new AttachTransport(attached.stream, attached.head);
      let closing: Promise<void> | undefined;
      return {
        cellId,
        transport,
        close: () => {
          closing ??= cleanup();
          return closing;
        },
      };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  // What an earlier run of the daemon left behind: its connector cells end with it.
  async sweep(): Promise<void> {
    const filters = JSON.stringify({
      label: [`localdot.home=${this.#home}`, "localdot.connector"],
    });
    const containers = await this.deps.docker.request<{ Id: string }[]>({
      method: "GET",
      path: "/containers/json",
      query: { all: "true", filters },
    });
    for (const container of containers ?? [])
      await this.deps.docker
        .request({
          method: "DELETE",
          path: objectPath("containers", container.Id),
          query: { force: "true" },
        })
        .catch(() => {});
    const networks = await this.deps.docker.request<{ Id: string }[]>({
      method: "GET",
      path: "/networks",
      query: { filters },
    });
    for (const network of networks ?? [])
      await this.deps.docker
        .request({ method: "DELETE", path: objectPath("networks", network.Id) })
        .catch(() => {});
  }
}
