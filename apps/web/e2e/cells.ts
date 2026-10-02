import type { RunningDaemon } from "./daemon.ts";

export interface CellRef {
  id: string;
  scale: 1 | 2;
}

const headers = (d: RunningDaemon) => ({
  authorization: `Bearer ${d.token}`,
  "content-type": "application/json",
});

export async function createReadyCell(
  d: RunningDaemon,
  scale: 1 | 2,
  timeoutMs = 300_000,
): Promise<CellRef> {
  const created = await fetch(`${d.origin}/api/cells`, {
    method: "POST",
    headers: headers(d),
    body: JSON.stringify({ scale }),
  });
  if (created.status !== 202)
    throw new Error(`create cell: ${created.status} ${await created.text()}`);
  const { id } = (await created.json()) as { id: string };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cell = (await (
      await fetch(`${d.origin}/api/cells/${id}`, { headers: headers(d) })
    ).json()) as { state: string; error?: string };
    if (cell.state === "ready") return { id, scale };
    if (cell.state === "failed") throw new Error(`cell failed: ${cell.error}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("cell not ready in time");
}

export async function launchApp(
  d: RunningDaemon,
  cellId: string,
  app: string,
  args: string[] = [],
): Promise<void> {
  const res = await fetch(`${d.origin}/api/cells/${cellId}/launch`, {
    method: "POST",
    headers: headers(d),
    body: JSON.stringify({ app, args }),
  });
  if (!res.ok) throw new Error(`launch ${app}: ${res.status} ${await res.text()}`);
}

export async function rawInput(
  d: RunningDaemon,
  cellId: string,
  body: unknown,
): Promise<{ pressDaemonMicros: number; presses: number[] }> {
  const res = await fetch(`${d.origin}/api/cells/${cellId}/input`, {
    method: "POST",
    headers: headers(d),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`input: ${res.status} ${await res.text()}`);
  return (await res.json()) as { pressDaemonMicros: number; presses: number[] };
}

export async function removeCell(d: RunningDaemon, cellId: string): Promise<void> {
  await fetch(`${d.origin}/api/cells/${cellId}?purge=1`, {
    method: "DELETE",
    headers: headers(d),
  }).catch(() => {});
}
