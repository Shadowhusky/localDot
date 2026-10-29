import {
  type ReportContext,
  ReportDraft,
  type ReportDraftRequest,
  ReportState,
  ReportsOverview,
  SentReport,
} from "../../../../packages/protocol/src/reports.ts";
import { type ApiClient, ApiError } from "../lib/api.ts";

// What a failure card hands to Settings: the context the report carries, and a line for the user.
export interface ReportAbout {
  context: ReportContext;
  title: string;
}

export interface ReportControl {
  api: ApiClient;
  about?: ReportAbout;
  // Opens Report a problem about a failure, from wherever it showed.
  start(trigger: HTMLElement | null, about: ReportAbout): void;
  clear(): void;
}

// Making a report runs localDot's checks, and sending one waits on the reports service: either
// can outlast the API's usual 15 seconds.
const SLOW_MS = 90_000;

async function slow(api: ApiClient, path: string, body?: unknown): Promise<unknown> {
  const response = await api.fetch(`${api.socketUrl("").replace(/^ws/, "http")}${path}`, {
    method: "POST",
    headers: {
      authorization: api.authorization(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(SLOW_MS),
  });
  if (response.status === 401) api.rejectUnauthorized?.();
  const text = await response.text();
  if (!response.ok) throw new ApiError(response.status, text || response.statusText);
  return JSON.parse(text);
}

export const readReports = async (api: ApiClient) =>
  ReportsOverview.parse(await api.get("/api/reports"));
export const allowReports = async (api: ApiClient, enabled: boolean) =>
  ReportsOverview.parse(await api.put("/api/reports", { enabled }));
export const draftReport = async (api: ApiClient, request: ReportDraftRequest) =>
  ReportDraft.parse(await slow(api, "/api/reports/drafts", request));
export const sendDraft = async (api: ApiClient, draft: string) =>
  SentReport.parse(await slow(api, `/api/reports/drafts/${draft}/send`));
export const sentState = async (api: ApiClient, id: string) =>
  ReportState.parse(await api.get(`/api/reports/sent/${id}`));
export const deleteSent = (api: ApiClient, id: string) => api.del(`/api/reports/sent/${id}`);

// The daemon's own words for a refusal it explains (reports off, an expired review, the
// service's limits); otherwise the fallback.
export function reportProblem(failure: unknown, fallback: string): string {
  return failure instanceof ApiError &&
    [403, 404, 502].includes(failure.status) &&
    failure.message.length <= 200
    ? failure.message
    : fallback;
}
