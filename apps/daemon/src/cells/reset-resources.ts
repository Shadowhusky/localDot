import { ComputerResetRecord } from "../../../../packages/protocol/src/computer-reset.ts";
import { type DockerClient, DockerError } from "./docker.ts";

type Docker = Pick<DockerClient, "request">;
type Kind = "containers" | "networks" | "volumes";
interface Resource {
  kind: Kind;
  name: string;
  id: string | null;
  labels: Record<string, string>;
}
const failure = () => new Error("Computer reset resource ownership or retirement is unconfirmed");
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const path = (r: Resource, id: string, inspect = false) =>
  `/${r.kind}/${encodeURIComponent(id)}${inspect && r.kind === "containers" ? "/json" : ""}`;

function resources(input: ComputerResetRecord): Resource[] {
  const record = ComputerResetRecord.parse(input),
    result: Resource[] = [];
  const append = (id: string, graph: ComputerResetRecord["source"]["desktop"], browser = false) => {
    const labels = {
      "localdot.cell": id,
      ...(browser
        ? {
            "localdot.parent": record.oldCellId,
            "localdot.browser-owner": record.source.browser?.owner ?? "",
          }
        : {}),
    };
    for (const [kind, field, role] of [
      ["containers", "gate", "gate"],
      ["containers", "workload", browser ? "browser" : "desktop"],
      ["networks", "internalNetwork", "internal"],
      ["networks", "egressNetwork", "egress"],
      ["volumes", "volume", browser ? "profile" : "home"],
    ] as const) {
      const item = graph[field],
        name = typeof item === "string" ? item : item.name;
      if (!name.endsWith(`-${id}`)) throw failure();
      result.push({
        kind,
        name,
        id: typeof item === "string" ? item : item.id,
        labels: { ...labels, "localdot.role": role },
      });
    }
  };
  append(record.oldCellId, record.source.desktop);
  if (record.source.browser)
    append(record.source.browser.id, record.source.browser.resources, true);
  // Close both network gates before retiring workloads, then networks and finally volumes.
  const rank = (r: Resource) =>
    r.kind === "volumes"
      ? 3
      : r.kind === "networks"
        ? 2
        : r.labels["localdot.role"] === "gate"
          ? 0
          : 1;
  return result.sort((a, b) => rank(a) - rank(b));
}
async function read(
  docker: Docker,
  r: Resource,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await docker.request<unknown>({ method: "GET", path: path(r, id, true) });
    if (!object(raw)) throw failure();
    return raw;
  } catch (error) {
    if (error instanceof DockerError && error.status === 404) return undefined;
    throw error;
  }
}
async function present(docker: Docker, r: Resource): Promise<boolean> {
  const named = await read(docker, r, r.name);
  if (r.id === null) {
    if (named) throw failure(); // No recorded identity means absence, never adoption by labels.
    return false;
  }
  const raw = named ?? (r.id === r.name ? undefined : await read(docker, r, r.id));
  if (!raw) return false;
  const config = object(raw.Config) ? raw.Config : undefined;
  const labels = r.kind === "containers" ? config?.Labels : raw.Labels;
  if (
    (r.kind === "volumes" ? raw.Name : raw.Id) !== r.id ||
    !object(labels) ||
    Object.entries(r.labels).some(([key, value]) => labels[key] !== value)
  )
    throw failure();
  return true;
}
async function mounts(docker: Docker, graph: Resource[], detached: boolean): Promise<void> {
  const owned = new Set(graph.filter((r) => r.kind === "containers" && r.id).map((r) => r.id));
  for (const volume of graph.filter((r) => r.kind === "volumes")) {
    const found = await docker.request<unknown>({
      method: "GET",
      path: "/containers/json",
      query: { all: "true", filters: JSON.stringify({ volume: [volume.name] }) },
    });
    if (
      !Array.isArray(found) ||
      found.some((item) => !object(item) || detached || !owned.has(item.Id as string))
    )
      throw failure();
  }
}
async function inventory(docker: Docker, graph: Resource[]): Promise<Resource[]> {
  const found: Resource[] = [];
  // Finish the entire graph check before the first mutation, including a retained profile.
  for (const r of graph) if (await present(docker, r)) found.push(r);
  return found;
}

export async function verifyComputerResetResources(
  docker: Docker,
  input: ComputerResetRecord,
): Promise<void> {
  const graph = resources(input);
  await inventory(docker, graph);
  await mounts(docker, graph, false);
}

/** Physical resource retirement only. The caller must first drain the selected task/native
 * executor and close desktop/browser key grants. This never deletes host folders or history. */
export async function retireComputerResetResources(
  docker: Docker,
  input: ComputerResetRecord,
): Promise<void> {
  const graph = resources(input);
  await inventory(docker, graph);
  await mounts(docker, graph, false);
  for (const r of graph) {
    if (r.kind === "volumes") await mounts(docker, graph, true);
    if (!(await present(docker, r))) continue;
    if (!r.id) throw failure();
    try {
      await docker.request({
        method: "DELETE",
        path: path(r, r.id),
        ...(r.kind === "containers" ? { query: { force: "true" } } : {}),
      });
    } catch {
      // A lost reply is acceptable only if fresh inspection proves the exact object absent.
      if (await present(docker, r)) throw failure();
    }
    if (await present(docker, r)) throw failure();
  }
  if ((await inventory(docker, graph)).length) throw failure();
  await mounts(docker, graph, true);
}

export async function computerResetResourcesAbsent(
  docker: Docker,
  input: ComputerResetRecord,
): Promise<boolean> {
  try {
    const graph = resources(input);
    if ((await inventory(docker, graph)).length) return false;
    await mounts(docker, graph, true);
    return true;
  } catch {
    return false;
  }
}
