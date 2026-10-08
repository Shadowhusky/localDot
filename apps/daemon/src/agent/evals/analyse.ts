export interface RecordedEvent {
  seq?: number;
  t: number;
  type: string;
  step?: string;
  data: Record<string, unknown>;
}

export const PHASES = [
  "preAuth",
  "approvalWait",
  "revalidate",
  "travelFreshness",
  "consume",
  "settle",
  "finalObserve",
  "totalExclApproval",
  "modelLatency",
] as const;
export type Phase = (typeof PHASES)[number];

export interface PhaseSummary {
  n: number;
  median: number;
  p90: number;
  min: number;
  max: number;
}

export interface RunAnalysis {
  guiActions: number;
  phases: Record<Phase, PhaseSummary | null>;
  approvals: number;
  approvalTimeouts: number;
  handoffs: number;
  staleCancels: number;
  failedSteps: number;
  repeatPauses: number;
  modelTurns: number;
  inputTokens: number;
  outputTokens: number;
}

export function parseEvents(jsonl: string): RecordedEvent[] {
  return jsonl
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RecordedEvent);
}

export function summarize(values: readonly number[]): PhaseSummary | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median =
    sorted.length % 2
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return {
    n: sorted.length,
    median,
    p90: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] as number,
    min: sorted[0] as number,
    max: sorted[sorted.length - 1] as number,
  };
}

const seconds = (micros: number) => micros / 1e6;

// A GUI step runs from step.start to its step.end (or the next step.start when the brain died
// mid-step). Its first dispatched input defines the phases; later repeats in the same step only
// add to the counts.
function guiSteps(events: readonly RecordedEvent[]): { start: number; events: RecordedEvent[] }[] {
  const steps: { start: number; kind: unknown; events: RecordedEvent[] }[] = [];
  let current: (typeof steps)[number] | undefined;
  for (const event of events) {
    if (event.type === "step.start") {
      current = { start: event.t, kind: event.data.kind, events: [] };
      steps.push(current);
    } else if (event.type === "step.end") current = undefined;
    else current?.events.push(event);
  }
  return steps.filter((s) => s.kind === "gui");
}

function stepPhases(start: number, events: readonly RecordedEvent[]) {
  const first = (type: string, after = start) =>
    events.find((e) => e.type === type && e.t >= after);
  const dispatch = first("action.dispatch");
  const intent = first("action.intent");
  if (!dispatch || !intent) return undefined;
  const end = events.find(
    (e) => (e.type === "action.result" || e.type === "action.cancel") && e.t >= dispatch.t,
  );
  const settle = first("screen.settle", dispatch.t);
  if (!end || !settle) return undefined;
  const requests = events.filter((e) => e.type === "approval.request" && e.t <= intent.t);
  const resolves = events.filter((e) => e.type === "approval.resolve" && e.t <= intent.t);
  const wait = requests.reduce((sum, request, i) => {
    const resolve = resolves[i];
    return resolve ? sum + resolve.t - request.t : sum;
  }, 0);
  const fresh = events.filter((e) => e.type === "observe" && e.t >= intent.t && e.t <= dispatch.t);
  const lastResolve = resolves.at(-1);
  return {
    preAuth: seconds((requests[0]?.t ?? intent.t) - start),
    approvalWait: requests.length ? seconds(wait) : undefined,
    revalidate: lastResolve ? seconds(intent.t - lastResolve.t) : undefined,
    travelFreshness: fresh[0] ? seconds(fresh[0].t - intent.t) : undefined,
    consume: fresh.length ? seconds(dispatch.t - (fresh.at(-1) as RecordedEvent).t) : undefined,
    settle: seconds(settle.t - dispatch.t),
    finalObserve: seconds(end.t - settle.t),
    totalExclApproval: seconds(end.t - start - wait),
  };
}

function modelLatencies(events: readonly RecordedEvent[]): number[] {
  const out: number[] = [];
  let thinkingAt: number | undefined;
  for (const event of events) {
    if (event.type === "agent.state" && event.data.state === "thinking") thinkingAt = event.t;
    else if (event.type === "model.usage" && thinkingAt !== undefined) {
      out.push(seconds(event.t - thinkingAt));
      thinkingAt = undefined;
    }
  }
  return out;
}

export function analyseEvents(events: readonly RecordedEvent[]): RunAnalysis {
  const samples = Object.fromEntries(PHASES.map((p) => [p, [] as number[]])) as Record<
    Phase,
    number[]
  >;
  let guiActions = 0;
  for (const step of guiSteps(events)) {
    const phases = stepPhases(step.start, step.events);
    if (!phases) continue;
    guiActions += 1;
    for (const [phase, value] of Object.entries(phases))
      if (value !== undefined) samples[phase as Phase].push(value);
  }
  samples.modelLatency.push(...modelLatencies(events));
  const count = (pred: (e: RecordedEvent) => boolean) => events.filter(pred).length;
  const usage = events.filter((e) => e.type === "model.usage");
  const tokens = (key: string) =>
    usage.reduce(
      (sum, e) => sum + (typeof e.data[key] === "number" ? (e.data[key] as number) : 0),
      0,
    );
  const repeatPauses = new Set(
    events
      .filter((e) => e.type === "safety.pause")
      .map((e) => e.data.pause as { requestId?: string; reason?: string } | undefined)
      .filter((p) => p?.reason === "repeated_action")
      .map((p) => p?.requestId),
  );
  return {
    guiActions,
    phases: Object.fromEntries(PHASES.map((p) => [p, summarize(samples[p])])) as Record<
      Phase,
      PhaseSummary | null
    >,
    approvals: count((e) => e.type === "approval.request"),
    approvalTimeouts: count((e) => e.type === "approval.resolve" && e.data.by === "timeout"),
    handoffs: count((e) => e.type === "takeover.request"),
    staleCancels: count((e) => e.type === "action.cancel" && e.data.reason === "stale"),
    failedSteps: count((e) => e.type === "step.end" && e.data.status === "failed"),
    repeatPauses: repeatPauses.size,
    modelTurns: usage.length,
    inputTokens: tokens("inputTokens"),
    outputTokens: tokens("outputTokens"),
  };
}
