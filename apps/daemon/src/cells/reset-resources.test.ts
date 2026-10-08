import { expect, it, vi } from "vitest";
import type { ComputerResetRecord } from "../../../../packages/protocol/src/computer-reset.ts";
import { DockerError } from "./docker.ts";
import { computerResetResourcesAbsent, retireComputerResetResources } from "./reset-resources.ts";

const old = "01JXYZ00000000000000000001",
  browser = "01JXYZ00000000000000000002";
const graph = (id: string, offset: number) => ({
  workload: { name: `workload-${id}`, id: (offset + 1).toString(16).repeat(64) },
  gate: { name: `gate-${id}`, id: (offset + 2).toString(16).repeat(64) },
  internalNetwork: { name: `internal-${id}`, id: (offset + 3).toString(16).repeat(64) },
  egressNetwork: { name: `egress-${id}`, id: (offset + 4).toString(16).repeat(64) },
  volume: `volume-${id}`,
});
function fixture() {
  const record: ComputerResetRecord = {
    v: 1,
    oldCellId: old,
    newCellId: "01JXYZ00000000000000000003",
    requestId: "01JXYZ00000000000000000004",
    phase: "retiring",
    source: {
      scale: 2,
      desktop: graph(old, 0),
      browser: {
        id: browser,
        owner: "00000000-0000-4000-8000-000000000001",
        resources: graph(browser, 4),
      },
    },
  };
  const objects = new Map<string, Record<string, unknown>>();
  const names = new Map<string, string>();
  const attachments = new Map<string, string[]>();
  for (const [id, source, browserOwner] of [
    [old, record.source.desktop, undefined],
    [browser, record.source.browser?.resources, record.source.browser?.owner],
  ] as const) {
    if (!source) throw new Error("fixture source missing");
    for (const [kind, field, role] of [
      ["containers", "workload", browserOwner ? "browser" : "desktop"],
      ["containers", "gate", "gate"],
      ["networks", "internalNetwork", "internal"],
      ["networks", "egressNetwork", "egress"],
      ["volumes", "volume", browserOwner ? "profile" : "home"],
    ] as const) {
      const item = source[field],
        name = typeof item === "string" ? item : item.name;
      const resourceId = typeof item === "string" ? item : item.id;
      const labels = {
        "localdot.cell": id,
        "localdot.role": role,
        ...(browserOwner
          ? {
              "localdot.parent": old,
              "localdot.browser-owner": browserOwner,
            }
          : {}),
      };
      const key = `/${kind}/${resourceId}`;
      names.set(`/${kind}/${name}`, key);
      objects.set(
        key,
        kind === "containers"
          ? { Id: resourceId, Config: { Labels: labels } }
          : kind === "networks"
            ? { Id: resourceId, Labels: labels }
            : { Name: name, Labels: labels },
      );
    }
    attachments.set(source.volume, [source.workload.id as string]);
  }
  const deleted: string[] = [];
  let loseReply = false,
    ignoreDelete = false;
  let afterDelete: (() => void) | undefined;
  const request = vi.fn(
    async (input: { method: string; path: string; query?: Record<string, string> }) => {
      if (input.path === "/containers/json") {
        const filter = JSON.parse(input.query?.filters ?? "{}");
        return (attachments.get(filter.volume[0]) ?? []).map((Id) => ({ Id }));
      }
      const key = input.path.replace(/\/json$/, "");
      const target = names.get(key) ?? key;
      if (input.method === "GET") {
        const raw = objects.get(target);
        if (!raw) throw new DockerError(404, "fixture absent", input.path);
        return structuredClone(raw);
      }
      if (input.method !== "DELETE") throw new Error("unexpected mutation");
      deleted.push(key);
      if (!ignoreDelete) {
        objects.delete(target);
        const id = target.split("/").at(-1);
        for (const [volume, ids] of attachments)
          attachments.set(
            volume,
            ids.filter((value) => value !== id),
          );
      }
      afterDelete?.();
      if (loseReply) throw new Error("lost fixture reply");
      return undefined;
    },
  );
  const docker = { request: request as unknown as import("./docker.ts").DockerClient["request"] };
  return {
    record,
    objects,
    names,
    attachments,
    deleted,
    request,
    docker,
    loseReply: () => {
      loseReply = true;
    },
    ignoreDelete: () => {
      ignoreDelete = true;
    },
    afterDelete: (fn: () => void) => {
      afterDelete = fn;
    },
  };
}
it("retires exact IDs with both gates first, both volumes last, and proves final absence", async () => {
  const f = fixture();
  expect(await computerResetResourcesAbsent(f.docker, f.record)).toBe(false);
  await retireComputerResetResources(f.docker, f.record);
  expect(f.deleted.slice(0, 2)).toEqual([
    `/containers/${"2".repeat(64)}`,
    `/containers/${"6".repeat(64)}`,
  ]);
  expect(f.deleted.slice(-2)).toEqual([`/volumes/volume-${old}`, `/volumes/volume-${browser}`]);
  expect(f.deleted).toHaveLength(10);
  expect(
    f.request.mock.calls
      .filter(([input]) => input.method === "DELETE")
      .every(([input]) => input.query?.v === undefined),
  ).toBe(true);
  expect(await computerResetResourcesAbsent(f.docker, f.record)).toBe(true);
  expect(
    f.request.mock.calls.some(
      ([input]) => input.path.includes("/sessions") || input.path.includes("/shared"),
    ),
  ).toBe(false);
});
it.each(["new mount", "changed profile owner"])(
  "preserves volumes if %s appears during executable retirement",
  async (kind) => {
    const f = fixture();
    f.afterDelete(() => {
      if (kind === "new mount") f.attachments.set(`volume-${old}`, ["f".repeat(64)]);
      else f.objects.set(`/volumes/volume-${old}`, { Name: `volume-${old}`, Labels: {} });
    });
    await expect(retireComputerResetResources(f.docker, f.record)).rejects.toThrow();
    expect(f.deleted.some((path) => path.startsWith("/volumes/"))).toBe(false);
    expect(f.objects.has(`/volumes/volume-${old}`)).toBe(true);
    expect(f.objects.has(`/volumes/volume-${browser}`)).toBe(true);
  },
);
it.each(["identity", "browser owner", "profile owner", "foreign mount"])(
  "refuses %s before deleting any part of the graph",
  async (kind) => {
    const f = fixture();
    if (kind === "identity")
      (f.objects.get(`/containers/${"1".repeat(64)}`) as Record<string, unknown>).Id = "f".repeat(
        64,
      );
    if (kind === "browser owner")
      f.objects.set(`/containers/${"5".repeat(64)}`, {
        Id: "5".repeat(64),
        Config: { Labels: {} },
      });
    if (kind === "profile owner")
      f.objects.set(`/volumes/volume-${browser}`, { Name: `volume-${browser}`, Labels: {} });
    if (kind === "foreign mount") f.attachments.set(`volume-${old}`, ["f".repeat(64)]);
    await expect(retireComputerResetResources(f.docker, f.record)).rejects.toThrow();
    expect(f.deleted).toEqual([]);
    expect(await computerResetResourcesAbsent(f.docker, f.record)).toBe(false);
  },
);
it("supports a stopped browser with a retained profile, but never adopts a name with no recorded ID", async () => {
  const f = fixture(),
    source = f.record.source.browser?.resources;
  if (!source) throw new Error("fixture browser missing");
  for (const field of ["workload", "gate", "internalNetwork", "egressNetwork"] as const) {
    const kind = field === "workload" || field === "gate" ? "containers" : "networks";
    f.objects.delete(`/${kind}/${source[field].id}`);
    source[field].id = null;
  }
  f.attachments.set(source.volume, []);
  const foreign = `/containers/${source.workload.name}`;
  f.objects.set(foreign, { Id: "f".repeat(64) });
  f.names.set(foreign, foreign);
  await expect(retireComputerResetResources(f.docker, f.record)).rejects.toThrow();
  expect(f.deleted).toEqual([]);
  f.objects.delete(foreign);
  await retireComputerResetResources(f.docker, f.record);
  expect(f.deleted).toHaveLength(6);
  expect(f.deleted).toContain(`/volumes/${source.volume}`);
});
it("resolves lost delete replies by inspecting absence and refuses successful replies that left the object present", async () => {
  const f = fixture();
  f.loseReply();
  await retireComputerResetResources(f.docker, f.record);
  expect(await computerResetResourcesAbsent(f.docker, f.record)).toBe(true);
  const stuck = fixture();
  stuck.ignoreDelete();
  await expect(retireComputerResetResources(stuck.docker, stuck.record)).rejects.toThrow();
  expect(stuck.deleted).toHaveLength(1);
  expect(stuck.objects.has(`/volumes/volume-${old}`)).toBe(true);
});
it("finds a renamed owned resource by its recorded ID and never targets the replacement name", async () => {
  const f = fixture(),
    workload = f.record.source.desktop.workload;
  f.names.delete(`/containers/${workload.name}`);
  await retireComputerResetResources(f.docker, f.record);
  expect(f.deleted).toContain(`/containers/${workload.id}`);
  expect(f.deleted).not.toContain(`/containers/${workload.name}`);
});
