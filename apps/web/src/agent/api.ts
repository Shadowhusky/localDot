import {
  ApprovalCard,
  AutonomyPolicy,
  PauseSnapshot,
  TaskModelSelection,
  ULID_PATTERN,
} from "@localdot/protocol";
import type { ApiClient } from "../lib/api.ts";

export type TaskStatus = "starting" | "running" | "waiting_user" | "paused" | "idle" | "ended";
export interface AgentSnapshot {
  readonly sessionId: string;
  readonly cellId: string;
  readonly status: TaskStatus;
  readonly toolCalls: number;
  readonly brainCellId?: string;
  readonly pendingAsk?: string;
  readonly pendingTakeover?: string;
  readonly manualControl?: "waiting" | "ready" | "busy" | "returning" | "unconfirmed";
  readonly models?: TaskModelSelection;
  readonly autonomy?: AutonomyPolicy;
  readonly approval?: ApprovalCard;
  readonly pause?: PauseSnapshot;
}
const statuses = new Set<string>([
  "starting",
  "running",
  "waiting_user",
  "paused",
  "idle",
  "ended",
]);
const fields = new Set([
  "sessionId",
  "cellId",
  "status",
  "toolCalls",
  "brainCellId",
  "pendingAsk",
  "pendingTakeover",
  "manualControl",
  "models",
  "autonomy",
  "approval",
  "pause",
]);
export class AgentResponseError extends Error {
  constructor() {
    super("Task status could not be verified. Reconnect to check it again.");
    this.name = "AgentResponseError";
  }
}

// This response currently has no shared wire schema. Validate unknown JSON at the boundary;
// never treat a TypeScript assertion or an unexpected backend field as authority.
export function parseAgentSnapshot(
  value: unknown,
  sessionId: string,
  cellId: string,
): AgentSnapshot {
  const fail = () => {
    throw new AgentResponseError();
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => !fields.has(key))) return fail();
  if (
    !ULID_PATTERN.test(sessionId) ||
    !ULID_PATTERN.test(cellId) ||
    !Object.hasOwn(v, "sessionId") ||
    v.sessionId !== sessionId ||
    !Object.hasOwn(v, "cellId") ||
    v.cellId !== cellId ||
    !Object.hasOwn(v, "status") ||
    typeof v.status !== "string" ||
    !statuses.has(v.status) ||
    !Object.hasOwn(v, "toolCalls") ||
    !Number.isSafeInteger(v.toolCalls) ||
    (v.toolCalls as number) < 0
  )
    return fail();
  for (const key of ["brainCellId", "pendingAsk", "pendingTakeover"] as const) {
    if (Object.hasOwn(v, key) && (typeof v[key] !== "string" || !ULID_PATTERN.test(v[key])))
      return fail();
  }
  if (
    Object.hasOwn(v, "manualControl") &&
    (!Object.hasOwn(v, "pendingTakeover") ||
      typeof v.manualControl !== "string" ||
      !["waiting", "ready", "busy", "returning", "unconfirmed"].includes(v.manualControl))
  )
    return fail();
  const autonomy = Object.hasOwn(v, "autonomy") ? AutonomyPolicy.safeParse(v.autonomy) : null;
  const approval = Object.hasOwn(v, "approval") ? ApprovalCard.safeParse(v.approval) : null;
  const pause = Object.hasOwn(v, "pause") ? PauseSnapshot.safeParse(v.pause) : null;
  if (
    (autonomy && !autonomy.success) ||
    (approval && !approval.success) ||
    (pause && !pause.success)
  )
    return fail();
  const models = Object.hasOwn(v, "models") ? TaskModelSelection.safeParse(v.models) : null;
  if (models && !models.success) return fail();
  return Object.freeze({
    sessionId,
    cellId,
    status: v.status as TaskStatus,
    toolCalls: v.toolCalls as number,
    ...(models?.success ? { models: models.data } : {}),
    ...(autonomy?.success ? { autonomy: autonomy.data } : {}),
    ...(approval?.success ? { approval: approval.data } : {}),
    ...(pause?.success ? { pause: pause.data } : {}),
    ...(Object.hasOwn(v, "brainCellId") ? { brainCellId: v.brainCellId as string } : {}),
    ...(Object.hasOwn(v, "pendingAsk") ? { pendingAsk: v.pendingAsk as string } : {}),
    ...(Object.hasOwn(v, "pendingTakeover")
      ? { pendingTakeover: v.pendingTakeover as string }
      : {}),
    ...(Object.hasOwn(v, "manualControl")
      ? { manualControl: v.manualControl as AgentSnapshot["manualControl"] }
      : {}),
  });
}
export async function loadAgentSnapshot(
  api: ApiClient,
  sessionId: string,
  cellId: string,
  signal?: AbortSignal,
): Promise<AgentSnapshot> {
  if (!ULID_PATTERN.test(sessionId) || !ULID_PATTERN.test(cellId)) throw new AgentResponseError();
  return parseAgentSnapshot(
    await api.get<unknown>(`/api/agent/sessions/${sessionId}`, { signal }),
    sessionId,
    cellId,
  );
}
