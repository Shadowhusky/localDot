import type { DesktopdEndpoint, DesktopdHealth, StreamEndpoint } from "./types.ts";

// desktopd runs inside the cell, so its answer is read like any other input from the cell.
const MAX_HEALTH_BYTES = 64 * 1024;

export async function probeDesktopd(
  endpoint: DesktopdEndpoint,
  timeoutMs = 3000,
): Promise<DesktopdHealth | undefined> {
  try {
    const res = await fetch(`${endpoint.baseUrl}/healthz`, {
      headers: { authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    const text = await readCapped(res, MAX_HEALTH_BYTES);
    if (text === undefined) return undefined;
    const health: unknown = JSON.parse(text);
    return isHealth(health) ? health : undefined;
  } catch {
    return undefined;
  }
}

async function readCapped(res: Response, max: number): Promise<string | undefined> {
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
      headers: { authorization: endpoint.authorization },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}
