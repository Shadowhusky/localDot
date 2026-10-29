import { gzipSync } from "node:zlib";
import type {
  BrowserStatus,
  BrowserSupervisorState,
} from "../../../../packages/protocol/src/browser-control.ts";
import {
  REPORT_GZIP_MAX,
  REPORT_JSON_MAX,
  REPORT_LINE_MAX,
  REPORT_MESSAGE_MAX,
  ReportBundle,
  type ReportContext,
  releaseChannel,
} from "../../../../packages/protocol/src/reports.ts";
import type { CellSummary } from "../cells/types.ts";
import type { DoctorCheck } from "../doctor.ts";
import { hostFacts, logTails, recentTasks, type TaskFacts } from "./collect.ts";
import { reportRedactor } from "./redact.ts";

export interface ComputerFacts {
  cell: CellSummary;
  browser?: BrowserStatus;
  supervisor?: BrowserSupervisorState;
}

// What the daemon, or the CLI while the daemon is down, knows of this localDot's state.
export interface ReportFacts {
  version: string;
  install: ReportBundle["app"]["install"];
  app: ReportBundle["app"]["state"];
  uptimeSeconds?: number;
  update?: { phase: string; available: string | null; error: string | null };
  keyd: ReportBundle["services"]["keyd"];
  docker?: "running" | "stopped";
  remoteAccess?: { enabled: boolean; state: string };
  doctor?: readonly DoctorCheck[];
  computers: readonly ComputerFacts[];
}

// What the user adds: their own words, what the report is about, and whether to include what
// they asked for in that task.
export interface ReportAsk {
  source: ReportBundle["source"];
  message?: string;
  context?: ReportContext;
  includeRequest?: boolean;
}

const KIND = { task: "Task", browser: "Web browser", general: "Problem" } as const;
const FLAGS = {
  paused: "paused",
  fenced: "fenced",
  replacementPending: "replacement-pending",
  updateAvailable: "update-available",
  updateBlocked: "update-blocked",
  updating: "updating",
  needsFreshStart: "needs-fresh-start",
} as const;

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

function summarize(ask: ReportAsk, facts: ReportFacts, tasks: readonly TaskFacts[]): string {
  // A failure card names its reason; a task's own log may know one the card didn't see.
  const about = tasks.find((task) => task.id === ask.context?.sessionId);
  const reason = ask.context?.reason ?? about?.states.findLast((s) => s.reason)?.reason;
  if (ask.context && reason) return `${KIND[ask.context.kind]}: ${reason}`;
  const said = ask.message?.trim().split("\n")[0]?.trim();
  if (said) return said;
  if (facts.app !== "running")
    return facts.app === "stopped" ? "localDot isn't running" : "localDot isn't answering";
  const browser = facts.computers.find((c) => c.browser?.state === "failed")?.browser;
  if (browser) return `Web browser failed${browser.problem ? `: ${browser.problem}` : ""}`;
  const failed = facts.doctor?.find((check) => !check.ok);
  if (failed) return `Check failed: ${failed.name}`;
  const errored = tasks.find((task) => task.ended === "error");
  const why = errored?.states.findLast((s) => s.state === "error")?.reason;
  if (errored) return `Task ended with an error${why ? `: ${why}` : ""}`;
  return "Problem report";
}

// The report, every text in it redacted and cut to size, checked against the shared schema.
export function buildReport(input: {
  home: string;
  installId: string;
  facts: ReportFacts;
  ask: ReportAsk;
  now?: Date;
}): ReportBundle {
  const { home, facts, ask } = input;
  const redact = reportRedactor(home);
  const t = (raw: string, max: number) => clip(redact(raw), max);
  const maybe = (raw: string | null | undefined, max: number) => (raw ? t(raw, max) : undefined);
  const sessionId = ask.context?.sessionId;
  const tasks = recentTasks(home, sessionId, ask.includeRequest === true);
  const message = ask.message?.trim();
  return ReportBundle.parse({
    format: 1,
    createdAt: (input.now ?? new Date()).toISOString(),
    installId: input.installId,
    source: ask.source,
    summary: t(summarize(ask, facts, tasks), 200),
    ...(message ? { message: t(message, REPORT_MESSAGE_MAX) } : {}),
    ...(ask.context
      ? {
          context: {
            kind: ask.context.kind,
            ...(sessionId ? { sessionId } : {}),
            ...(ask.context.cellId ? { cellId: ask.context.cellId } : {}),
            ...(ask.context.reason ? { reason: t(ask.context.reason, 600) } : {}),
          },
        }
      : {}),
    app: {
      version: t(facts.version, 64),
      channel: releaseChannel(facts.version),
      install: facts.install,
      state: facts.app,
      ...(facts.uptimeSeconds === undefined ? {} : { uptimeSeconds: facts.uptimeSeconds }),
      ...(facts.update
        ? {
            update: {
              phase: t(facts.update.phase, 32),
              available: maybe(facts.update.available, 64) ?? null,
              error: maybe(facts.update.error, 240) ?? null,
            },
          }
        : {}),
    },
    host: hostFacts(),
    services: {
      keyd: facts.keyd,
      ...(facts.docker ? { docker: facts.docker } : {}),
      ...(facts.remoteAccess
        ? {
            remoteAccess: {
              enabled: facts.remoteAccess.enabled,
              state: t(facts.remoteAccess.state, 32),
            },
          }
        : {}),
    },
    ...(facts.doctor
      ? {
          doctor: facts.doctor.slice(0, 64).map((check) => ({
            name: t(check.name, 64),
            ok: check.ok,
            detail: t(check.detail, REPORT_LINE_MAX),
            ...(check.pendingAction ? { pendingAction: check.pendingAction } : {}),
          })),
        }
      : {}),
    computers: facts.computers.slice(0, 16).map(({ cell, browser, supervisor }) => ({
      id: cell.id,
      state: cell.state,
      flags: Object.entries(FLAGS)
        .filter(([key]) => cell[key as keyof typeof FLAGS])
        .map(([, flag]) => flag),
      ...(cell.operation
        ? { operation: t(`${cell.operation.kind}, ${cell.operation.step}`, 64) }
        : {}),
      ...(cell.error ? { error: t(cell.error, 600) } : {}),
      ...(browser
        ? {
            browser: {
              state: browser.state,
              ...(browser.problem ? { problem: t(browser.problem, 600) } : {}),
              ...(browser.problemAt ? { problemAt: browser.problemAt } : {}),
              ...(browser.restarts === undefined ? {} : { restarts: browser.restarts }),
              ...(supervisor?.lastFailure
                ? {
                    lastFailure: {
                      kind: supervisor.lastFailure.kind,
                      detail: t(supervisor.lastFailure.detail, 200),
                      recovered: supervisor.lastFailure.recovered,
                      at: supervisor.lastFailure.at,
                    },
                  }
                : {}),
            },
          }
        : {}),
    })),
    tasks: tasks.map((task) => ({
      id: task.id,
      ...(task.startedAt ? { startedAt: task.startedAt } : {}),
      ...(task.durationMs === undefined ? {} : { durationMs: task.durationMs }),
      ...(task.ended ? { ended: task.ended } : {}),
      ...(task.verdict ? { verdict: t(task.verdict, 32) } : {}),
      ...(task.steps === undefined ? {} : { steps: task.steps }),
      ...(task.failedSteps === undefined ? {} : { failedSteps: task.failedSteps }),
      states: task.states.map((s) => ({
        state: t(s.state, 32),
        ...(s.reason ? { reason: t(s.reason, 200) } : {}),
        ...(s.detail ? { detail: t(s.detail, 200) } : {}),
      })),
      retries: task.retries.map((r) => ({
        ...(r.status === undefined ? {} : { status: r.status }),
        message: t(r.message, 200),
      })),
      models: task.models.map((model) => t(model, 200)),
      ...(task.title ? { request: t(task.title, REPORT_MESSAGE_MAX) } : {}),
    })),
    logs: logTails(home).map((log) => ({
      name: log.name,
      lines: log.lines.map((line) => t(line, REPORT_LINE_MAX)),
      truncated: log.truncated,
    })),
  });
}

// The gzipped bytes the service receives; the caps above keep it far inside both limits.
export function packReport(bundle: ReportBundle): Uint8Array<ArrayBuffer> {
  const json = Buffer.from(JSON.stringify(bundle));
  const gzip = gzipSync(json);
  if (json.byteLength > REPORT_JSON_MAX || gzip.byteLength > REPORT_GZIP_MAX)
    throw new Error("The report is too large to send.");
  return gzip;
}
