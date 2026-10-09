import { z } from "zod";

// Research mode: dot gathers many sources, keeps a numbered list of them, and writes a cited
// report. The budget is soft: once it is reached dot stops gathering and writes with what it has.
export const ResearchBudget = z.strictObject({
  sources: z.number().int().min(3).max(100),
  minutes: z.number().int().min(2).max(120),
});
export type ResearchBudget = z.infer<typeof ResearchBudget>;
export const DEFAULT_RESEARCH_BUDGET: ResearchBudget = Object.freeze({ sources: 20, minutes: 15 });
// What "Keep going" adds to a reached budget.
export const MORE_RESEARCH: ResearchBudget = Object.freeze({ sources: 10, minutes: 10 });
export const MAX_RESEARCH_SOURCES = 200;

// Why gathering stopped: the sources or the time ran out, or the user said to wrap up.
export const ResearchStop = z.enum(["sources", "time", "user"]);
export type ResearchStop = z.infer<typeof ResearchStop>;

export const ResearchSourceData = z.strictObject({
  n: z.number().int().min(1).max(MAX_RESEARCH_SOURCES),
  url: z.string().max(2048),
  title: z.string().max(300),
  // How many passages dot recorded from it.
  passages: z.number().int().min(0).max(100),
  // The report cites it.
  cited: z.literal(true).optional(),
});
export type ResearchSourceData = z.infer<typeof ResearchSourceData>;

export const ResearchBudgetData = z.strictObject({
  ...ResearchBudget.shape,
  stopped: ResearchStop.optional(),
});
export type ResearchBudgetData = z.infer<typeof ResearchBudgetData>;

// The user's change to a running research task's budget.
export const ResearchChange = z.strictObject({ change: z.enum(["wrap_up", "more"]) });
export type ResearchChange = z.infer<typeof ResearchChange>;

// One flat shape for every op (spec "Catalog": no unions in tool schemas).
export const ResearchInput = z.object({
  op: z.enum(["source", "pdf", "report"]),
  url: z.string().min(1).max(2048).optional(),
  title: z.string().min(1).max(300).optional(),
  passages: z.array(z.string().min(1).max(1500)).min(1).max(8).optional(),
  summary: z.string().min(1).max(4000).optional(),
  body: z.string().min(1).max(100_000).optional(),
  file: z.string().min(1).max(100).optional(),
});
export type ResearchInput = z.infer<typeof ResearchInput>;

export const RESEARCH_TOOL_DESCRIPTION =
  "Research mode's source list and report. op source: record a page or file you rely on (url, title, " +
  "passages: up to 8 exact quotes you use); pages you read with web_fetch or browser_read are listed by " +
  "themselves, so add their passages here. Returns the number to cite as [n]. op pdf: read a PDF by its " +
  "url; it is downloaded in the computer, its text comes back and it becomes a source. op report: write " +
  "the report from title, summary (2 to 4 sentences) and body (Markdown, organised by sub-question, with " +
  "[n] after each claim); the sources section is added for you, and file names it. Returns the Markdown " +
  "and PDF paths to hand over with done.";
