import { expect, it, vi } from "vitest";
import { DockerError, type DockerRequest } from "./docker.ts";
import { SYSTEM_BASE, SystemMigration } from "./system-migration.ts";
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
