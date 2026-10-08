import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { ServiceConfiguration } from "../../../../packages/protocol/src/install-services.ts";
import { ISOLATED_GATEWAY_OPTION } from "../../../daemon/src/cells/spec.ts";
import {
  checkedProbe,
  type InstallNetworkClient,
  type IsolationProbe,
  installNetworkClient,
  probeLabels,
  probeName,
} from "./network-client.ts";
import { privateRecordStore } from "./private-record.ts";
import { verifyServiceOwner } from "./service-journal.ts";

const failure = () =>
  new Error("Docker network isolation could not be verified or its probe could not be cleaned up.");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export interface ProbeStore {
  read(): Promise<IsolationProbe | null>;
  save(value: IsolationProbe | null): Promise<void>;
}
const recordSchema = {
  parse(value: unknown): IsolationProbe | null {
    if (value === null) return null;
    if (
      !object(value) ||
      Object.keys(value).sort().join(",") !== "engineId,name,nonce,owner" ||
      Object.values(value).some((v) => typeof v !== "string")
    )
      throw failure();
    return checkedProbe(value as unknown as IsolationProbe);
  },
};

function owned(
  raw: unknown,
  probe: IsolationProbe,
  expectedId?: string,
): { id: string; info: Record<string, unknown> } {
  if (
    !object(raw) ||
    typeof raw.Id !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.Id) ||
    (expectedId && raw.Id !== expectedId) ||
    raw.Name !== probe.name ||
    !object(raw.Labels) ||
    Object.entries(probeLabels(probe)).some(
      ([key, value]) => raw.Labels && (raw.Labels as Record<string, unknown>)[key] !== value,
    ) ||
    !object(raw.Containers) ||
    Object.keys(raw.Containers).length !== 0
  )
    throw failure();
  return { id: raw.Id, info: raw };
}
function isolated(info: Record<string, unknown>) {
  if (
    info.Driver !== "bridge" ||
    info.Internal !== true ||
    info.EnableIPv6 !== false ||
    !object(info.Options) ||
    info.Options[ISOLATED_GATEWAY_OPTION] !== "isolated" ||
    !object(info.IPAM) ||
    !Array.isArray(info.IPAM.Config) ||
    info.IPAM.Config.length !== 1
  )
    throw failure();
  const config = info.IPAM.Config[0];
  if (!object(config) || typeof config.Subnet !== "string") throw failure();
  const parts = config.Subnet.split("/");
  if (
    parts.length !== 2 ||
    isIP(parts[0] ?? "") !== 4 ||
    !/^(?:[1-9]|[12][0-9]|3[0-2])$/.test(parts[1] ?? "") ||
    (config.Gateway !== undefined && config.Gateway !== "" && config.Gateway !== "invalid IP")
  )
    throw failure();
}

/** Caller owns the install mutex. Persist before create; remove only a fresh inspected exact ID
 * bearing both random owner labels and no endpoints. A lost create reply is recovered by the
 * exact recorded name. No age/prefix sweep and no foreign or cell-network deletion.
 */
export async function verifyGatewayIsolation(
  owner: string,
  store: ProbeStore,
  client: InstallNetworkClient,
  callerSignal: AbortSignal,
) {
  if (!/^[a-f0-9]{32}$/.test(owner)) throw failure();
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(60_000)]);
  signal.throwIfAborted();
  async function sameEngine(probe: IsolationProbe, active: AbortSignal) {
    const engine = await client.engine(active);
    if (
      engine.id !== probe.engineId ||
      engine.operatingSystem !== "linux" ||
      engine.architecture !== "arm64"
    )
      throw failure();
  }
  async function cleanup(probe: IsolationProbe, active: AbortSignal) {
    await sameEngine(probe, active);
    const raw = await client.inspect(probe.name, active);
    if (raw !== null) {
      const first = owned(raw, probe),
        current = await client.inspect(first.id, active);
      if (current !== null) {
        owned(current, probe, first.id);
        try {
          await client.remove(first.id, active);
        } catch {
          active.throwIfAborted();
        }
      }
      if ((await client.inspect(first.id, active)) !== null) throw failure();
    }
    if ((await client.inspect(probe.name, active)) !== null) throw failure();
    await sameEngine(probe, active);
    active.throwIfAborted();
    await store.save(null);
  }
  const previous = recordSchema.parse(await store.read());
  if (previous) {
    if (previous.owner !== owner) throw failure();
    await cleanup(previous, signal);
  }
  signal.throwIfAborted();
  const engine = await client.engine(signal),
    nonce = randomBytes(16).toString("hex");
  const probe = checkedProbe({ owner, nonce, name: probeName(owner, nonce), engineId: engine.id });
  await sameEngine(probe, signal);
  // No network create if persistence fails, even after a rename. Next invocation resolves the
  // possibly persisted intent without guessing whether a prior operation took effect.
  await store.save(probe);
  let passed = false;
  try {
    signal.throwIfAborted();
    if ((await client.inspect(probe.name, signal)) !== null) throw failure();
    const reply = await client.create(probe, signal);
    if (!object(reply) || typeof reply.Id !== "string" || !/^[a-f0-9]{64}$/.test(reply.Id))
      throw failure();
    const first = owned(await client.inspect(reply.Id, signal), probe, reply.Id);
    isolated(first.info);
    await sameEngine(probe, signal);
    const final = owned(await client.inspect(probe.name, signal), probe, first.id);
    isolated(final.info);
    signal.throwIfAborted();
    passed = true;
  } finally {
    // Cleanup has its own deadline so caller cancellation cannot abandon a just-created probe.
    await cleanup(probe, AbortSignal.timeout(30_000));
  }
  if (!passed) throw failure();
  signal.throwIfAborted();
  return { engineId: probe.engineId, isolatedGateway: true as const };
}

export async function verifyInstalledGateway(input: ServiceConfiguration, signal: AbortSignal) {
  const config = await verifyServiceOwner(input);
  return verifyGatewayIsolation(
    config.settings.ownerId,
    privateRecordStore(config.settings.state, "isolation-probe.json", recordSchema),
    installNetworkClient(config.settings.dockerSocket),
    signal,
  );
}
