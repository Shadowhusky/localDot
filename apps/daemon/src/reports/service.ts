import {
  DEFAULT_REPORTS_URL,
  REPORT_CONTENT_TYPE,
  type ReportBundle,
  ReportReceipt,
  ReportState,
  type SentReport,
} from "../../../../packages/protocol/src/reports.ts";
import type { ReportStore, SentRecord } from "./store.ts";

// A failure whose message tells the user what happened; shown as it is.
export class ReportServiceError extends Error {}

const LOOPBACK = /^(?:localhost|127\.0\.0\.1|\[::1\])$/;
const REPLY_MAX = 8 * 1024;
const TIMEOUT_MS = 30_000;

// LOCALDOT_REPORTS_URL sends reports to another service, such as a local copy while testing.
export function reportsUrl(env: NodeJS.ProcessEnv): URL {
  const url = new URL(env.LOCALDOT_REPORTS_URL || DEFAULT_REPORTS_URL);
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.test(url.hostname));
  if (!secure || url.username || url.password || url.search || url.hash)
    throw new ReportServiceError(
      "LOCALDOT_REPORTS_URL must be an https:// address without a query or credentials.",
    );
  return url;
}

async function call(
  base: URL,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<{ status: number; body: string }> {
  let response: Response;
  try {
    response = await fetchImpl(new URL(path, base), {
      ...init,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ReportServiceError(
      "Couldn't reach the reports service. Check the internet connection and try again.",
    );
  }
  const reader = response.body?.getReader();
  let body = "";
  if (reader) {
    const decoder = new TextDecoder();
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      body += decoder.decode(part.value, { stream: true });
      if (body.length > REPLY_MAX) {
        await reader.cancel();
        break;
      }
    }
  }
  return { status: response.status, body };
}

const plain = (text: string) =>
  text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .trim()
    .slice(0, 200);
const authorized = (sent: SentRecord) => ({ authorization: `Bearer ${sent.token}` });

// Sends the exact bytes the user reviewed and keeps the token that lets them delete the report.
export async function sendReport(
  store: ReportStore,
  base: URL,
  bundle: ReportBundle,
  gzip: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<SentReport> {
  const reply = await call(
    base,
    "/v1/reports",
    { method: "POST", headers: { "content-type": REPORT_CONTENT_TYPE }, body: gzip },
    fetchImpl,
    signal,
  );
  if (reply.status === 429 || reply.status === 413)
    throw new ReportServiceError(plain(reply.body) || "The reports service refused the report.");
  if (reply.status !== 201)
    throw new ReportServiceError(
      `The reports service couldn't take the report (${reply.status}). Try again later.`,
    );
  let receipt: ReportReceipt;
  try {
    receipt = ReportReceipt.parse(JSON.parse(reply.body));
  } catch {
    throw new ReportServiceError("The reports service gave an unexpected answer.");
  }
  const sent = { id: receipt.id, sentAt: new Date().toISOString(), summary: bundle.summary };
  store.record({ ...sent, token: receipt.token });
  return sent;
}

// Where the owner has got to with a report; undefined once it is gone.
export async function reportState(
  base: URL,
  sent: SentRecord,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<ReportState | undefined> {
  const reply = await call(
    base,
    `/v1/reports/${sent.id}`,
    { headers: authorized(sent) },
    fetchImpl,
    signal,
  );
  if (reply.status === 404) return undefined;
  try {
    if (reply.status === 200) return ReportState.parse(JSON.parse(reply.body));
  } catch {}
  throw new ReportServiceError(`The reports service couldn't say (${reply.status}).`);
}

export async function deleteSentReport(
  store: ReportStore,
  base: URL,
  sent: SentRecord,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const reply = await call(
    base,
    `/v1/reports/${sent.id}`,
    { method: "DELETE", headers: authorized(sent) },
    fetchImpl,
    signal,
  );
  if (reply.status !== 204 && reply.status !== 404)
    throw new ReportServiceError(
      `The reports service couldn't delete ${sent.id} (${reply.status}). Try again later.`,
    );
  store.forget(sent.id);
}
