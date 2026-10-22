import {
  type AgentSettingsDocument,
  isJevKey,
  JEV_HOST,
  JEV_MODEL,
  type KeydRecord,
  type PurposeCheckStatus,
} from "@localdot/protocol";
import { activeRoles } from "../bindings.ts";
import { jevFits, jevRequest } from "./judges.ts";

type Stats = Pick<PurposeCheckStatus, "calls" | "succeeded" | "failed" | "last">;
const empty = (): Stats => ({ calls: 0, succeeded: 0, failed: 0 });
interface Deps {
  keys(): Promise<KeydRecord[]>;
  settings(): AgentSettingsDocument;
  post(key: string, body: unknown, signal: AbortSignal): Promise<unknown>;
}

// Observe the same transport used by real tasks. Never retain prompts, answers, or credentials.
export class PurposeService {
  private readonly stats = new Map<string, Stats>();
  private testing?: Promise<PurposeCheckStatus>;
  constructor(private readonly deps: Deps) {}
  async status(): Promise<PurposeCheckStatus> {
    const settings = this.deps.settings();
    let keys: KeydRecord[];
    try {
      keys = await this.deps.keys();
    } catch {
      return { mode: "unavailable", host: JEV_HOST, model: JEV_MODEL, ...empty() };
    }
    const key = keys.filter(isJevKey).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
    return {
      mode:
        settings.purposeCheck === "off"
          ? "off"
          : settings.permissionMode === "full"
            ? "bypassed"
            : key || activeRoles(settings).fast
              ? "active"
              : "unconfigured",
      ...(key ? { keyId: key.id } : {}),
      host: JEV_HOST,
      model: JEV_MODEL,
      ...(key ? (this.stats.get(key.id) ?? empty()) : empty()),
    };
  }
  async post(
    key: string,
    body: unknown,
    signal: AbortSignal,
    kind: "task" | "test" = "task",
  ): Promise<unknown> {
    const stats = this.stats.get(key) ?? empty();
    this.stats.set(key, stats);
    stats.calls++;
    const started = Date.now();
    try {
      const reply = await this.deps.post(key, body, signal);
      jevFits(reply); // HTTP 200 alone does not verify a usable judgment.
      const model = (reply as { model?: unknown }).model;
      stats.succeeded++;
      stats.last = {
        at: new Date().toISOString(),
        kind,
        ok: true,
        latencyMs: Date.now() - started,
        ...(typeof model === "string" && /^[a-zA-Z0-9._/-]{1,100}$/.test(model) ? { model } : {}),
      };
      return reply;
    } catch (error) {
      stats.failed++;
      // Only allowlisted error summaries can reach the browser; upstream errors may contain secrets.
      const http =
        error instanceof Error ? /^Jev answered (\d{3})$/.exec(error.message)?.[1] : undefined;
      stats.last = {
        at: new Date().toISOString(),
        kind,
        ok: false,
        latencyMs: Date.now() - started,
        problem: signal.aborted
          ? "Jev request timed out or was cancelled."
          : http
            ? `Jev returned HTTP ${http}. Check the key, account balance and rate limits.`
            : "Jev could not return a valid answer. Check the key layer and connection.",
      };
      throw error;
    }
  }
  test(): Promise<PurposeCheckStatus> {
    // Double clicks and concurrent clients share one bounded diagnostic request.
    if (this.testing) return this.testing;
    const testing = this.runTest();
    this.testing = testing;
    void testing
      .finally(() => {
        if (this.testing === testing) this.testing = undefined;
      })
      .catch(() => {});
    return testing;
  }
  private async runTest(): Promise<PurposeCheckStatus> {
    const status = await this.status();
    if (!status.keyId) return status;
    const body = jevRequest(
      { request: ["Read the public TypeSafe API documentation."], plan: [] },
      {
        kind: "open_page",
        destination: "docs.typesafe.ai",
        method: "GET",
        bytes: 0,
        shape: "web_address",
        overlapsPrivateText: false,
        privateData: [],
      },
    );
    await this.post(status.keyId, body, AbortSignal.timeout(10_000), "test").catch(() => {});
    return this.status();
  }
}
