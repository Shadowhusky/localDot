import { z } from "zod";
import { ULID_PATTERN } from "./ids.ts";

// Problem reports: a redacted diagnostics bundle that localDot sends, gzipped, to the reports
// service, where the owner reads and tracks it by its id.
export const DEFAULT_REPORTS_URL = "https://reports.localdot.dev";
// Eight Crockford characters, easy to read aloud or type from a screenshot: LD-7K3P-Q9XA.
export const REPORT_ID = /^LD-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
// What lets the sender see or delete their own report.
export const REPORT_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const INSTALL_ID = /^[0-9a-f]{32}$/;
export const REPORT_GZIP_MAX = 2 * 1024 * 1024;
export const REPORT_JSON_MAX = 4 * 1024 * 1024;
export const REPORT_MESSAGE_MAX = 2000;
export const REPORT_LOG_LINES = 300;
export const REPORT_LINE_MAX = 1000;
export const REPORT_CONTENT_TYPE = "application/vnd.localdot.report+gzip";

export const REPORT_STATUSES = ["new", "investigating", "fixed", "wontfix"] as const;
export const ReportStatus = z.enum(REPORT_STATUSES);
export type ReportStatus = z.infer<typeof ReportStatus>;

const Text = (max: number) => z.string().max(max);
const Id = z.string().regex(ULID_PATTERN);
const At = z.iso.datetime();
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// What the report is about, when it was started from a failure.
export const ReportContext = z.strictObject({
  kind: z.enum(["task", "browser", "general"]),
  sessionId: Id.optional(),
  cellId: Id.optional(),
  reason: Text(600).optional(),
});
export type ReportContext = z.infer<typeof ReportContext>;

const DoctorCheck = z.strictObject({
  name: Text(64),
  ok: z.boolean(),
  detail: Text(REPORT_LINE_MAX),
  pendingAction: Text(64).optional(),
});

const Browser = z.strictObject({
  state: z.enum(["off", "starting", "ready", "restarting", "failed", "stopped"]),
  problem: Text(600).optional(),
  problemAt: At.optional(),
  restarts: Count.optional(),
  lastFailure: z
    .strictObject({ kind: Text(32), detail: Text(200), recovered: z.boolean(), at: At })
    .optional(),
});

const Computer = z.strictObject({
  id: Id,
  state: Text(32),
  flags: z.array(Text(32)).max(12),
  operation: Text(64).optional(),
  error: Text(600).optional(),
  browser: Browser.optional(),
});

// A recent task as states and reasons only: never its messages, screenshots or files.
const Task = z.strictObject({
  id: Id,
  startedAt: At.optional(),
  durationMs: Count.optional(),
  ended: z.enum(["done", "stopped", "error"]).optional(),
  verdict: Text(32).optional(),
  steps: Count.optional(),
  failedSteps: Count.optional(),
  states: z
    .array(
      z.strictObject({
        state: Text(32),
        reason: Text(200).optional(),
        detail: Text(200).optional(),
      }),
    )
    .max(12),
  retries: z
    .array(z.strictObject({ status: z.number().int().optional(), message: Text(200) }))
    .max(8),
  models: z.array(Text(200)).max(4),
  // What the user asked for, only when they chose to include it.
  request: Text(REPORT_MESSAGE_MAX).optional(),
});

const Log = z.strictObject({
  name: Text(64),
  lines: z.array(Text(REPORT_LINE_MAX)).max(REPORT_LOG_LINES),
  truncated: z.boolean(),
});

export const ReportBundle = z.strictObject({
  format: z.literal(1),
  createdAt: At,
  installId: z.string().regex(INSTALL_ID),
  source: z.enum(["app", "cli"]),
  summary: Text(200).min(1),
  message: Text(REPORT_MESSAGE_MAX).optional(),
  context: ReportContext.optional(),
  app: z.strictObject({
    version: Text(64),
    channel: z.enum(["stable", "rc", "development"]),
    install: z.enum(["managed", "services", "source"]),
    state: z.enum(["running", "not-answering", "stopped"]),
    uptimeSeconds: Count.optional(),
    update: z
      .strictObject({
        phase: Text(32),
        available: Text(64).nullable(),
        error: Text(240).nullable(),
      })
      .optional(),
  }),
  host: z.strictObject({
    os: Text(32),
    arch: Text(32),
    release: Text(64),
    node: Text(32),
    cpus: Count,
    memoryGB: Count,
  }),
  services: z.strictObject({
    keyd: z.enum(["ready", "locked", "down"]),
    docker: z.enum(["running", "stopped"]).optional(),
    remoteAccess: z.strictObject({ enabled: z.boolean(), state: Text(32) }).optional(),
  }),
  doctor: z.array(DoctorCheck).max(64).optional(),
  computers: z.array(Computer).max(16),
  tasks: z.array(Task).max(10),
  logs: z.array(Log).max(6),
});
export type ReportBundle = z.infer<typeof ReportBundle>;

export function releaseChannel(version: string): ReportBundle["app"]["channel"] {
  if (/^\d+\.\d+\.\d+$/.test(version)) return "stable";
  return /^\d+\.\d+\.\d+-rc\.\d+$/.test(version) ? "rc" : "development";
}

// What the service answers a sent report with.
export const ReportReceipt = z.strictObject({
  id: z.string().regex(REPORT_ID),
  token: z.string().regex(REPORT_TOKEN),
});
export type ReportReceipt = z.infer<typeof ReportReceipt>;

// What the sender sees of a report they sent; the owner's notes stay with the owner.
export const ReportState = z.strictObject({
  id: z.string().regex(REPORT_ID),
  status: ReportStatus,
  receivedAt: At,
  updatedAt: At,
});
export type ReportState = z.infer<typeof ReportState>;

// The owner's change to a report.
export const ReportUpdate = z.strictObject({
  status: ReportStatus.optional(),
  notes: Text(4000).optional(),
});
export type ReportUpdate = z.infer<typeof ReportUpdate>;

// The daemon's API for the app and the CLI.
export const SentReport = z.strictObject({
  id: z.string().regex(REPORT_ID),
  sentAt: At,
  summary: Text(200),
});
export type SentReport = z.infer<typeof SentReport>;
export const ReportsOverview = z.strictObject({
  enabled: z.boolean(),
  sent: z.array(SentReport).max(50),
});
export type ReportsOverview = z.infer<typeof ReportsOverview>;
export const ReportDraftRequest = z.strictObject({
  source: z.enum(["app", "cli"]).default("app"),
  message: Text(REPORT_MESSAGE_MAX).optional(),
  context: ReportContext.optional(),
  includeRequest: z.boolean().optional(),
});
export type ReportDraftRequest = z.input<typeof ReportDraftRequest>;
export const ReportDraft = z.strictObject({
  draft: z.uuid(),
  bundle: ReportBundle,
  bytes: Count,
});
export type ReportDraft = z.infer<typeof ReportDraft>;
