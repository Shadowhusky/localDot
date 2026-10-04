import { type DockerClient, DockerError } from "./docker.ts";
import type { CellDocker, CellOwnership } from "./types.ts";

type Docker = Pick<DockerClient, "request">;
type Kind = "containers" | "networks" | "volumes";
export interface OwnedResource {
  kind: Kind;
  name: string;
  id: string;
  role: string;
  running?: boolean;
  paused?: boolean;
}
const path = (kind: Kind, id: string) =>
  `/${kind}/${encodeURIComponent(id)}${kind === "containers" ? "/json" : ""}`;
async function inspect(
  d: Docker,
  kind: Kind,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    return await d.request({ method: "GET", path: path(kind, id) });
  } catch (e) {
    if (e instanceof DockerError && e.status === 404) return undefined;
    throw e;
  }
}
function owned(
  raw: Record<string, unknown>,
  kind: Kind,
  name: string,
  cellId: string,
  role: string,
  expected?: string,
): OwnedResource {
  const config = raw.Config as { Labels?: Record<string, string> } | undefined,
    labels = (kind === "containers" ? config?.Labels : raw.Labels) as
      | Record<string, string>
      | undefined;
  const id = kind === "volumes" ? raw.Name : raw.Id;
  if (
    typeof id !== "string" ||
    !id ||
    id.length > 200 ||
    labels?.["localdot.cell"] !== cellId ||
    labels?.["localdot.role"] !== role ||
    (expected !== undefined && id !== expected)
  )
    throw new Error("resource ownership cannot be confirmed");
  const state = raw.State as { Running?: unknown; Paused?: unknown } | undefined;
  return {
    kind,
    name,
    id,
    role,
    ...(typeof state?.Running === "boolean" ? { running: state.Running } : {}),
    ...(typeof state?.Paused === "boolean" ? { paused: state.Paused } : {}),
  };
}
export async function inspectOwnedCell(
  d: Docker,
  cellId: string,
  names:
    | CellDocker
    | {
        desktop: string;
        gate: string;
        internalNetwork: string;
        egressNetwork: string;
        homeVolume: string;
      },
  ownership?: CellOwnership,
): Promise<OwnedResource[]> {
  const objects: OwnedResource[] = [];
  for (const [kind, field, role] of [
    ["containers", "desktop", "desktop"],
    ["containers", "gate", "gate"],
    ["networks", "internalNetwork", "internal"],
    ["networks", "egressNetwork", "egress"],
    ["volumes", "homeVolume", "home"],
  ] as const) {
    const name = names[field],
      expected = field === "homeVolume" ? undefined : ownership?.[field];
    let raw = await inspect(d, kind, name);
    if (raw) {
      objects.push(owned(raw, kind, name, cellId, role, expected));
      continue;
    }
    if (expected) {
      raw = await inspect(d, kind, expected);
      if (raw) objects.push(owned(raw, kind, name, cellId, role, expected));
    }
  }
  return objects;
}
export async function requireFreshNames(
  d: Docker,
  names: ReturnType<typeof import("./spec.ts").cellNames>,
): Promise<void> {
  for (const [kind, name] of [
    ["containers", names.desktop],
    ["containers", names.gate],
    ["networks", names.internalNetwork],
    ["networks", names.egressNetwork],
    ["volumes", names.homeVolume],
  ] as const)
    if (await inspect(d, kind, name)) throw new Error("replacement resource already exists");
}
export async function retireExactCell(
  d: Docker,
  cellId: string,
  names: Parameters<typeof inspectOwnedCell>[2],
  ownership?: CellOwnership,
  purgeHome = false,
): Promise<void> {
  // Inspect all ownership before deleting anything: a foreign collision is never touched.
  const objects = await inspectOwnedCell(d, cellId, names, ownership);
  for (const object of objects) {
    if (object.kind === "volumes" && !purgeHome) continue;
    try {
      await d.request({
        method: "DELETE",
        path: `/${object.kind}/${encodeURIComponent(object.id)}`,
        query:
          object.kind === "containers"
            ? { force: "true", v: "true" }
            : object.kind === "volumes"
              ? { force: "true" }
              : undefined,
      });
    } catch (e) {
      if (!(e instanceof DockerError && e.status === 404)) throw e;
    }
    if ((await inspect(d, object.kind, object.id)) || (await inspect(d, object.kind, object.name)))
      throw new Error("resource retirement cannot be confirmed");
  }
  // Neither stopped containers nor foreign mounts may retain the old home.
  const mounted = await d.request<unknown>({
    method: "GET",
    path: "/containers/json",
    query: { all: "true", filters: JSON.stringify({ volume: [names.homeVolume] }) },
  });
  if (!Array.isArray(mounted) || mounted.length)
    throw new Error("home detachment cannot be confirmed");
  const remaining = await inspectOwnedCell(d, cellId, names, ownership);
  if (remaining.some((o) => o.kind !== "volumes" || purgeHome))
    throw new Error("old executable resources remain");
}
