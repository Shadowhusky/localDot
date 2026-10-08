import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DockerClient, DockerError } from "./docker.ts";
import { CellOrchestrator } from "./orchestrator.ts";
import { CellStore } from "./store.ts";
import { sampleRecord } from "./testing/sample-record.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.restoreAllMocks();
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "localdot-managed-recovery-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const store = new CellStore(home);
  const records = [
    sampleRecord("01JXYZ0000000000000000ABCD"),
    sampleRecord("01JXYZ0000000000000000ABCE"),
  ] as const;
  for (const record of records) store.save(record);
  const docker = new DockerClient("/unused-test-only.sock");
  const request = vi.spyOn(docker, "request").mockResolvedValue({ State: { Running: false } });
  const stop = vi.fn(async (_id: string) => {});
  const cells = new CellOrchestrator({
    docker,
    store,
    images: { desktop: "test/desktop", gate: "test/gate" },
    browser: { stop, remove: async () => {} },
    probeDesktopd: async () => undefined,
    probeStream: async () => false,
    watchEveryMs: 0,
  });
  cleanup.push(() => cells.dispose());
  vi.spyOn(console, "error").mockImplementation(() => {});
  return { cells, store, records, request, stop };
}
it("refuses a partial managed recovery but still recovers later computers", async () => {
  const f = fixture();
  f.request.mockRejectedValueOnce(new Error("unobserved Docker state"));
  await expect(f.cells.reconcile({ strict: true })).rejects.toThrow(
    "recovery could not be confirmed",
  );
  expect(f.cells.get(f.records[0].id)?.state).toBe("failed");
  expect(f.cells.get(f.records[1].id)?.state).toBe("stopped");
});
it("keeps development reconciliation diagnostic-only for parent observation failures", async () => {
  const f = fixture();
  f.request.mockRejectedValueOnce(new Error("unobserved Docker state"));
  await expect(f.cells.reconcile()).resolves.toBeUndefined();
});
it("accepts positively observed missing containers as an accounted failed computer", async () => {
  const f = fixture();
  f.request.mockRejectedValueOnce(new DockerError(404, "missing", "/containers/test/json"));
  await expect(f.cells.reconcile({ strict: true })).resolves.toBeUndefined();
  expect(f.cells.get(f.records[0].id)?.state).toBe("failed");
});
it("does not certify an unreadable inventory even after its containment finishes", async () => {
  const f = fixture();
  vi.spyOn(f.store, "inventory").mockReturnValue({ records: [], skipped: [f.records[0].id] });
  f.request.mockResolvedValue([]);
  await expect(f.cells.reconcile({ strict: true })).rejects.toThrow(
    "recovery could not be confirmed",
  );
});
it("waits for browser drain before rejecting failed parent recovery", async () => {
  const f = fixture(),
    drain = Promise.withResolvers<void>();
  f.stop.mockImplementation(() => drain.promise);
  f.request.mockRejectedValueOnce(new Error("unobserved Docker state"));
  let settled = false;
  const recovering = f.cells.reconcile({ strict: true }).finally(() => {
    settled = true;
  });
  const assertion = expect(recovering).rejects.toThrow("recovery could not be confirmed");
  await Promise.resolve();
  expect(settled).toBe(false);
  drain.resolve();
  await assertion;
});
