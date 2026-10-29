import { isDeepStrictEqual as equal } from "node:util";
import {
  CANARY_ROLES,
  CanaryOperation,
  canaryResourceName,
} from "../../../../packages/protocol/src/canary-operation.ts";
import { CanaryReady } from "../../../../packages/protocol/src/canary-process.ts";
import { hostAddress } from "../../../daemon/src/cells/ipv4.ts";
import {
  DESKTOP_OFFSET,
  GATE_OFFSET,
  GATE_PORTS,
  gatePorts,
} from "../../../daemon/src/cells/spec.ts";
import type { CellRecord } from "../../../daemon/src/cells/types.ts";
import { imageVerdict } from "../../../daemon/src/doctor-image.ts";
import type { CanaryCleanupClient } from "./canary-cleanup.ts";
import type { CanaryOperationJournal } from "./canary-operation.ts";
import {
  canaryCellRecord,
  canaryNames,
  canaryObject,
  inspectCanaryContainer,
  inspectCanaryHome,
  inspectCanaryNetwork,
} from "./canary-topology-spec.ts";

export interface CanaryTopologyClient extends Pick<CanaryCleanupClient, "engine" | "inspect"> {
  image(role: "desktop" | "gate", signal: AbortSignal): Promise<unknown>;
  createNetwork(role: "internal" | "egress", signal: AbortSignal): Promise<unknown>;
  createHome(signal: AbortSignal): Promise<unknown>;
  createContainer(
    role: "desktop" | "gate",
    record: CellRecord,
    signal: AbortSignal,
  ): Promise<unknown>;
  wireDesktop(id: string, ready: CanaryReady, signal: AbortSignal): Promise<void>;
  start(id: string, signal: AbortSignal): Promise<void>;
  connect(networkId: string, gateId: string, address: string, signal: AbortSignal): Promise<void>;
}
const failure = () => new Error("The diagnostic computer could not be prepared reliably.");
function fullId(reply: unknown) {
  if (!canaryObject(reply) || typeof reply.Id !== "string" || !/^[a-f0-9]{64}$/.test(reply.Id))
    throw failure();
  return reply.Id;
}

/** Use only inside withCanaryOperation + withCanaryProcess, with the verified image pins already
 * in the journal. This provisions the real desktop/gate topology, not a canary verdict. Outer
 * scopes retain the helper/directory and retire all recorded or uncertain effects on failure.
 */
export async function createCanaryTopology(
  journal: CanaryOperationJournal,
  hello: CanaryReady,
  client: CanaryTopologyClient,
  signal: AbortSignal,
) {
  try {
    return await prepare();
  } catch {
    throw failure();
  }
  async function prepare() {
    const operation = CanaryOperation.parse(journal.snapshot()),
      ready = CanaryReady.parse(hello);
    if (
      operation.phase !== "active" ||
      operation.runId !== ready.runId ||
      operation.cellId !== ready.cellId ||
      Object.values(operation.resources).some((v) => v !== null && v !== false)
    )
      throw failure();
    const names = canaryNames(operation);
    async function engine() {
      signal.throwIfAborted();
      const value = await client.engine(signal);
      if (
        value.id !== operation.engineId ||
        value.operatingSystem !== "linux" ||
        value.architecture !== "arm64"
      )
        throw failure();
    }
    async function image(role: "desktop" | "gate") {
      const value = await client.image(role, signal);
      if (
        !canaryObject(value) ||
        value.Id !== operation.images[role].id ||
        !imageVerdict(operation.images[role].ref, { Os: "linux", Arch: "arm64" }, value).ok
      )
        throw failure();
      return value;
    }
    await engine();
    await image("desktop");
    await image("gate");
    for (const role of CANARY_ROLES) {
      if ((await client.inspect(role, canaryResourceName(operation.runId, role), signal)) !== null)
        throw failure();
    }
    async function network(role: "internal" | "egress") {
      await engine();
      const id = fullId(await client.createNetwork(role, signal));
      await journal.capture(role, id);
      const subnet = inspectCanaryNetwork(
        operation,
        role,
        await client.inspect(role, id, signal),
        id,
        true,
      );
      return { id, subnet };
    }
    const internal = await network("internal"),
      egress = await network("egress");
    if (internal.id === egress.id) throw failure();
    const record = canaryCellRecord(operation, ready, internal.subnet.cidr, egress.subnet.cidr);
    await engine();
    inspectCanaryHome(operation, await client.createHome(signal));
    await journal.capture("home", true);
    inspectCanaryHome(operation, await client.inspect("home", names.homeVolume, signal));
    const ids = { gate: "", desktop: "" };
    for (const role of ["gate", "desktop"] as const) {
      await engine();
      const base = await image(role);
      const id = fullId(await client.createContainer(role, record, signal));
      if (Object.values(ids).includes(id)) throw failure();
      await journal.capture(role, id);
      ids[role] = id;
      inspectCanaryContainer(
        operation,
        record,
        role,
        await client.inspect(role, id, signal),
        id,
        false,
        base,
      );
    }
    record.ownership = {
      gate: ids.gate,
      desktop: ids.desktop,
      internalNetwork: internal.id,
      egressNetwork: egress.id,
    };
    async function inspect(role: "desktop" | "gate", running: boolean) {
      const base = await image(role);
      return inspectCanaryContainer(
        operation,
        record,
        role,
        await client.inspect(role, ids[role], signal),
        ids[role],
        running,
        base,
      );
    }
    await engine();
    await inspect("desktop", false);
    // Fixed regular files only; the synthetic upstream secret is deliberately not uploaded.
    await client.wireDesktop(ids.desktop, ready, signal);
    await engine();
    await inspect("gate", false);
    const beforeStartNetwork = await client.inspect("internal", internal.id, signal);
    inspectCanaryNetwork(operation, "internal", beforeStartNetwork, internal.id, false);
    if (
      !canaryObject(beforeStartNetwork) ||
      !canaryObject(beforeStartNetwork.Containers) ||
      Object.keys(beforeStartNetwork.Containers).some((id) => id !== ids.gate && id !== ids.desktop)
    )
      throw failure();
    await client.start(ids.gate, signal);
    await inspect("gate", true);
    await engine();
    await client.connect(internal.id, ids.gate, record.docker.gateInternalIp, signal);
    await inspect("gate", true);
    await engine();
    await inspect("desktop", false);
    await client.start(ids.desktop, signal);
    const ports = await inspectRunningCanaryTopology(journal.snapshot(), record, client, signal);
    await engine();
    const final = journal.snapshot();
    if (
      !equal(final, {
        ...operation,
        resources: {
          desktop: ids.desktop,
          gate: ids.gate,
          internal: internal.id,
          egress: egress.id,
          home: true,
        },
      })
    )
      throw failure();
    signal.throwIfAborted();
    return { record, ports };
  }
}

/** Fresh read-only proof of the exact running diagnostic topology. Used before
 * and after contacting its published loopback service during boot readiness. */
export async function inspectRunningCanaryTopology(
  input: CanaryOperation,
  inputRecord: CellRecord,
  client: Pick<CanaryTopologyClient, "engine" | "image" | "inspect">,
  signal: AbortSignal,
) {
  const operation = CanaryOperation.parse(input),
    record = structuredClone(inputRecord);
  const {
    desktop: desktopId,
    gate: gateId,
    internal: internalId,
    egress: egressId,
    home,
  } = operation.resources;
  if (
    operation.phase !== "active" ||
    !desktopId ||
    !gateId ||
    !internalId ||
    !egressId ||
    !home ||
    new Set([desktopId, gateId, internalId, egressId]).size !== 4 ||
    !equal(record.ownership, {
      desktop: desktopId,
      gate: gateId,
      internalNetwork: internalId,
      egressNetwork: egressId,
    })
  )
    throw failure();
  const ids = { desktop: desktopId, gate: gateId },
    names = canaryNames(operation);
  async function engine() {
    signal.throwIfAborted();
    const value = await client.engine(signal);
    if (
      value.id !== operation.engineId ||
      value.operatingSystem !== "linux" ||
      value.architecture !== "arm64"
    )
      throw failure();
  }
  async function inspect(role: "desktop" | "gate", running: boolean) {
    const image = await client.image(role, signal);
    if (
      !canaryObject(image) ||
      image.Id !== operation.images[role].id ||
      !imageVerdict(operation.images[role].ref, { Os: "linux", Arch: "arm64" }, image).ok
    )
      throw failure();
    return inspectCanaryContainer(
      operation,
      record,
      role,
      await client.inspect(role, ids[role], signal),
      ids[role],
      running,
      image,
    );
  }
  await engine();
  const internal = {
    id: internalId,
    subnet: inspectCanaryNetwork(
      operation,
      "internal",
      await client.inspect("internal", internalId, signal),
      internalId,
      false,
    ),
  };
  const egress = {
    id: egressId,
    subnet: inspectCanaryNetwork(
      operation,
      "egress",
      await client.inspect("egress", egressId, signal),
      egressId,
      false,
    ),
  };
  if (
    (internal.subnet.base <= egress.subnet.end && egress.subnet.base <= internal.subnet.end) ||
    record.docker.desktopIp !== hostAddress(internal.subnet.cidr, DESKTOP_OFFSET) ||
    record.docker.gateInternalIp !== hostAddress(internal.subnet.cidr, GATE_OFFSET) ||
    record.docker.gateEgressIp !== hostAddress(egress.subnet.cidr, GATE_OFFSET)
  )
    throw failure();
  inspectCanaryHome(operation, await client.inspect("home", names.homeVolume, signal));
  const gate = await inspect("gate", true),
    desktop = await inspect("desktop", true);
  function endpoints(
    raw: Record<string, unknown>,
    wanted: Record<string, { id: string; address: string }>,
  ) {
    if (
      !canaryObject(raw.NetworkSettings) ||
      !canaryObject(raw.NetworkSettings.Networks) ||
      Object.keys(raw.NetworkSettings.Networks).sort().join() !== Object.keys(wanted).sort().join()
    )
      throw failure();
    for (const [name, expected] of Object.entries(wanted)) {
      const actual = raw.NetworkSettings.Networks[name];
      if (
        !canaryObject(actual) ||
        actual.NetworkID !== expected.id ||
        actual.IPAddress !== expected.address ||
        actual.GlobalIPv6Address !== ""
      )
        throw failure();
    }
  }
  endpoints(gate, {
    [names.internalNetwork]: { id: internal.id, address: record.docker.gateInternalIp },
    [names.egressNetwork]: { id: egress.id, address: record.docker.gateEgressIp },
  });
  endpoints(desktop, {
    [names.internalNetwork]: { id: internal.id, address: record.docker.desktopIp },
  });
  for (const [role, made, expected] of [
    ["internal", internal, [ids.desktop, ids.gate]],
    ["egress", egress, [ids.gate]],
  ] as const) {
    const raw = await client.inspect(role, made.id, signal);
    const subnet = inspectCanaryNetwork(operation, role, raw, made.id, false);
    if (
      !equal(subnet, made.subnet) ||
      !canaryObject(raw) ||
      !canaryObject(raw.Containers) ||
      Object.keys(raw.Containers).sort().join() !== [...expected].sort().join()
    )
      throw failure();
  }
  if (!canaryObject(gate.NetworkSettings) || !canaryObject(gate.NetworkSettings.Ports))
    throw failure();
  const published = gate.NetworkSettings.Ports,
    relays = gatePorts(record);
  if (
    Object.keys(published)
      .filter((key) => published[key] !== null)
      .sort()
      .join() !== [...relays].sort().join()
  )
    throw failure();
  // Every relay an installed computer's gate has, the previews' included, is published once on
  // loopback at a port of its own.
  const hostPorts = new Map<string, number>();
  for (const relay of relays) {
    const entry = published[relay];
    if (
      !Array.isArray(entry) ||
      entry.length !== 1 ||
      !canaryObject(entry[0]) ||
      entry[0].HostIp !== "127.0.0.1" ||
      typeof entry[0].HostPort !== "string" ||
      !/^[1-9][0-9]{3,4}$/.test(entry[0].HostPort)
    )
      throw failure();
    const port = Number(entry[0].HostPort);
    if (port < 1024 || port > 65535) throw failure();
    hostPorts.set(relay, port);
  }
  if (new Set(hostPorts.values()).size !== relays.length) throw failure();
  const ports = {
    desktopd: hostPorts.get(GATE_PORTS.desktopd) as number,
    stream: hostPorts.get(GATE_PORTS.stream) as number,
  };
  await engine();
  signal.throwIfAborted();
  return ports;
}
