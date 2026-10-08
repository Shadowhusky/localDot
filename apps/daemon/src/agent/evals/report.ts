import type { Phase, PhaseSummary, RunAnalysis } from "./analyse.ts";
import type { Verdict } from "./checks.ts";
import type { AgentRun } from "./stack.ts";

export type TaskStatus = "pass" | "fail" | "expected-fail" | "unexpected-pass";

export interface TaskReport {
  id: string;
  requires: string[];
  status: TaskStatus;
  reasons: string[];
  noopRejected: boolean;
  outcome: string;
  error?: string;
  wallSeconds: number;
  modelTurns: number;
  toolCalls: number;
  failedCalls: number;
  skippedCalls: number;
  guiActions: number;
  approvals: number;
  approvalTimeouts: number;
  handoffs: number;
  staleCancels: number;
  repeatPauses: number;
  phases: Record<Phase, PhaseSummary | null>;
  costUSD: number;
}

export interface EvalReport {
  mode: "oracle" | "model";
  model?: string;
  generatedAt: string;
  image: string;
  ok: boolean;
  problems: string[];
  tasks: TaskReport[];
}

export interface Prices {
  inputUSDPerMTok: number;
  outputUSDPerMTok: number;
}

export function taskReport(input: {
  id: string;
  requires: readonly string[];
  landed: boolean;
  verdict: Verdict;
  noop: Verdict;
  run: Pick<AgentRun, "outcome" | "error" | "wallMs" | "calls">;
  analysis: RunAnalysis;
  prices?: Prices;
}): TaskReport {
  const { verdict, run, analysis } = input;
  const status: TaskStatus = input.landed
    ? verdict.ok
      ? "pass"
      : "fail"
    : verdict.ok
      ? "unexpected-pass"
      : "expected-fail";
  const costUSD = input.prices
    ? (analysis.inputTokens * input.prices.inputUSDPerMTok +
        analysis.outputTokens * input.prices.outputUSDPerMTok) /
      1e6
    : 0;
  return {
    id: input.id,
    requires: [...input.requires],
    status,
    reasons: verdict.reasons,
    noopRejected: !input.noop.ok,
    outcome: run.outcome,
    ...(run.error ? { error: run.error } : {}),
    wallSeconds: run.wallMs / 1000,
    modelTurns: analysis.modelTurns,
    toolCalls: run.calls.length,
    failedCalls: run.calls.filter((c) => !c.ok && !c.skipped).length,
    skippedCalls: run.calls.filter((c) => c.skipped).length,
    guiActions: analysis.guiActions,
    approvals: analysis.approvals,
    approvalTimeouts: analysis.approvalTimeouts,
    handoffs: analysis.handoffs,
    staleCancels: analysis.staleCancels,
    repeatPauses: analysis.repeatPauses,
    phases: analysis.phases,
    costUSD,
  };
}

// The suite holds when every task whose capabilities have landed passes, no expected failure
// passes unnoticed (it should become required), and every checker rejected the no-op run.
export function suiteReport(
  tasks: TaskReport[],
  meta: Pick<EvalReport, "mode" | "model" | "generatedAt" | "image">,
): EvalReport {
  const problems = tasks.flatMap((t) => [
    ...(t.status === "fail"
      ? [`${t.id} failed: ${t.reasons.join("; ") || t.error || t.outcome}`]
      : []),
    ...(t.status === "unexpected-pass"
      ? [`${t.id} passed although it requires ${t.requires.join(", ")}; make it required`]
      : []),
    ...(t.noopRejected ? [] : [`${t.id}: the checker accepted a run that did nothing`]),
  ]);
  return { ...meta, ok: problems.length === 0, problems, tasks };
}

const PHASE_COLUMNS: [Phase, string][] = [
  ["preAuth", "Pre-auth"],
  ["approvalWait", "Approval"],
  ["revalidate", "Revalidate"],
  ["travelFreshness", "Travel+fresh"],
  ["consume", "Consume"],
  ["settle", "Settle"],
  ["finalObserve", "Final observe"],
  ["totalExclApproval", "Action total"],
  ["modelLatency", "Model"],
];

const seconds = (s: PhaseSummary | null) => (s ? s.median.toFixed(1) : "–");

export function markdownReport(report: EvalReport): string {
  const header = [
    "Task",
    "Result",
    "Turns",
    "Calls (failed/skipped)",
    "Wall s",
    ...PHASE_COLUMNS.map(([, label]) => label),
    "Approvals",
    "Hand-offs",
    "Stale",
    "Repeat pauses",
    "Cost $",
  ];
  const rows = report.tasks.map((t) => [
    t.id,
    t.status,
    String(t.modelTurns),
    `${t.toolCalls} (${t.failedCalls}/${t.skippedCalls})`,
    t.wallSeconds.toFixed(1),
    ...PHASE_COLUMNS.map(([phase]) => seconds(t.phases[phase])),
    String(t.approvals),
    String(t.handoffs),
    String(t.staleCancels),
    String(t.repeatPauses),
    t.costUSD.toFixed(4),
  ]);
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [
    `# Desktop eval (${report.mode}${report.model ? `, ${report.model}` : ""})`,
    "",
    `${report.generatedAt} · image ${report.image} · ${report.ok ? "suite holds" : "suite fails"}`,
    "",
    "Phase columns are medians in seconds per GUI action; Model is the median model call.",
    "",
    line(header),
    line(header.map(() => "---")),
    ...rows.map(line),
    "",
    ...(report.problems.length ? ["Problems:", ...report.problems.map((p) => `- ${p}`), ""] : []),
    ...report.tasks
      .filter((t) => t.reasons.length)
      .map((t) => `- ${t.id}: ${t.reasons.join("; ")}`),
    "",
  ].join("\n");
}
