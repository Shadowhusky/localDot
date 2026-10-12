import { SelfTestReport, selfTestPassed } from "@localdot/protocol";
import type { DesktopdEndpoint, DesktopdHealth, StreamEndpoint } from "./types.ts";

// desktopd runs inside the cell, so its answer is read like any other input from the cell.
const MAX_HEALTH_BYTES = 64 * 1024;
// The self-test makes network checks with their own 2 s bounds; it gets more room than /healthz.
export const SELFTEST_TIMEOUT_MS = 8000;

// Ready means healthy and through the boot self-test (spec: "the boot self-test must pass before
// the cell is marked ready"). An answer that is not a complete self-test report counts as a failure.
export async function probeDesktopd(
  endpoint: DesktopdEndpoint,
  timeoutMs = 3000,
  options: { selftest?: boolean } = {},
): Promise<DesktopdHealth | undefined> {
  const health = await getJson(endpoint, "/healthz", timeoutMs);
  if (!isHealth(health)) return undefined;
  // Ongoing liveness polling checks the desktop, without rerunning the boot network probes.
  if (!health.ok || options.selftest === false) return health;
  const parsed = SelfTestReport.safeParse(
    await getJson(endpoint, "/selftest", SELFTEST_TIMEOUT_MS),
  );
  const selftest: SelfTestReport = parsed.success
    ? parsed.data
    : {
        ok: false,
        ms: 0,
        checks: [
          { id: "selftest", kind: "keyd", ok: false, detail: "desktopd gave no self-test report" },
        ],
      };
  return { ...health, ok: selfTestPassed(selftest), selftest };
}

async function getJson(
  endpoint: DesktopdEndpoint,
  path: string,
  timeoutMs: number,
): Promise<unknown> {
  try {
    const res = await fetch(`${endpoint.baseUrl}${path}`, {
      redirect: "error",
      headers: { authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return undefined;
    }
    const text = await readCapped(res, MAX_HEALTH_BYTES);
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function readCapped(res: Response, max: number): Promise<string | undefined> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.byteLength;
    // Leaving the loop cancels the rest of the body.
    if (size > max) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isHealth(value: unknown): value is DesktopdHealth {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { ok?: unknown }).ok === "boolean"
  );
}

export async function probeStream(endpoint: StreamEndpoint, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint.baseUrl}/api/health`, {
      redirect: "error",
      headers: { authorization: endpoint.authorization },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}
