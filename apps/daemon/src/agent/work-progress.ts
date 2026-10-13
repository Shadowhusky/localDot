import { createHash } from "node:crypto";
import { recoveryAdvice, type ToolRecovery, type ToolResult } from "@localdot/protocol";

function canonical(value: unknown, top = false): unknown {
  if (Array.isArray(value)) return value.map((item) => canonical(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !top || (key !== "intent" && key !== "basedOn"))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

// Runtime diagnostics, not an authorization source. Bounded and daemon-owned, shared by API,
// Codex and Claude. Store hashes, never raw arguments, command output, URLs or credentials.
export class WorkProgress {
  #attempts = new Map<string, number>();
  #last = new Map<string, { tool: string; ok: boolean; at: string; recovery?: ToolRecovery }>();
  #epoch = "";
  reset(epoch: string): void {
    if (epoch === this.#epoch) return;
    this.#epoch = epoch;
    this.#attempts.clear();
    this.#last.clear();
  }
  snapshot() {
    return [...this.#last.values()];
  }
  record(tool: string, input: unknown, result: ToolResult): ToolResult {
    if (result.pause || result.final || tool === "work_context") return result;
    const digest = createHash("sha256")
      .update(JSON.stringify([tool, canonical(input, true)]))
      .digest("hex");
    if (result.ok) this.#attempts.delete(digest);
    else if (!result.cancelled) {
      const count = Math.min(1000, (this.#attempts.get(digest) ?? 0) + 1);
      this.#attempts.delete(digest);
      this.#attempts.set(digest, count);
      if (this.#attempts.size > 32) {
        const oldest = this.#attempts.keys().next().value;
        if (oldest !== undefined) this.#attempts.delete(oldest);
      }
      // Preserve stronger no-retry/auth/permission instructions. A nudge cannot grant a retry.
      if (count >= 2)
        result = {
          ...result,
          recovery: {
            ...(result.recovery ?? {
              kind: "repeated_failure",
              surface: "runtime",
              retry: "after_change",
            }),
            repeated: count,
          },
        };
    }
    this.#last.delete(tool);
    this.#last.set(tool, {
      tool,
      ok: result.ok,
      at: new Date().toISOString(),
      ...(result.recovery ? { recovery: result.recovery } : {}),
    });
    if (this.#last.size > 16) {
      const oldest = this.#last.keys().next().value;
      if (oldest !== undefined) this.#last.delete(oldest);
    }
    return result;
  }
}

export function withRecoveryAdvice(result: ToolResult): ToolResult {
  const recovery =
    result.recovery ??
    (result.cancelled === "stale"
      ? { kind: "stale" as const, surface: "runtime" as const, retry: "after_observation" as const }
      : undefined);
  return recovery
    ? {
        ...result,
        recovery,
        content: [
          ...result.content,
          {
            type: "text",
            text: `Recovery (${recovery.surface}; ${recovery.retry}): ${recoveryAdvice(recovery)}${recovery.repeated ? ` This attempt has failed ${recovery.repeated} times; do not repeat it unchanged.` : ""}`,
          },
        ],
      }
    : result;
}
