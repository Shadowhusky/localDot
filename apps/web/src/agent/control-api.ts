import {
  HandbackRequest,
  keyLikePresent,
  QuestionAnswerRequest,
  StopOutcome,
  TakeoverInputRequest,
  ULID_PATTERN,
} from "@localdot/protocol";
import type { ApiClient } from "../lib/api.ts";

export class ControlFailure extends Error {
  constructor(
    readonly uncertain: boolean,
    readonly status?: number,
  ) {
    super(uncertain ? "Action delivery could not be confirmed." : "The action was refused.");
  }
}
function endpoint(api: ApiClient, path: string) {
  return `${api.socketUrl("").replace(/^ws/, "http")}${path}`;
}
async function owned<T>(
  work: Promise<T>,
  signal: AbortSignal,
  late?: (value: T) => void,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ControlFailure(true));
    signal.addEventListener("abort", abort, { once: true });
    work
      .then((value) => {
        if (signal.aborted) {
          late?.(value);
          reject(new ControlFailure(true));
        } else resolve(value);
      }, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
async function mutation<T>(
  api: ApiClient,
  path: string,
  body: unknown,
  status: number,
  signal: AbortSignal,
  parse: (body: string) => T,
): Promise<T> {
  if (signal.aborted) throw new ControlFailure(false);
  const lifetime = new AbortController();
  const timer = setTimeout(() => lifetime.abort(), 35_000);
  const owner = AbortSignal.any([signal, lifetime.signal]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => {
    void reader?.cancel().catch(() => {});
  };
  owner.addEventListener("abort", cancel, { once: true });
  try {
    const response = await owned(
      api.fetch(endpoint(api, path), {
        method: "POST",
        headers: {
          authorization: api.authorization(),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: owner,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      }),
      owner,
      (late) => {
        void late.body?.cancel().catch(() => {});
      },
    );
    if (response.status === 401) api.rejectUnauthorized?.();
    if (response.status !== status) {
      void response.body?.cancel().catch(() => {});
      throw new ControlFailure(
        ![400, 401, 403, 404, 409, 413, 415, 422].includes(response.status),
        response.status,
      );
    }
    const length = response.headers.get("content-length");
    if (
      length !== null &&
      (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > 4096)
    ) {
      void response.body?.cancel().catch(() => {});
      throw new ControlFailure(true);
    }
    reader = response.body?.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "",
      bytes = 0;
    if (reader)
      for (;;) {
        const part = await owned(reader.read(), owner);
        owner.throwIfAborted();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 4096) throw new ControlFailure(true);
        text += decoder.decode(part.value, { stream: true });
      }
    text += decoder.decode();
    if (length !== null && Number(length) !== bytes) throw new ControlFailure(true);
    owner.throwIfAborted();
    return parse(text);
  } catch (error) {
    if (error instanceof ControlFailure) throw error;
    throw new ControlFailure(true);
  } finally {
    clearTimeout(timer);
    lifetime.abort();
    owner.removeEventListener("abort", cancel);
    cancel();
    reader?.releaseLock();
  }
}
const empty = (body: string) => {
  if (body !== "") throw new ControlFailure(true);
};
const sessionPath = (sessionId: string) => {
  if (!ULID_PATTERN.test(sessionId)) throw new ControlFailure(false);
  return `/api/agent/sessions/${sessionId}`;
};
export function answerQuestion(
  api: ApiClient,
  sessionId: string,
  body: QuestionAnswerRequest,
  signal: AbortSignal,
): Promise<void> {
  const value = QuestionAnswerRequest.safeParse(body);
  if (!value.success || (value.data.text && keyLikePresent(value.data.text)))
    throw new ControlFailure(false);
  return mutation(api, `${sessionPath(sessionId)}/answer`, value.data, 204, signal, empty);
}
export function returnControl(
  api: ApiClient,
  sessionId: string,
  body: HandbackRequest,
  signal: AbortSignal,
): Promise<void> {
  const value = HandbackRequest.safeParse(body);
  if (!value.success || (value.data.note && keyLikePresent(value.data.note)))
    throw new ControlFailure(false);
  return mutation(api, `${sessionPath(sessionId)}/takeover/done`, value.data, 204, signal, empty);
}
export function manualInput(
  api: ApiClient,
  sessionId: string,
  body: TakeoverInputRequest,
  signal: AbortSignal,
): Promise<void> {
  const value = TakeoverInputRequest.safeParse(body);
  if (!value.success) throw new ControlFailure(false);
  return mutation(api, `${sessionPath(sessionId)}/takeover/input`, value.data, 204, signal, empty);
}
export function stopTask(
  api: ApiClient,
  sessionId: string,
  signal: AbortSignal,
): Promise<StopOutcome> {
  if (!ULID_PATTERN.test(sessionId)) throw new ControlFailure(false);
  return mutation(api, `/api/sessions/${sessionId}/stop`, undefined, 202, signal, (text) =>
    StopOutcome.parse(JSON.parse(text)),
  );
}
