import {
  ActionClass,
  APPROVAL_VALUE_CHARS,
  ApprovalAnswer,
  ApprovalFieldText,
  AutonomyRule,
  ComputerFence,
  PauseRequest,
  PauseSnapshot,
  ReplacementRecord,
  ReplacementRequest,
  ResumeSafetyRequest,
  ULID_PATTERN,
} from "@localdot/protocol";
import { z } from "zod";
import type { ApiClient } from "../lib/api.ts";
import { ControlFailure, controlRequest } from "./control-api.ts";

const path = (id: string) => {
  if (!ULID_PATTERN.test(id)) throw new ControlFailure(false);
  return `/api/agent/sessions/${id}`;
};
const empty = (text: string) => {
  if (text !== "") throw new ControlFailure(true);
};
export function answerSafety(api: ApiClient, session: string, body: unknown, signal: AbortSignal) {
  const input = ApprovalAnswer.safeParse(body);
  if (!input.success) throw new ControlFailure(false);
  return controlRequest(api, `${path(session)}/approvals/answer`, input.data, 204, signal, empty);
}
export function removeAllowance(
  api: ApiClient,
  session: string,
  actionClass: string,
  signal: AbortSignal,
) {
  const value = ActionClass.safeParse(actionClass);
  if (!value.success) throw new ControlFailure(false);
  const target = `${path(session)}/allowances/${value.data}`;
  return controlRequest(api, target, undefined, 204, signal, empty, "DELETE");
}
export function removeRule(api: ApiClient, id: string, signal: AbortSignal) {
  if (!ULID_PATTERN.test(id)) throw new ControlFailure(false);
  return controlRequest(api, `/api/agent/rules/${id}`, undefined, 204, signal, empty, "DELETE");
}
const RulesList = z.strictObject({
  rules: AutonomyRule.array().max(200),
  error: z.string().max(500).optional(),
});
export function loadRules(api: ApiClient, signal: AbortSignal) {
  return controlRequest(
    api,
    "/api/agent/rules",
    undefined,
    200,
    signal,
    (text) => RulesList.parse(JSON.parse(text)),
    "GET",
    262_144,
  );
}
export function resetRules(api: ApiClient, signal: AbortSignal) {
  return controlRequest(api, "/api/agent/rules/reset", undefined, 204, signal, empty);
}
// JSON spends at most six bytes on one character.
const FIELD_BYTES = APPROVAL_VALUE_CHARS * 6 + 64;
export async function loadApprovalField(
  api: ApiClient,
  session: string,
  approvalId: string,
  field: number,
  signal: AbortSignal,
): Promise<string> {
  if (!ULID_PATTERN.test(approvalId) || !Number.isInteger(field) || field < 0 || field > 15)
    throw new ControlFailure(false);
  return controlRequest(
    api,
    `${path(session)}/approvals/${approvalId}/fields/${field}`,
    undefined,
    200,
    signal,
    (text) => ApprovalFieldText.parse(JSON.parse(text)).text,
    "GET",
    FIELD_BYTES,
  );
}
export function pauseSafety(api: ApiClient, session: string, body: unknown, signal: AbortSignal) {
  const input = PauseRequest.safeParse(body);
  if (!input.success) throw new ControlFailure(false);
  return controlRequest(api, `${path(session)}/pause`, input.data, 202, signal, (text) => {
    const value = PauseSnapshot.parse(JSON.parse(text));
    if (value.requestId !== input.data.requestId) throw new ControlFailure(true);
    return value;
  });
}
export function resumeSafety(api: ApiClient, session: string, body: unknown, signal: AbortSignal) {
  const input = ResumeSafetyRequest.safeParse(body);
  if (!input.success) throw new ControlFailure(false);
  return controlRequest(api, `${path(session)}/resume`, input.data, 204, signal, empty);
}
function cellPath(id: string) {
  if (!ULID_PATTERN.test(id)) throw new ControlFailure(false);
  return `/api/cells/${id}`;
}
export function loadFence(api: ApiClient, cell: string, signal: AbortSignal) {
  return controlRequest(
    api,
    `${cellPath(cell)}/fence`,
    undefined,
    200,
    signal,
    (text) => ComputerFence.parse(JSON.parse(text)),
    "GET",
  );
}
function record(text: string, cell: string, request: ReplacementRequest) {
  const value = ReplacementRecord.parse(JSON.parse(text));
  if (
    value.oldCellId !== cell ||
    value.requestId !== request.requestId ||
    value.revision !== request.oldRevision
  )
    throw new ControlFailure(true);
  return value;
}
export function replaceComputer(api: ApiClient, cell: string, body: unknown, signal: AbortSignal) {
  const input = ReplacementRequest.safeParse(body);
  if (!input.success) throw new ControlFailure(false);
  return controlRequest(api, `${cellPath(cell)}/replacement`, input.data, 200, signal, (text) =>
    record(text, cell, input.data),
  );
}
export function loadReplacement(
  api: ApiClient,
  cell: string,
  input: ReplacementRequest,
  signal: AbortSignal,
) {
  const parsed = ReplacementRequest.parse(input);
  return controlRequest(
    api,
    `${cellPath(cell)}/replacement/${parsed.requestId}`,
    undefined,
    200,
    signal,
    (text) => record(text, cell, parsed),
    "GET",
  );
}
