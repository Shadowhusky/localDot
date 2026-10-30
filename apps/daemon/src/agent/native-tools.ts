import type { Redactor } from "./redact.ts";

// A tool name that Claude Code, Codex or their model reported, in the only form localDot logs,
// shows or switches off: a plain identifier. Nothing that came with the call is ever kept.
const NAME = /^[A-Za-z0-9_-]{1,128}$/;
export const UNNAMED_TOOL = "an unnamed tool";

export const plainToolName = (name: unknown): string | undefined =>
  typeof name === "string" && NAME.test(name) ? name : undefined;

export function toolLabel(name: unknown, redact?: Redactor): string {
  const plain = plainToolName(name);
  if (!plain || (redact && redact(plain) !== plain)) return UNNAMED_TOOL;
  return plain.length > 64 ? `${plain.slice(0, 63)}…` : plain;
}

export function toolList(labels: readonly string[]): string {
  const [first, ...rest] = [...new Set(labels)];
  return rest.length ? `${first} and ${rest.length} more` : (first ?? UNNAMED_TOOL);
}

export const RETRY_NEXT =
  "Send your message again to continue. If it happens again, choose another model in Settings.";
