import type { Phase, PhaseSummary, RunAnalysis } from "./analyse.ts";
import type { Verdict } from "./checks.ts";
import type { AgentRun } from "./stack.ts";

// pass-assisted: the checker passed, but only after the simulated user did inputs the product
// handed over. error: the harness itself failed, so the run says nothing about the agent.
export type TaskStatus =
  | "pass"
  | "pass-assisted"
  | "fail"
  | "expected-fail"
  | "unexpected-pass"
  | "error";

export interface TaskReport {
  id: string;
  requires: string[];
  status: TaskStatus;
  reasons: string[];
  // Missing when the no-op run did not happen.
  noopRejected?: boolean;
  outcome: string;
  error?: string;
  harnessError?: string;
  wallSeconds: number;
  modelTurns: number;
  toolCalls: number;
  failedCalls: number;
  skippedCalls: number;
  refusedCalls: number;
  guiActions: number;
  approvals: number;
  approvalTimeouts: number;
  handoffs: number;
  maxHandoffs: number;
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
  noop?: Verdict;
  run: Pick<AgentRun, "outcome" | "error" | "wallMs" | "calls">;
  analysis: RunAnalysis;
  maxHandoffs: number;
  harnessError?: string;
  prices?: Prices;
}): TaskReport {
  const { verdict, run, analysis } = input;
  const refusedCalls = run.calls.filter((c) => c.refused).length;
  // A task waiting for a capability fails as expected only once the run has asked for it.
  const neverTried = !input.landed && !verdict.ok && refusedCalls === 0;
  const status: TaskStatus = input.harnessError
    ? "error"
    : input.landed
      ? verdict.ok
        ? analysis.handoffs > 0
          ? "pass-assisted"
          : "pass"
        : "fail"
      : verdict.ok
        ? "unexpected-pass"
        : neverTried
          ? "fail"
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
    reasons:
      neverTried && !input.harnessError
        ? [...verdict.reasons, `the run never tried ${input.requires.join(", ")}`]
        : verdict.reasons,
    ...(input.noop ? { noopRejected: !input.noop.ok } : {}),
    outcome: run.outcome,
    ...(run.error ? { error: run.error } : {}),
    ...(input.harnessError ? { harnessError: input.harnessError } : {}),
    wallSeconds: run.wallMs / 1000,
    modelTurns: analysis.modelTurns,
    toolCalls: run.calls.length,
    failedCalls: run.calls.filter((c) => !c.ok && !c.skipped).length,
    skippedCalls: run.calls.filter((c) => c.skipped).length,
    refusedCalls,
    guiActions: analysis.guiActions,
    approvals: analysis.approvals,
    approvalTimeouts: analysis.approvalTimeouts,
    handoffs: analysis.handoffs,
    maxHandoffs: input.maxHandoffs,
    staleCancels: analysis.staleCancels,
    repeatPauses: analysis.repeatPauses,
    phases: analysis.phases,
    costUSD,
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The suite holds when the harness ran every task, every task whose capabilities have landed
// passes within its hand-off ceiling, no expected failure passes unnoticed (it should become
// required), and every checker rejected the no-op run.
export function suiteReport(
  tasks: TaskReport[],
  meta: Pick<EvalReport, "mode" | "model" | "generatedAt" | "image">,
): EvalReport {
  const problems = tasks.flatMap((t) => [
    ...(t.harnessError ? [`${t.id}: the harness failed: ${t.harnessError}`] : []),
    ...(t.status === "fail"
      ? [`${t.id} failed: ${t.reasons.join("; ") || t.error || t.outcome}`]
      : []),
    ...(t.status === "unexpected-pass"
      ? [`${t.id} passed although it requires ${t.requires.join(", ")}; make it required`]
      : []),
    ...(t.handoffs > t.maxHandoffs
      ? [`${t.id} needed ${plural(t.handoffs, "hand-off")}; its ceiling is ${t.maxHandoffs}`]
      : []),
    ...(t.noopRejected === false ? [`${t.id}: the checker accepted a run that did nothing`] : []),
    ...(t.noopRejected === undefined && !t.harnessError
      ? [`${t.id}: the no-op run did not happen`]
      : []),
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
    "Hand-offs/max",
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
    `${t.handoffs}/${t.maxHandoffs}`,
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
    "Hand-offs are inputs the simulated user did for the agent; pass-assisted means it needed some.",
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
