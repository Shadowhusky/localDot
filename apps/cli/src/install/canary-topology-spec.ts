import { randomBytes } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import {
  CanaryOperation,
  type CanaryRole,
  canaryResourceLabels,
  canaryResourceName,
} from "../../../../packages/protocol/src/canary-operation.ts";
import { CanaryReady } from "../../../../packages/protocol/src/canary-process.ts";
import { hostAddress } from "../../../daemon/src/cells/ipv4.ts";
import {
  DESKTOP_OFFSET,
  desktopSpec,
  egressNetworkSpec,
  GATE_OFFSET,
  GATE_PORTS,
  gateSpec,
  ISOLATED_GATEWAY_OPTION,
  internalNetworkSpec,
  streamOptions,
} from "../../../daemon/src/cells/spec.ts";
import type { CellRecord } from "../../../daemon/src/cells/types.ts";

const failure = () => new Error("The diagnostic topology is unavailable or unsafe.");
export const canaryObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
export function canaryNames(operation: CanaryOperation) {
  return {
    internalNetwork: canaryResourceName(operation.runId, "internal"),
    egressNetwork: canaryResourceName(operation.runId, "egress"),
    homeVolume: canaryResourceName(operation.runId, "home"),
    gate: canaryResourceName(operation.runId, "gate"),
    desktop: canaryResourceName(operation.runId, "desktop"),
  };
}
export function canaryNetworkSpec(operation: CanaryOperation, role: "internal" | "egress") {
  const name = canaryResourceName(operation.runId, role);
  return {
    ...(role === "internal"
      ? internalNetworkSpec(name, operation.cellId)
      : egressNetworkSpec(name, operation.cellId)),
    Labels: canaryResourceLabels(operation, role),
    CheckDuplicate: true,
  };
}
export function canarySubnet(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}\/(?:[89]|1[0-9]|2[0-8])$/.test(value)
  )
    throw failure();
  const [address = "", bits = ""] = value.split("/"),
    octets = address.split(".").map(Number),
    size = 2 ** (32 - Number(bits));
  if (octets.some((n, i) => n > 255 || String(n) !== address.split(".")[i])) throw failure();
  const base = octets.reduce((sum, n) => sum * 256 + n, 0),
    end = base + size - 1;
  if (
    base % size !== 0 ||
    ![
      [0x0a000000, 0x0affffff],
      [0xac100000, 0xac1fffff],
      [0xc0a80000, 0xc0a8ffff],
    ].some(([lo, hi]) => lo !== undefined && hi !== undefined && base >= lo && end <= hi)
  )
    throw failure();
  return { cidr: value, base, end };
}
export function ownedCanaryObject(
  operation: CanaryOperation,
  role: CanaryRole,
  raw: unknown,
  expected?: string,
) {
  const isContainer = role === "desktop" || role === "gate",
    name = canaryResourceName(operation.runId, role);
  if (!canaryObject(raw) || raw.Name !== (isContainer ? `/${name}` : name)) throw failure();
  const labels = isContainer && canaryObject(raw.Config) ? raw.Config.Labels : raw.Labels;
  if (
    !canaryObject(labels) ||
    Object.entries(canaryResourceLabels(operation, role)).some(([k, v]) => labels[k] !== v)
  )
    throw failure();
  if (
    role !== "home" &&
    (typeof raw.Id !== "string" ||
      !/^[a-f0-9]{64}$/.test(raw.Id) ||
      (expected !== undefined && raw.Id !== expected))
  )
    throw failure();
  return raw;
}
export function inspectCanaryNetwork(
  operation: CanaryOperation,
  role: "internal" | "egress",
  raw: unknown,
  id: string,
  empty: boolean,
) {
  const value = ownedCanaryObject(operation, role, raw, id);
  if (
    value.Driver !== "bridge" ||
    value.Internal !== (role === "internal") ||
    value.EnableIPv6 !== false ||
    !canaryObject(value.Containers) ||
    (empty && Object.keys(value.Containers).length !== 0) ||
    !canaryObject(value.IPAM) ||
    !Array.isArray(value.IPAM.Config) ||
    value.IPAM.Config.length !== 1
  )
    throw failure();
  const config = value.IPAM.Config[0];
  if (!canaryObject(config)) throw failure();
  const subnet = canarySubnet(config.Subnet);
  if (role === "internal") {
    if (
      !canaryObject(value.Options) ||
      value.Options[ISOLATED_GATEWAY_OPTION] !== "isolated" ||
      (config.Gateway !== undefined && config.Gateway !== "" && config.Gateway !== "invalid IP")
    )
      throw failure();
  } else if (config.Gateway !== hostAddress(subnet.cidr, 1)) throw failure();
  return subnet;
}
export function inspectCanaryHome(operation: CanaryOperation, raw: unknown) {
  const value = ownedCanaryObject(operation, "home", raw);
  if (
    value.Driver !== "local" ||
    (value.Options !== null &&
      (!canaryObject(value.Options) || Object.keys(value.Options).length !== 0))
  )
    throw failure();
  return value;
}
export function canaryCellRecord(
  operation: CanaryOperation,
  ready: CanaryReady,
  internal: string,
  egress: string,
): CellRecord {
  const op = CanaryOperation.parse(operation),
    hello = CanaryReady.parse(ready);
  if (op.phase !== "active" || hello.runId !== op.runId || hello.cellId !== op.cellId)
    throw failure();
  const a = canarySubnet(internal),
    b = canarySubnet(egress);
  if (a.base <= b.end && b.base <= a.end) throw failure();
  return {
    v: 2,
    kind: "desktop",
    id: op.cellId,
    createdAt: new Date().toISOString(),
    scale: 1,
    keydPort: hello.port,
    tokens: {
      desktopd: randomBytes(32).toString("base64url"),
      stream: randomBytes(32).toString("base64url"),
    },
    docker: {
      ...canaryNames(op),
      gateInternalIp: hostAddress(internal, GATE_OFFSET),
      desktopIp: hostAddress(internal, DESKTOP_OFFSET),
      gateEgressIp: hostAddress(egress, GATE_OFFSET),
    },
  };
}
export function canaryContainerSpec(
  operation: CanaryOperation,
  record: CellRecord,
  role: "gate" | "desktop",
) {
  if (role !== "gate" && role !== "desktop") throw failure();
  const names = canaryNames(operation);
  if (
    record.id !== operation.cellId ||
    record.kind !== "desktop" ||
    record.v !== 2 ||
    record.scale !== 1 ||
    !Number.isInteger(record.keydPort) ||
    record.keydPort < 1024 ||
    record.keydPort > 65535 ||
    ![record.docker.gateInternalIp, record.docker.gateEgressIp, record.docker.desktopIp].every(
      privateCanaryAddress,
    ) ||
    Object.entries(names).some(([k, v]) => record.docker[k as keyof typeof names] !== v) ||
    Object.keys(record.tokens).sort().join() !== "desktopd,stream" ||
    !Object.values(record.tokens).every((v) => /^[A-Za-z0-9_-]{43}$/.test(v))
  )
    throw failure();
  const spec =
    role === "gate"
      ? gateSpec(record, operation.images.gate.ref)
      : desktopSpec(record, operation.images.desktop.ref, streamOptions());
  return { ...spec, Labels: canaryResourceLabels(operation, role) };
}
export function privateCanaryAddress(address: string) {
  if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(address)) return false;
  const parts = address.split("."),
    nums = parts.map(Number);
  if (nums.some((n, i) => n > 255 || String(n) !== parts[i])) return false;
  return (
    nums[0] === 10 ||
    (nums[0] === 172 && (nums[1] ?? 0) >= 16 && (nums[1] ?? 0) <= 31) ||
    (nums[0] === 192 && nums[1] === 168)
  );
}
function subset(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((v, i) => subset(actual[i], v))
    );
  if (canaryObject(expected))
    return canaryObject(actual) && Object.entries(expected).every(([k, v]) => subset(actual[k], v));
  return equal(actual, expected);
}
export function inspectCanaryContainer(
  operation: CanaryOperation,
  record: CellRecord,
  role: "desktop" | "gate",
  raw: unknown,
  id: string,
  running: boolean,
  image: Record<string, unknown>,
) {
  const value = ownedCanaryObject(operation, role, raw, id),
    spec = canaryContainerSpec(operation, record, role);
  if (
    !canaryObject(value.Config) ||
    !canaryObject(value.HostConfig) ||
    !canaryObject(value.State) ||
    !canaryObject(image.Config) ||
    value.Image !== operation.images[role].id ||
    value.Config.Image !== spec.Image ||
    value.State.Running !== running ||
    value.State.Paused !== false ||
    value.State.Restarting !== false ||
    value.State.Dead !== false
  )
    throw failure();
  const config = value.Config,
    host = value.HostConfig;
  if (
    !Array.isArray(config.Env) ||
    config.Env.some((e) => typeof e !== "string") ||
    !spec.Env.every((e) => {
      const name = e.slice(0, e.indexOf("=") + 1),
        matches = (config.Env as string[]).filter((v) => v.startsWith(name));
      return matches.length === 1 && matches[0] === e;
    }) ||
    config.User !== (role === "gate" ? "nobody" : image.Config.User) ||
    !equal(config.Cmd, image.Config.Cmd) ||
    !equal(config.Entrypoint, image.Config.Entrypoint) ||
    config.WorkingDir !== image.Config.WorkingDir
  )
    throw failure();
  for (const key of ["Binds", "CapAdd", "Devices", "DeviceRequests", "ExtraHosts", "VolumesFrom"]) {
    if (
      host[key] !== null &&
      host[key] !== undefined &&
      (!Array.isArray(host[key]) || (host[key] as unknown[]).length !== 0)
    )
      throw failure();
  }
  if (
    host.Privileged !== false ||
    host.PublishAllPorts !== false ||
    host.AutoRemove !== false ||
    !["", "private"].includes(String(host.PidMode ?? "")) ||
    !["", "private"].includes(String(host.IpcMode ?? "")) ||
    !canaryObject(host.RestartPolicy) ||
    !["", "no"].includes(String(host.RestartPolicy.Name))
  )
    throw failure();
  const expectedHost = { ...spec.HostConfig } as Record<string, unknown>;
  delete expectedHost.PortBindings;
  if (!subset(host, expectedHost)) throw failure();
  if (role === "desktop") {
    if (
      host.ReadonlyRootfs !== false ||
      (host.SecurityOpt !== null &&
        host.SecurityOpt !== undefined &&
        (!Array.isArray(host.SecurityOpt) || host.SecurityOpt.length !== 0))
    )
      throw failure();
    if (
      host.PortBindings !== null &&
      host.PortBindings !== undefined &&
      (!canaryObject(host.PortBindings) || Object.keys(host.PortBindings).length !== 0)
    )
      throw failure();
  } else {
    if (
      (host.Mounts !== null &&
        host.Mounts !== undefined &&
        (!Array.isArray(host.Mounts) || host.Mounts.length !== 0)) ||
      (host.Tmpfs !== null &&
        host.Tmpfs !== undefined &&
        (!canaryObject(host.Tmpfs) || Object.keys(host.Tmpfs).length !== 0))
    )
      throw failure();
    if (
      !canaryObject(host.PortBindings) ||
      Object.keys(host.PortBindings).sort().join() !== Object.values(GATE_PORTS).sort().join()
    )
      throw failure();
    for (const key of Object.values(GATE_PORTS)) {
      const binding = host.PortBindings[key];
      if (
        !Array.isArray(binding) ||
        binding.length !== 1 ||
        !canaryObject(binding[0]) ||
        binding[0].HostIp !== "127.0.0.1" ||
        typeof binding[0].HostPort !== "string" ||
        (binding[0].HostPort !== "" && !/^[0-9]{1,5}$/.test(binding[0].HostPort))
      )
        throw failure();
    }
  }
  return value;
}
