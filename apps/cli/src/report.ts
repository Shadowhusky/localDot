import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { type ReportBundle, ReportDraft } from "../../../packages/protocol/src/reports.ts";
import { buildReport, packReport } from "../../daemon/src/reports/bundle.ts";
import {
  deleteSentReport,
  ReportServiceError,
  reportsUrl,
  sendReport,
} from "../../daemon/src/reports/service.ts";
import { ReportStore } from "../../daemon/src/reports/store.ts";
import type { ReportCommand } from "./args.ts";
import { connect, fail, LocalApiError, type LocalDot } from "./local-dot.ts";
import type { ConsoleIO } from "./runtime.ts";

export interface ReportDeps {
  env: NodeJS.ProcessEnv;
  version: string;
  // Where --dry-run saves the report.
  cwd: string;
  // Asks on the terminal; absent when there is no terminal to ask on.
  confirm?(question: string, signal: AbortSignal): Promise<boolean>;
  fetch?: typeof fetch;
  now?(): Date;
}

export function terminalConfirm(): ReportDeps["confirm"] {
  if (!process.stdin.isTTY) return undefined;
  return async (question, signal) => {
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return /^y(?:es)?$/i.test((await terminal.question(question, { signal })).trim());
    } finally {
      terminal.close();
    }
  };
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

// What the report holds, line by line, under the full text it prints before asking.
function described(bundle: ReportBundle, bytes: number): string[] {
  const failed = bundle.doctor?.filter((check) => !check.ok).length ?? 0;
  const rows: [string, string][] = [
    ["Summary", bundle.summary],
    ["Your words", bundle.message ?? "none"],
    [
      "localDot",
      `${bundle.app.version} (${bundle.app.channel}, ${bundle.app.install}) on ${bundle.host.os} ${bundle.host.release} ${bundle.host.arch}`,
    ],
    [
      "Checks",
      bundle.doctor
        ? `${bundle.doctor.length}, ${failed ? `${failed} failed` : "all passed"}`
        : "not run: localDot isn't answering",
    ],
    ["Computers", String(bundle.computers.length)],
    ["Recent tasks", `${bundle.tasks.length} (states and reasons only)`],
    [
      "Logs",
      bundle.logs.map((log) => `${log.name} (${log.lines.length} lines)`).join(", ") || "none",
    ],
    ["Size", `${kb(bytes)} compressed`],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return [
    "What this report holds:",
    ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value.split("\n")[0]}`),
    "Keys, sign-in links, emails, addresses and your user and computer names are removed.",
  ];
}

// The report: from the daemon, which knows its computers and runs its checks, or from the log
// files when it isn't answering, which is when a report matters most.
async function made(
  l: LocalDot,
  store: ReportStore,
  message: string | undefined,
  deps: ReportDeps,
  io: ConsoleIO,
): Promise<ReportBundle> {
  const app = await l.app();
  if (app === "running") {
    const api = await connect(l);
    const draft = ReportDraft.parse(
      await api("POST", "/api/reports/drafts", { source: "cli", message }, 60_000),
    );
    return draft.bundle;
  }
  io.err(
    `${l.name} ${app === "stopped" ? "isn't running" : "isn't answering"}, so this report is made from its log files.`,
  );
  const [keyd, docker, services] = await Promise.all([
    l.keyd(),
    l.docker(),
    l.services?.exists(l.dot).catch(() => false),
  ]);
  return buildReport({
    home: l.home,
    installId: store.installId(),
    facts: {
      version: deps.version,
      install: l.managed ? "managed" : services ? "services" : "source",
      app,
      keyd,
      docker: docker ? "running" : "stopped",
      computers: [],
    },
    ask: { source: "cli", ...(message ? { message } : {}) },
    ...(deps.now ? { now: deps.now() } : {}),
  });
}

export async function runReport(
  l: LocalDot,
  io: ConsoleIO,
  command: ReportCommand,
  deps: ReportDeps,
): Promise<number> {
  const store = new ReportStore(l.home);
  let base: URL;
  try {
    base = reportsUrl(deps.env);
  } catch (error) {
    return fail((error as Error).message);
  }
  try {
    if (command.operation === "delete") {
      const sent = store.find(command.id);
      if (!sent)
        fail(
          `${l.name} didn't send ${command.id}. Only the localDot that sent a report can delete it.`,
        );
      await deleteSentReport(store, base, sent, l.signal, deps.fetch);
      io.out(`Deleted ${command.id} and its diagnostics.`);
      return 0;
    }
    if (!store.read().enabled)
      fail(
        `Problem reports are turned off for ${l.name}. Turn them on in Settings › Report a problem.`,
      );
    const bundle = await made(l, store, command.message, deps, io);
    const gzip = packReport(bundle);
    if (command.dryRun) {
      const at = (deps.now?.() ?? new Date()).toISOString().slice(0, 19).replace(/:/g, "-");
      const file = join(deps.cwd, `localdot-report-${at}.json`);
      writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      io.out(
        command.json
          ? JSON.stringify({ file, bytes: gzip.byteLength })
          : `Saved the report to ${file}. Nothing was sent.`,
      );
      return 0;
    }
    if (!command.yes) {
      if (command.json || !deps.confirm)
        fail(
          "Review the report in a terminal, or add --yes to send it as it is, or --dry-run to save it to a file.",
        );
      io.out(JSON.stringify(bundle, null, 2));
      io.out("");
      for (const line of described(bundle, gzip.byteLength)) io.out(line);
      if (!(await deps.confirm(`Send this report to ${base.host}? [y/N] `, l.signal))) {
        io.out("Nothing was sent.");
        return 1;
      }
    } else if (!command.json) for (const line of described(bundle, gzip.byteLength)) io.out(line);
    const sent = await sendReport(store, base, bundle, gzip, l.signal, deps.fetch);
    if (command.json) io.out(JSON.stringify(sent));
    else {
      io.out(`Sent. Report ID: ${sent.id}`);
      io.out(
        `Quote ${sent.id} when you ask for help. To delete it: localdot report delete ${sent.id}${l.dotFlag}`,
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof ReportServiceError || error instanceof LocalApiError) fail(error.message);
    throw error;
  }
}
