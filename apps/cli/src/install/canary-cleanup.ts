import {
  CanaryOperation,
  type CanaryRole,
  canaryResourceLabels,
  canaryResourceName,
} from "../../../../packages/protocol/src/canary-operation.ts";
import type { ImageEngine } from "./image-client.ts";

export interface CanaryCleanupClient {
  engine(signal: AbortSignal): Promise<ImageEngine>;
  inspect(role: CanaryRole, reference: string, signal: AbortSignal): Promise<unknown | null>;
  stop(id: string, signal: AbortSignal): Promise<void>;
  remove(role: CanaryRole, reference: string, signal: AbortSignal): Promise<void>;
  volumeReferences(name: string, signal: AbortSignal): Promise<unknown>;
}
const failure = () => new Error("Diagnostic Docker resources could not be confirmed retired.");
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const container = (role: CanaryRole): role is "desktop" | "gate" =>
  role === "desktop" || role === "gate";

/** Caller retains the installation mutex AND diagnostic lifetime directory lease. This is only
 * retirement, never canary success. Client operations must be bounded and drain actual requests
 * on cancellation, including lost mutation replies. No prefix sweep, force deletion or PID use.
 */
export async function cleanupCanaryResources(
  input: CanaryOperation,
  client: CanaryCleanupClient,
  signal: AbortSignal,
): Promise<void> {
  const operation = CanaryOperation.parse(input);
  async function engine() {
    signal.throwIfAborted();
    const current = await client.engine(signal);
    if (
      current.id !== operation.engineId ||
      current.operatingSystem !== "linux" ||
      current.architecture !== "arm64"
    )
      throw failure();
  }
  function owned(raw: unknown, role: CanaryRole, expected?: string) {
    const name = canaryResourceName(operation.runId, role);
    if (!object(raw) || raw.Name !== (container(role) ? `/${name}` : name)) throw failure();
    const labels = container(role) && object(raw.Config) ? raw.Config.Labels : raw.Labels;
    if (
      !object(labels) ||
      Object.entries(canaryResourceLabels(operation, role)).some(([k, v]) => labels[k] !== v)
    )
      throw failure();
    const reference = role === "home" ? name : raw.Id;
    if (
      typeof reference !== "string" ||
      (role !== "home" && !/^[a-f0-9]{64}$/.test(reference)) ||
      (expected && reference !== expected)
    )
      throw failure();
    if (container(role)) {
      const state = raw.State;
      if (
        !object(raw.Config) ||
        raw.Config.Image !== operation.images[role].ref ||
        raw.Image !== operation.images[role].id ||
        !object(state) ||
        ["Running", "Paused", "Restarting", "Dead"].some((k) => typeof state[k] !== "boolean")
      )
        throw failure();
    } else if (raw.Driver !== (role === "home" ? "local" : "bridge")) throw failure();
    if (
      role === "home" &&
      raw.Options !== null &&
      (!object(raw.Options) || Object.keys(raw.Options).length !== 0)
    )
      throw failure();
    return { reference, raw };
  }
  async function resolve(role: CanaryRole) {
    const recorded = operation.resources[role],
      name = canaryResourceName(operation.runId, role);
    const byName = await client.inspect(role, name, signal);
    if (typeof recorded === "string") {
      const byId = await client.inspect(role, recorded, signal);
      if (byName === null && byId === null) return null;
      if (byName === null || byId === null) throw failure();
      owned(byName, role, recorded);
      return owned(byId, role, recorded);
    }
    if (byName === null) return null;
    const first = owned(byName, role);
    // Resolve lost create replies by the exact intent name and unpredictable run/owner labels,
    // then inspect the full ID again. A name alone never authorizes a destructive request.
    const fresh = await client.inspect(role, first.reference, signal);
    if (fresh === null) throw failure();
    return owned(fresh, role, first.reference);
  }
  async function absent(role: CanaryRole, reference?: string) {
    if (reference && (await client.inspect(role, reference, signal)) !== null) throw failure();
    if ((await client.inspect(role, canaryResourceName(operation.runId, role), signal)) !== null)
      throw failure();
  }
  function stopped(raw: Record<string, unknown>) {
    return (
      object(raw.State) &&
      raw.State.Running === false &&
      raw.State.Paused === false &&
      raw.State.Restarting === false
    );
  }
  async function remove(role: CanaryRole, reference: string) {
    await engine();
    try {
      await client.remove(role, reference, signal);
    } catch {
      signal.throwIfAborted();
    }
    await absent(role, reference);
  }
  await engine();
  // First stop both owned containers. A stopped container may still pin a network or volume;
  // remove containers only after their freshly inspected stopped state is confirmed.
  for (const role of ["desktop", "gate"] as const) {
    const found = await resolve(role);
    if (!found) continue;
    if (!stopped(found.raw)) {
      await engine();
      try {
        await client.stop(found.reference, signal);
      } catch {
        signal.throwIfAborted();
      }
      const fresh = await client.inspect(role, found.reference, signal);
      if (fresh === null) {
        await absent(role, found.reference);
        continue;
      }
      if (!stopped(owned(fresh, role, found.reference).raw)) throw failure();
    }
  }
  for (const role of ["desktop", "gate"] as const) {
    const found = await resolve(role);
    if (!found) continue;
    if (!stopped(found.raw)) throw failure();
    await remove(role, found.reference);
  }
  for (const role of ["internal", "egress"] as const) {
    const found = await resolve(role);
    if (!found) continue;
    if (!object(found.raw.Containers) || Object.keys(found.raw.Containers).length !== 0)
      throw failure();
    await remove(role, found.reference);
  }
  const volume = await resolve("home");
  if (volume) {
    const references = await client.volumeReferences(volume.reference, signal);
    if (!Array.isArray(references) || references.length !== 0) throw failure();
    // Volume APIs expose names only; revalidate the exact labels after checking all containers.
    const fresh = await resolve("home");
    if (!fresh || fresh.reference !== volume.reference) throw failure();
    await remove("home", volume.reference);
  }
  for (const role of ["desktop", "gate", "internal", "egress", "home"] as const) {
    const recorded = operation.resources[role];
    await absent(role, typeof recorded === "string" ? recorded : undefined);
  }
  await engine();
  signal.throwIfAborted();
}
