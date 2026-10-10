import type { LocalDotEvent } from "@localdot/protocol";
import { redactForIndex } from "../search/redact-index.ts";

// A bounded, deterministic checkpoint. Never copy typed values, raw tool output, or reasoning.
export function taskCheckpoint(events: readonly LocalDotEvent[]): string {
  let plan: string[] = [];
  const sites = new Set<string>();
  const steps = new Map<string, { label: string; status: string }>();
  const clean = (value: string, max = 180) =>
    redactForIndex(value).replace(/\s+/g, " ").slice(0, max);
  for (const event of events) {
    if (event.type === "plan.set")
      plan = event.data.items
        .slice(0, 6)
        .map((item) => `[${item.status}] ${clean(item.text, 220)}`);
    if (event.type === "action.target" && !event.data.target.secret && event.data.target.url) {
      try {
        const url = new URL(event.data.target.url);
        if (["http:", "https:"].includes(url.protocol)) {
          const location = clean(`${url.origin}${url.pathname}`, 240);
          sites.delete(location);
          sites.add(location);
          if (sites.size > 3) sites.delete(sites.values().next().value as string);
        }
      } catch {}
    }
    if (!event.step) continue;
    let label: string | undefined;
    if (event.type === "action.intent" && !["type", "wait"].includes(event.data.verb))
      label = event.data.label;
    if (event.type === "tool.start" && !["recall", "people", "shell"].includes(event.data.tool))
      label = event.data.title;
    if (label) {
      steps.set(event.step, { label: clean(label), status: "unconfirmed" });
      if (steps.size > 6) steps.delete(steps.keys().next().value as string);
    }
    if (event.type === "step.end") {
      const step = steps.get(event.step);
      if (step) step.status = event.data.status;
    }
  }
  const parts = [
    ...(plan.length ? [`Saved plan:\n${plan.join("\n")}`] : []),
    ...(sites.size
      ? [`Previously observed locations (may have changed):\n${[...sites].join("\n")}`]
      : []),
    ...(steps.size
      ? [
          `Recent actions (ok means the tool completed, not that the task is finished):\n${[...steps.values()].map((step) => `[${step.status}] ${step.label}`).join("\n")}`,
        ]
      : []),
  ];
  return parts.join("\n").slice(0, 2400);
}
