import type { RunningDaemon } from "./daemon.ts";

const headers = (d: RunningDaemon) => ({
  authorization: `Bearer ${d.token}`,
  "content-type": "application/json",
});

export async function runPuppet(
  d: RunningDaemon,
  cellId: string,
  script: unknown,
): Promise<string> {
  const res = await fetch(`${d.origin}/api/cells/${cellId}/puppet`, {
    method: "POST",
    headers: headers(d),
    body: JSON.stringify(script),
  });
  if (res.status !== 202) throw new Error(`puppet: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { sessionId: string }).sessionId;
}

export interface LoggedEvent {
  id: string;
  seq: number;
  t: number;
  step?: string;
  type: string;
  data: Record<string, unknown>;
}

export async function sessionEvents(d: RunningDaemon, sessionId: string): Promise<LoggedEvent[]> {
  const res = await fetch(`${d.origin}/api/sessions/${sessionId}/events`, { headers: headers(d) });
  return (await res.json()) as LoggedEvent[];
}

export async function waitForSessionEnd(
  d: RunningDaemon,
  sessionId: string,
  timeoutMs = 300_000,
): Promise<LoggedEvent[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await sessionEvents(d, sessionId);
    if (events.some((e) => e.type === "session.end")) return events;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`session ${sessionId} did not end in time`);
}

export async function frameBytes(
  d: RunningDaemon,
  sessionId: string,
  frameId: string,
): Promise<Buffer> {
  const res = await fetch(`${d.origin}/api/sessions/${sessionId}/frames/${frameId}`, {
    headers: headers(d),
  });
  if (!res.ok) throw new Error(`frame ${frameId}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
