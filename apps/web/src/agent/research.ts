import type { ResearchSourceData } from "@localdot/protocol";
import { count } from "../copy/format.ts";
import { clock } from "./activity.ts";
import type { AgentResearch } from "./model.ts";
import type { AgentSessionView } from "./useAgentSession.ts";

// Where a source lives, as people say it: the site without "www.".
export function sourceSite(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function sourceMeta(source: ResearchSourceData): string {
  return [
    sourceSite(source.url),
    source.passages ? count(source.passages, "passage", "passages") : "",
    source.cited ? "Cited" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

// The section's quiet count: how far through the budget while dot reads, then what it read and
// cited once the report is written.
export function researchMeta(research: AgentResearch, nowMs: number | undefined): string {
  const read = research.sources.length;
  const cited = research.sources.filter((source) => source.cited).length;
  if (cited) return `${read} read · ${cited} cited`;
  if (research.stopped) return `${count(read, "source", "sources")} · writing the report`;
  const time =
    nowMs === undefined
      ? ""
      : ` · ${clock(Math.max(0, nowMs - research.startMs))} of ${clock(research.budget.minutes * 60_000)}`;
  return `${read} of ${research.budget.sources}${time}`;
}

// How much of the budget is used: the larger share of sources and minutes, whole once stopped.
export function researchUsed(research: AgentResearch, nowMs: number | undefined): number {
  if (research.stopped || research.sources.some((source) => source.cited)) return 1;
  const sources = research.sources.length / research.budget.sources;
  const minutes =
    nowMs === undefined ? 0 : (nowMs - research.startMs) / (research.budget.minutes * 60_000);
  return Math.min(1, Math.max(0, sources, minutes));
}

export const STOP_WORDS = {
  sources: "dot has its sources and is writing the report.",
  time: "Time is up: dot is writing the report.",
  user: "dot is wrapping up with what it has.",
} as const;

const STRONG = [
  /\bresearch\b/,
  /\bdeep[- ]dive\b/,
  /\bliterature\b/,
  /\bpros and cons\b/,
  /\b(?:compare|comparison|versus|vs\.?)\b/,
  /\b(?:sources|citations?|cite|references)\b/,
  /\bstate of the art\b/,
  /\b(?:report|overview|survey|analysis|review) (?:on|of)\b/,
  /\bwhat (?:are|is) the (?:best|latest|evidence)\b/,
  /\b(?:studies|evidence|statistics|market size)\b/,
  /调研|研究|对比|比较|文献|报告|综述/,
];
// Tasks that act rather than ask: dot does these, it doesn't research them.
const ACTION =
  /^(?:please\s+)?(?:send|book|buy|order|open|draw|install|reply|schedule|pay|delete|upload|sign in|log in|click|play|turn|set up|fill|download|email|message|call|text)\b/;

// Whether a message reads like a question that needs many sources: then dot suggests Research.
export function looksLikeResearch(text: string): boolean {
  const said = text.trim().toLowerCase();
  if (said.length < 12 || ACTION.test(said)) return false;
  // Chinese and Japanese have no spaces: about one word per one and a half characters.
  const cjk = said.match(/[\u3040-\u30ff\u3400-\u9fff]/g)?.length ?? 0;
  const words = Math.max(said.split(/\s+/).length, Math.round(cjk / 1.5));
  const strong = STRONG.filter((pattern) => pattern.test(said)).length;
  const asks =
    /^(?:what|which|how|why|is|are|does|do|should|can)\b|[?？]$|哪|什么|如何|怎么|吗/.test(said);
  return strong >= 2 || (strong === 1 && (asks || words >= 8));
}

// Research is for a new task: while dot works on one, it waits for the next.
export function researchWait(
  agent: Pick<AgentSessionView, "sessionId" | "model" | "snapshot">,
): string | undefined {
  const working =
    !!agent.sessionId &&
    !agent.model.ended &&
    !agent.snapshot?.holder &&
    agent.snapshot?.status !== "idle";
  return working ? "Research starts with your next task." : undefined;
}

type Listener = () => void;
const listeners = new Set<Listener>();
// A phone's More menu asks the composer, which owns the message, to make it research.
export function requestResearch(): void {
  for (const listener of listeners) listener();
}
export function onResearchRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
