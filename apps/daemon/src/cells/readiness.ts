import type { DesktopdEndpoint, DesktopdHealth, StreamEndpoint } from "./types.ts";

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
    return (await res.json()) as DesktopdHealth;
  } catch {
    return undefined;
  }
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
