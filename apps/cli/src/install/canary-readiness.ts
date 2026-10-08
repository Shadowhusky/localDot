import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual as equal } from "node:util";
import type { CanaryOperation } from "../../../../packages/protocol/src/canary-operation.ts";
import { probeDiagnosticSelfTest } from "../../../daemon/src/cells/diagnostic-selftest.ts";
import type { CellRecord } from "../../../daemon/src/cells/types.ts";
import { type CanaryTopologyClient, inspectRunningCanaryTopology } from "./canary-topology.ts";

const failure = () => new Error("The diagnostic computer did not become ready.");

/** The outer operation/helper scopes retain ownership and perform cleanup on
 * failure. Each probe drains its transport before the next identity check.
 * Only service startup failures are retried; topology changes immediately fail. */
export async function waitCanaryReadiness(
  input: CanaryOperation,
  topology: { record: CellRecord; ports: { desktopd: number; stream: number } },
  client: Pick<CanaryTopologyClient, "engine" | "image" | "inspect">,
  signal: AbortSignal,
): Promise<void> {
  const operation = structuredClone(input),
    { record, ports } = structuredClone(topology);
  const controller = new AbortController(),
    abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, 90_000),
    active = controller.signal;
  try {
    const verify = async () => {
      active.throwIfAborted();
      if (!equal(await inspectRunningCanaryTopology(operation, record, client, active), ports))
        throw failure();
      active.throwIfAborted();
    };
    for (;;) {
      await verify();
      let ready = false;
      try {
        ready = (
          await probeDiagnosticSelfTest(
            { baseUrl: `http://127.0.0.1:${ports.desktopd}`, token: record.tokens.desktopd },
            active,
          )
        ).ok;
      } catch {
        active.throwIfAborted();
      }
      await verify();
      if (ready) return;
      await delay(250, undefined, { signal: active });
    }
  } catch {
    throw failure();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
