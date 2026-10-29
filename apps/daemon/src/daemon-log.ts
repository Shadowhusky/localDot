import { redactor } from "./agent/redact.ts";

// Keep lifecycle and component logs on the same UTC clock, including messages emitted by modules.
export function timestampLogs(
  target: Pick<Console, "log" | "warn" | "error"> = console,
  now = () => new Date().toISOString(),
): void {
  for (const level of ["log", "warn", "error"] as const) {
    const write = target[level].bind(target);
    target[level] = (...args: unknown[]) => write(`[${now()}]`, ...args);
  }
}

const redactSurrogates = redactor([]);

/** Whole-line sanitization before terminal output. Producers must still avoid logging secrets. */
export function displayLogLine(raw: string): string {
  return redactSurrogates(raw)
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
    .replace(/([#?&](?:code|token)=)[^\s"'<>]*/gi, "$1[redacted]")
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,
      "$1[redacted]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) =>
      char === "\t" ? "  " : `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0")}`,
    );
}
