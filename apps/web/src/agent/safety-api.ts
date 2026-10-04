import {
  ApprovalAnswer,
  ComputerFence,
  PauseRequest,
  PauseSnapshot,
  ReplacementRecord,
  ReplacementRequest,
  ResumeSafetyRequest,
  ULID_PATTERN,
} from "@localdot/protocol";
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
