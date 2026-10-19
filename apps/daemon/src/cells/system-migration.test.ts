import { expect, it, vi } from "vitest";
import { DockerError, type DockerRequest } from "./docker.ts";
import { retireMigrationScratch, SYSTEM_BASE, SystemMigration } from "./system-migration.ts";
import { SystemBaseMissing } from "./system-migration-plan.ts";
import type { CellRecord } from "./types.ts";

const base = `sha256:${"a".repeat(64)}`;
const target = `sha256:${"b".repeat(64)}`;
const system = `sha256:${"c".repeat(64)}`;
const record = { id: "cell", ownership: { desktop: "owned" } } as CellRecord;
function setup({
  missing = false,
  running = true,
  paused = false,
  authority = base,
  unavailable = false,
} = {}) {
  const request = vi.fn(async (req: DockerRequest): Promise<unknown> => {
    if (req.path === "/containers/owned/json")
      return {
        Id: "owned",
        Image: system,
        State: { Running: running, Paused: paused },
        Config: {
          Labels: {
            "localdot.cell": "cell",
            "localdot.role": "desktop",
            [SYSTEM_BASE]: base,
            "localdot.snapshot": "stale-marker",
          },
        },
      };
    if (req.path === `/images/${encodeURIComponent(system)}/json`)
      return { Config: { Labels: { [SYSTEM_BASE]: authority } } };
    if (req.path === `/images/${encodeURIComponent(base)}/json`) {
      if (missing || unavailable) throw new DockerError(missing ? 404 : 500, "test", req.path);
      return { Id: base, Architecture: "arm64" };
    }
    if (req.path === `/images/${encodeURIComponent(target)}/json`)
      return { Id: target, Architecture: "arm64", Config: {} };
    if (req.path.endsWith("/tag")) return;
    throw new Error(`Unexpected request: ${req.method} ${req.path}`);
  });
  return { request, migration: new SystemMigration({ request } as never, "/unused") };
}
it("refuses a missing base while the original is running, before any mutation", async () => {
  const { request, migration } = setup({ missing: true });
  await expect(migration.preflight(record, target)).rejects.toBeInstanceOf(SystemBaseMissing);
  expect(request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
});
it("retains the authenticated old and new bases against dangling-image cleanup", async () => {
  const { request, migration } = setup();
  await migration.preflight(record, target);
  expect(request.mock.calls.filter(([r]) => r.method === "POST").map(([r]) => r.query)).toEqual(
    [base, target].map((id) => ({ repo: "localdot/system-base", tag: id.slice(7) })),
  );
  expect(request.mock.calls.some(([r]) => r.path.includes("/commit"))).toBe(false);
});
it("checks again after shutdown and refuses a base removed since preflight", async () => {
  const { request, migration } = setup({ missing: true, running: false });
  await expect(migration.prepare(record, target)).rejects.toBeInstanceOf(SystemBaseMissing);
  expect(request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
});
it("never accepts a forged base label or mistakes a Docker outage for a missing base", async () => {
  const forged = setup({ authority: target });
  await expect(forged.migration.preflight(record, target)).rejects.toThrow("prepare");
  expect(forged.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
  const outage = setup({ unavailable: true });
  await expect(outage.migration.preflight(record, target)).rejects.toBeInstanceOf(DockerError);
});
it("cannot migrate a running computer even when the preflight succeeds", async () => {
  const { request, migration } = setup();
  await expect(migration.prepare(record, target)).rejects.toThrow("prepare");
  expect(request).toHaveBeenCalledTimes(1);
});

it("preflights a paused computer without thawing it, but never snapshots it before shutdown", async () => {
  const { request, migration } = setup({ paused: true });
  await expect(migration.preflight(record, target)).resolves.toBeUndefined();
  expect(request.mock.calls.every(([r]) => r.method === "GET" || r.path.endsWith("/tag"))).toBe(
    true,
  );
  request.mockClear();
  await expect(migration.prepare(record, target)).rejects.toThrow("prepare");
  expect(request).toHaveBeenCalledTimes(1);
});

const name = (entry: string) => entry.slice(0, entry.indexOf("="));
// Docker's rule for a commit and for a container made from an image alike: the request's
// variables, then each of the base's that the request does not name.
const merged = (request: string[] | undefined, base: string[]) =>
  request?.length
    ? [...request, ...base.filter((entry) => !request.some((own) => name(own) === name(entry)))]
    : base;
const stdout = (text: string) => {
  const head = Buffer.alloc(8);
  head[0] = 1;
  head.writeUInt32BE(Buffer.byteLength(text), 4);
  return Buffer.concat([head, Buffer.from(text)]);
};

it("commits the update's backup and new system with no stream password or desktopd token", async () => {
  const images = new Map<string, string[]>([
    [base, ["PATH=/usr/bin"]],
    [target, ["PATH=/usr/bin", "LANG=C.UTF-8"]],
  ]);
  const containers = new Map<string, string[]>([
    ["owned", ["PUID=1000", "LOCALDOT_DESKTOPD_TOKEN=desktopd-secret", "PASSWORD=stream-secret"]],
  ]);
  const commits: { repo?: string; image: string }[] = [];
  let serial = 0;
  const request = vi.fn(async (req: DockerRequest): Promise<unknown> => {
    const [, kind, id = "", action] = req.path.split("/");
    if (req.method === "GET" && req.path === "/containers/owned/json")
      return {
        Id: "owned",
        Image: system,
        State: { Running: false, Paused: false },
        Config: {
          Env: containers.get("owned"),
          Labels: { "localdot.cell": "cell", "localdot.role": "desktop", [SYSTEM_BASE]: base },
        },
      };
    if (req.method === "GET" && kind === "images") {
      const image = decodeURIComponent(id);
      if (image === system) return { Config: { Labels: { [SYSTEM_BASE]: base } } };
      return { Id: image, Architecture: "arm64", Config: { Env: images.get(image), Labels: {} } };
    }
    if (req.method === "POST" && req.path === "/commit") {
      const image = `sha256:${String(++serial).padStart(64, "0")}`;
      const body = req.body as { Env?: string[] } | undefined;
      images.set(image, merged(body?.Env, containers.get(req.query?.container ?? "") ?? []));
      commits.push({ repo: req.query?.repo, image });
      return { Id: image };
    }
    if (req.method === "POST" && req.path === "/containers/create") {
      const helper = `helper-${++serial}`;
      containers.set(helper, images.get((req.body as { Image: string }).Image) ?? []);
      return { Id: helper };
    }
    if (action === "wait") return { StatusCode: 0 };
    if (action === "logs") return stdout("{}");
    if (action === "tag" || action === "start" || action === "archive" || req.method === "DELETE")
      return undefined;
    throw new Error(`Unexpected request: ${req.method} ${req.path}`);
  });
  const result = await new SystemMigration({ request } as never, "/unused").prepare(record, target);
  expect(commits.map((commit) => commit.repo)).toEqual([
    "localdot/update-backup",
    "localdot/updated-system",
  ]);
  expect(commits.at(-1)?.image).toBe(result);
  expect(
    request.mock.calls.filter(([r]) => r.method === "DELETE" && r.path.startsWith("/images/")),
  ).toEqual([
    [
      {
        method: "DELETE",
        path: `/images/${encodeURIComponent(commits[0]?.image ?? "missing")}`,
        query: { force: "false", noprune: "true" },
      },
    ],
  ]);
  for (const { repo, image } of commits) {
    const env = images.get(image) ?? [];
    expect(env, repo).toEqual(expect.arrayContaining(["LOCALDOT_DESKTOPD_TOKEN=", "PASSWORD="]));
    expect(env.join("\n"), repo).not.toMatch(/desktopd-secret|stream-secret/);
  }
  expect(images.get(result)).toEqual(
    expect.arrayContaining(["PATH=/usr/bin", "LANG=C.UTF-8", "PUID=1000"]),
  );
});

function scratch() {
  const source = {
    Id: "owned",
    Image: system,
    State: { Running: false, Paused: false },
    Config: { Labels: { "localdot.cell": "cell", "localdot.role": "desktop" } },
  };
  const request = vi.fn(
    async (req: DockerRequest): Promise<unknown> => (req.method === "GET" ? source : undefined),
  );
  const attempt = {
    cell: "cell",
    sourceId: "owned",
    sourceImage: system,
    protectedImages: [base, target, system],
    images: [`sha256:${"d".repeat(64)}`, `sha256:${"e".repeat(64)}`],
  };
  return { source, request, attempt };
}
it("retires failed candidate then checkpoint by exact ID without pruning ancestors", async () => {
  const f = scratch();
  await retireMigrationScratch({ request: f.request } as never, f.attempt);
  expect(f.request.mock.calls.map(([r]) => r.method)).toEqual(["GET", "DELETE", "GET", "DELETE"]);
  expect(f.request.mock.calls.filter(([r]) => r.method === "DELETE").map(([r]) => r)).toEqual(
    f.attempt.images.map((id) => ({
      method: "DELETE",
      path: `/images/${encodeURIComponent(id)}`,
      query: { force: "false", noprune: "true" },
    })),
  );
});
it.each([
  "running",
  "paused",
  "replaced",
  "wrong-cell",
  "wrong-role",
  "different-image",
  "missing-state",
])("retains scratch when the original is %s", async (kind) => {
  const f = scratch();
  if (kind === "running") f.source.State.Running = true;
  if (kind === "paused") f.source.State.Paused = true;
  if (kind === "replaced") f.source.Id = "other";
  if (kind === "wrong-cell") f.source.Config.Labels["localdot.cell"] = "other";
  if (kind === "wrong-role") f.source.Config.Labels["localdot.role"] = "gate";
  if (kind === "different-image") f.source.Image = target;
  if (kind === "missing-state") delete (f.source as { State?: unknown }).State;
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await retireMigrationScratch({ request: f.request } as never, f.attempt);
    expect(f.request.mock.calls.some(([r]) => r.method === "DELETE")).toBe(false);
  } finally {
    log.mockRestore();
  }
});
it("preserves delivered, base and source images even if Docker deduplicates a commit", async () => {
  const f = scratch();
  f.attempt.images = [base, target, system, "invalid"];
  await retireMigrationScratch({ request: f.request } as never, f.attempt);
  expect(f.request).not.toHaveBeenCalled();
});
it.each(["source-outage", "reference-conflict"])(
  "keeps recovery data on %s without failing the update",
  async (kind) => {
    const f = scratch();
    f.request.mockImplementation(async (req) => {
      if (kind === "source-outage" || req.method === "DELETE")
        throw new DockerError(409, "test", req.path);
      return f.source;
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        retireMigrationScratch({ request: f.request } as never, f.attempt),
      ).resolves.toBeUndefined();
      if (kind === "source-outage")
        expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
      else
        expect(
          f.request.mock.calls
            .filter(([r]) => r.method === "DELETE")
            .every(([r]) => r.query?.force === "false"),
        ).toBe(true);
    } finally {
      log.mockRestore();
    }
  },
);
it("rechecks the original before each image removal", async () => {
  const f = scratch();
  f.request.mockImplementation(async (req) => {
    if (req.method === "DELETE") f.source.State.Running = true;
    return f.source;
  });
  await retireMigrationScratch({ request: f.request } as never, f.attempt);
  expect(f.request.mock.calls.filter(([r]) => r.method === "DELETE")).toHaveLength(1);
});
