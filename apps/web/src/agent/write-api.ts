import { keyLikePresent, ReviseLink, ULID_PATTERN } from "@localdot/protocol";
import type { ApiClient } from "../lib/api.ts";

export type MessageMode = "new" | "steer" | "followup";
export interface TextDelivery {
  readonly cellId: string;
  readonly sessionId: string | null;
  readonly mode: MessageMode;
  readonly text: string;
  // A new task that revises a file dot handed over before, starting from that version.
  readonly revise?: ReviseLink;
  // A new task in research mode: dot reads many sources and writes a cited report.
  readonly research?: true;
}
export class DeliveryFailure extends Error {
  constructor(
    readonly uncertain: boolean,
    readonly status?: number,
  ) {
    super(
      uncertain
        ? "The reply was lost or could not be verified. This message may already have been accepted."
        : "This message was not accepted. Check the computer and task, then try again.",
    );
    this.name = "DeliveryFailure";
  }
}

// An accepted HTTP action is distinct from a projected event. No text-matching acknowledgement
// or automatic retry is possible: the current wire protocol has no delivery idempotency key.
export async function deliverText(api: ApiClient, request: TextDelivery): Promise<string> {
  if (
    !ULID_PATTERN.test(request.cellId) ||
    (request.mode !== "new" && (!request.sessionId || !ULID_PATTERN.test(request.sessionId))) ||
    !["new", "steer", "followup"].includes(request.mode) ||
    !request.text.trim() ||
    request.text.length > 8000 ||
    request.text.includes("\0") ||
    !request.text.isWellFormed() ||
    keyLikePresent(request.text) ||
    (request.revise &&
      (request.mode !== "new" ||
        !ReviseLink.safeParse(request.revise).success ||
        request.text.length > 7500)) ||
    (request.research && (request.mode !== "new" || request.revise))
  )
    throw new DeliveryFailure(false);
  const revise = request.mode === "new" ? request.revise : undefined;
  const path = revise
    ? `/api/agent/sessions/${revise.sessionId}/files/${encodeURIComponent(revise.name)}/revise`
    : request.mode === "new"
      ? `/api/cells/${request.cellId}/agent`
      : `/api/agent/sessions/${request.sessionId}/messages`;
  const abort = new AbortController();
  try {
    const response = await api.fetch(`${api.socketUrl("").replace(/^ws/, "http")}${path}`, {
      method: "POST",
      headers: { authorization: api.authorization(), "content-type": "application/json" },
      body: JSON.stringify(
        revise
          ? { cellId: request.cellId, version: revise.version, text: request.text }
          : request.mode === "new"
            ? { task: request.text, ...(request.research ? { mode: "research" } : {}) }
            : { kind: request.mode, text: request.text },
      ),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
    });
    if (response.status === 401) api.rejectUnauthorized?.();
    if (response.status !== 202) {
      await response.body?.cancel();
      // Server errors, timeout statuses and unexpected successes may follow a persisted action.
      throw new DeliveryFailure(
        ![400, 401, 403, 404, 409, 413, 422].includes(response.status),
        response.status,
      );
    }
    const reader = response.body?.getReader();
    let text = "";
    if (reader) {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 4096) {
            abort.abort();
            throw new DeliveryFailure(true);
          }
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    if (request.mode !== "new") {
      if (text !== "") throw new DeliveryFailure(true);
      return request.sessionId as string;
    }
    const value: unknown = JSON.parse(text);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !Object.hasOwn(value, "sessionId")
    )
      throw new DeliveryFailure(true);
    const sessionId = (value as Record<string, unknown>).sessionId;
    if (typeof sessionId !== "string" || !ULID_PATTERN.test(sessionId))
      throw new DeliveryFailure(true);
    return sessionId;
  } catch (error) {
    if (error instanceof DeliveryFailure) throw error;
    throw new DeliveryFailure(true);
  } finally {
    abort.abort();
  }
}
