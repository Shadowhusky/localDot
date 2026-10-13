import { type ActionClass, clipText, type ToolResult } from "@localdot/protocol";
import type { TaskConnectorTool } from "../../connectors/hub.ts";
import type { RiskFacts } from "../safety/risk.ts";
import { untrusted } from "../untrusted.ts";
import { append, fail, type ToolCallContext, type ToolDeps, text } from "./deps.ts";

export function connectorFacts(entry: TaskConnectorTool, actionClass: ActionClass): RiskFacts {
  return {
    operation: "connector",
    connector: {
      app: entry.app,
      tool: entry.tool,
      exposed: entry.exposed,
      actionClass,
      ...(entry.host ? { host: entry.host } : {}),
    },
  };
}

// A tool's name for people: words, not snake case.
export function toolWords(tool: string): string {
  const words = tool
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-./]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0]?.toUpperCase() + words.slice(1) : tool;
}

// One call to a connected app, once it was authorized: the app's answer reaches dot as untrusted
// data, and the task counts as having read private data from the app.
export async function connectorTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  entry: TaskConnectorTool,
  args: Record<string, unknown>,
  intent: string | undefined,
): Promise<ToolResult> {
  ctx.check();
  if (!ctx.permit?.consume(args, null))
    return fail("Execution approval is unavailable or already used. Do not retry automatically.");
  const hub = deps.connectors;
  if (!hub) return fail("Connected apps aren't available.");
  const line = intent ? clipText(ctx.redact(intent), 120) : "";
  append(ctx, "step.start", { kind: "app", ...(line ? { intent: line } : {}) });
  append(ctx, "tool.start", {
    tool: entry.exposed,
    title: clipText(`${entry.app} · ${toolWords(entry.tool)}`, 200),
  });
  const outcome = await hub.call(entry, args, ctx.signal);
  ctx.check();
  const said = outcome.text || (outcome.ok ? "(The app returned nothing.)" : "The call failed.");
  ctx.session.tainted = true;
  if (outcome.text) ctx.session.taint.add("app", entry.host ?? entry.app, outcome.text);
  append(ctx, "tool.end", { ok: outcome.ok });
  append(ctx, "step.end", {
    status: outcome.ok ? "ok" : "failed",
    ...(outcome.ok ? {} : { note: clipText(said, 300) }),
  });
  return {
    ok: outcome.ok,
    ...(outcome.recovery ? { recovery: outcome.recovery } : {}),
    content: [text(untrusted(`${entry.app}, a connected app`, ctx.redact(said)))],
  };
}
