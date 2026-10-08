import { isDeepStrictEqual as equal } from "node:util";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  DoctorSelfTestsReply,
  DoctorSelfTestsRequest,
} from "../../../packages/protocol/src/doctor-selftests.ts";
import { ServiceReadinessReply } from "../../../packages/protocol/src/install-services.ts";
import type { CellOrchestrator } from "./cells/orchestrator.ts";
import type { ManagedServiceReadiness } from "./service-readiness.ts";

export interface DoctorSelfTestsDeps {
  cells: Pick<CellOrchestrator, "list" | "diagnoseSelfTest">;
  readiness: Pick<ManagedServiceReadiness, "snapshot">;
}
/** Registered only behind the app's host/origin/token guards. POST is deliberate: a detected
 * isolation failure contains the affected computer. It never starts stopped computers/tasks. */
export function doctorSelfTestRoutes(app: Hono, d: DoctorSelfTestsDeps) {
  let busy = false;
  app.post("/api/service/self-tests", bodyLimit({ maxSize: 1024 }), async (c) => {
    const parsed = DoctorSelfTestsRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.text("invalid diagnostic request", 400);
    if (busy) return c.text("computer diagnostics are already running", 409);
    busy = true;
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(90_000)]);
    try {
      signal.throwIfAborted();
      const before = ServiceReadinessReply.parse(await d.readiness.snapshot());
      if (!before.ready) return c.text("installed service is not ready", 503);
      const ids = () =>
        d.cells
          .list()
          .map((cell) => cell.id)
          .sort();
      const initial = ids();
      if (initial.length > 64 || new Set(initial).size !== initial.length) throw new Error();
      const cells: DoctorSelfTestsReply["cells"] = [];
      for (const id of initial) {
        signal.throwIfAborted();
        try {
          const result = await d.cells.diagnoseSelfTest(id, signal);
          signal.throwIfAborted();
          cells.push({ id, outcome: result.ok ? "passed" : "failed", checks: result.checks });
        } catch {
          signal.throwIfAborted();
          cells.push({ id, outcome: "unavailable", checks: [] });
        }
      }
      const after = ServiceReadinessReply.parse(await d.readiness.snapshot());
      signal.throwIfAborted();
      if (
        !after.ready ||
        !equal(after.service, before.service) ||
        after.bootId !== before.bootId ||
        !equal(after.keyd, before.keyd) ||
        !equal(ids(), initial)
      )
        throw new Error();
      return c.json(
        DoctorSelfTestsReply.parse({
          v: 1,
          requestId: parsed.data.requestId,
          service: after.service,
          bootId: after.bootId,
          cells,
        }),
      );
    } catch {
      return c.text("computer diagnostics could not be confirmed", 503);
    } finally {
      busy = false;
    }
  });
}
