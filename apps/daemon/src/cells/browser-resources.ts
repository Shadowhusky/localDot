import { type BrowserLedger, BrowserLifecycleError } from "./browser-ledger.ts";
import { browserNames } from "./browser-spec.ts";
import { type DockerClient, DockerError } from "./docker.ts";

type Docker = Pick<DockerClient, "request">;
type Kind = "containers" | "networks" | "volumes";
type Raw = Record<string, unknown>;
const object = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const fields = [
  ["containers", "browser", "browser"],
  ["containers", "gate", "gate"],
  ["networks", "internalNetwork", "internal"],
  ["networks", "egressNetwork", "egress"],
  ["volumes", "profileVolume", "profile"],
] as const;

export const browserObjectPath = (kind: Kind, id: string, suffix?: string) =>
  `/${kind}/${encodeURIComponent(id)}${suffix ? `/${suffix}` : ""}`;

export function browserLabels(record: BrowserLedger, role: string) {
  return {
    "localdot.cell": record.id,
    "localdot.parent": record.parentCellId,
    "localdot.role": role,
    "localdot.browser-owner": record.owner,
  };
}

export async function inspectBrowserObject(
  docker: Docker,
  kind: Kind,
  id: string,
): Promise<Raw | undefined> {
  try {
    const raw = await docker.request<unknown>({
      method: "GET",
      path: browserObjectPath(kind, id, kind === "containers" ? "json" : undefined),
    });
    if (!object(raw)) throw new BrowserLifecycleError();
    return raw;
  } catch (error) {
    if (error instanceof DockerError && error.status === 404) return undefined;
    throw error;
  }
}

export async function inspectBrowserResources(docker: Docker, record: BrowserLedger) {
  const names = browserNames(record.id, record.prefix);
  const result: {
    kind: Kind;
    field: (typeof fields)[number][1];
    id: string;
    name: string;
    raw: Raw;
  }[] = [];
  for (const [kind, field, role] of fields) {
    const name = names[field];
    const expected = field === "profileVolume" ? undefined : record.resources[field];
    let raw = await inspectBrowserObject(docker, kind, name);
    if (!raw && expected) raw = await inspectBrowserObject(docker, kind, expected);
    if (!raw) continue;
    const config = object(raw.Config) ? raw.Config : undefined;
    const labels = kind === "containers" ? config?.Labels : raw.Labels;
    const id = kind === "volumes" ? raw.Name : raw.Id;
    if (
      !object(labels) ||
      typeof id !== "string" ||
      (kind === "volumes" ? id !== name : !/^[a-f0-9]{64}$/u.test(id)) ||
      (expected !== undefined && id !== expected) ||
      Object.entries(browserLabels(record, role)).some(([key, value]) => labels[key] !== value)
    )
      throw new BrowserLifecycleError("Browser resource ownership cannot be confirmed");
    result.push({ kind, field, id, name, raw });
  }
  return result;
}

export async function requireFreshBrowserNames(
  docker: Docker,
  record: BrowserLedger,
): Promise<void> {
  const names = browserNames(record.id, record.prefix);
  for (const [kind, field] of fields)
    if (await inspectBrowserObject(docker, kind, names[field]))
      throw new BrowserLifecycleError("Browser resource name is already occupied");
}

export async function requireDetachedProfile(docker: Docker, record: BrowserLedger): Promise<void> {
  const mounted = await docker.request<unknown>({
    method: "GET",
    path: "/containers/json",
    query: {
      all: "true",
      filters: JSON.stringify({ volume: [browserNames(record.id, record.prefix).profileVolume] }),
    },
  });
  if (!Array.isArray(mounted) || mounted.length !== 0)
    throw new BrowserLifecycleError("Browser profile detachment cannot be confirmed");
}

export async function retireBrowserResources(
  docker: Docker,
  record: BrowserLedger,
  purgeProfile = false,
): Promise<void> {
  const resources = await inspectBrowserResources(docker, record);
  let failed = false;
  for (const resource of resources) {
    if (resource.kind === "volumes") continue;
    if (resource.field === "browser") {
      try {
        await docker.request({
          method: "POST",
          path: browserObjectPath("containers", resource.id, "stop"),
          query: { t: "5" },
          timeoutMs: 8000,
        });
      } catch {}
    }
    try {
      try {
        await docker.request({
          method: "DELETE",
          path: browserObjectPath(resource.kind, resource.id),
          ...(resource.kind === "containers" ? { query: { force: "true", v: "true" } } : {}),
        });
      } catch (error) {
        if (!(error instanceof DockerError && error.status === 404)) throw error;
      }
      if (
        (await inspectBrowserObject(docker, resource.kind, resource.id)) ||
        (await inspectBrowserObject(docker, resource.kind, resource.name))
      )
        throw new BrowserLifecycleError();
    } catch {
      // The full graph was validated above. Failure for one captured owner must
      // not skip retirement of other independently owned executables/networks.
      failed = true;
    }
  }
  try {
    await requireDetachedProfile(docker, record);
  } catch {
    failed = true;
  }
  // Preserve the profile and reservations whenever any retirement is uncertain.
  if (failed) throw new BrowserLifecycleError("Browser resource retirement is incomplete");
  if (purgeProfile) {
    const profile = (await inspectBrowserResources(docker, record)).find(
      (resource) => resource.kind === "volumes",
    );
    if (profile) {
      await docker.request({ method: "DELETE", path: browserObjectPath("volumes", profile.id) });
      if (await inspectBrowserObject(docker, "volumes", profile.id))
        throw new BrowserLifecycleError();
    }
  }
  const remaining = await inspectBrowserResources(docker, record);
  if (remaining.some((resource) => resource.kind !== "volumes" || purgeProfile))
    throw new BrowserLifecycleError();
}
