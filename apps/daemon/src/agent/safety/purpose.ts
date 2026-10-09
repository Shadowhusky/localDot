import { createHash } from "node:crypto";
import {
  isJevKey,
  type KeydRecord,
  type PurposeCheck,
  type TaintKind,
  type ToolName,
} from "@localdot/protocol";
import type { RiskFacts } from "./risk.ts";
import type { TaskTaint } from "./taint.ts";

// The user's own words and dot's plan for them: trusted, and all the judge reads besides the
// action's shape.
export interface Purpose {
  readonly request: readonly string[];
  readonly plan: readonly string[];
}
export type OutboundShape = "web_address" | "web_address_with_parameters" | "text" | "command";
// What the judge is told about an action. Never the outbound text itself, nor anything read.
export interface JudgeAction {
  readonly kind: "open_page" | "enter_text" | "run_command";
  readonly destination: string;
  readonly method: "GET" | "typed" | "command";
  readonly bytes: number;
  readonly shape: OutboundShape;
  readonly overlapsPrivateText: boolean;
  readonly privateData: readonly TaintKind[];
}
export interface PurposeJudge {
  readonly name: "jev" | "model";
  // The hosts the request plainly needs; a judge that cannot name them returns none.
  destinations(purpose: Purpose, signal: AbortSignal): Promise<readonly string[]>;
  // The probability that the request needs this action.
  fits(purpose: Purpose, action: JudgeAction, signal: AbortSignal): Promise<number>;
}
// Data about to leave for a host. The text stays here, for the overlap check.
export interface Outbound {
  readonly kind: JudgeAction["kind"];
  readonly destination: string;
  readonly text: string;
}
export type PurposeVerdict =
  | { readonly allow: true }
  | { readonly allow: false; readonly destination: string; readonly why: string };

export type JudgeChoice =
  | { readonly kind: "jev"; readonly secretId: string }
  | { readonly kind: "model" };

// Auto: Jev when a Jev key is saved, else the fast model when one is set, else nothing.
export function judgeChoice(
  check: PurposeCheck | undefined,
  keys: readonly KeydRecord[],
  fastModel: boolean,
): JudgeChoice | undefined {
  if (check === "off") return undefined;
  const jev = keys
    .filter(isJevKey)
    .map((key) => key.id)
    .sort()[0];
  if (jev) return { kind: "jev", secretId: jev };
  return fastModel ? { kind: "model" } : undefined;
}

export const FITS_THRESHOLD = 0.75;
export const JUDGE_TIMEOUT_MS = 3_000;
const DOWN_MS = 30_000;

const HOST =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const MENTIONED =
  /(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9])(?=[/:?#\s"')\],.;!]|$)/gi;
const COMMAND_URL = /\bhttps?:\/\/([^/\s'"`:?#]+)/gi;

export function hostOf(value: string | undefined): string | undefined {
  if (!value || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) return undefined;
  const host = url.hostname.toLowerCase();
  return HOST.test(host) ? host : undefined;
}

// A host matches a named one when it is that host or under it: mail.example.com for example.com.
export function within(host: string, named: string): boolean {
  return host === named || host.endsWith(`.${named}`);
}

// Hosts written in the request or plan, as addresses or bare names.
export function mentionedHosts(purpose: Purpose): string[] {
  const found = new Set<string>();
  for (const text of [...purpose.request, ...purpose.plan])
    for (const match of text.matchAll(MENTIONED)) {
      const host = match[1]?.toLowerCase().replace(/^www\./, "");
      if (host && HOST.test(host) && !/^\d/.test(host.split(".").at(-1) ?? "")) found.add(host);
    }
  return [...found];
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

// What an action would carry to a host, if anything. Opening a site's front page carries nothing;
// typing into a desktop app or a field whose page is unknown carries nothing to a host either.
export function outboundOf(tool: ToolName, input: unknown, facts: RiskFacts): Outbound[] {
  const object = (input ?? {}) as Record<string, unknown>;
  if (tool === "browser_navigate" && typeof object.url === "string") {
    const destination = hostOf(object.url);
    if (!destination) return [];
    const url = new URL(object.url);
    const carried = decoded(`${url.pathname.replace(/^\/$/, "")}${url.search}${url.hash}`);
    return carried ? [{ kind: "open_page", destination, text: carried }] : [];
  }
  if (tool === "computer") {
    const action = (object.action ?? {}) as Record<string, unknown>;
    const destination = hostOf(facts.target?.url);
    if (action.verb !== "type" || typeof action.text !== "string" || !destination) return [];
    return action.text ? [{ kind: "enter_text", destination, text: action.text }] : [];
  }
  if (tool === "shell" && typeof object.command === "string") {
    const command = object.command;
    const hosts = new Set(
      [...command.matchAll(COMMAND_URL)].flatMap((match) => {
        const host = match[1]?.toLowerCase();
        return host && HOST.test(host) ? [host] : [];
      }),
    );
    return [...hosts].map((destination) => ({ kind: "run_command", destination, text: command }));
  }
  return [];
}

const SOURCE_WORDS: Readonly<Record<TaintKind, string>> = {
  screen: "pages from your accounts",
  memory: "what it remembers about you",
  files: "your files",
  recall: "your past conversations",
};

function listed(kinds: readonly TaintKind[]): string {
  const words = kinds.map((kind) => SOURCE_WORDS[kind]);
  return words.length > 1
    ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`
    : (words[0] ?? "");
}

export function purposeWhy(
  reason: "unrelated" | "carries" | "unavailable",
  destination: string,
  kinds: readonly TaintKind[],
): string {
  const read = listed(kinds);
  if (reason === "carries")
    return `This sends text from ${read} to ${destination}, which doesn't look related to your request.`;
  if (reason === "unavailable")
    return `The purpose check couldn't tell whether ${destination} fits your request, and dot has read ${read} in this task.`;
  return `${destination} doesn't look related to your request, and dot has read ${read} in this task.`;
}

function digest(purpose: Purpose): string {
  return createHash("sha256").update(JSON.stringify(purpose.request)).digest("hex");
}

function timed<T>(work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, ms: number) {
  const timeout = AbortSignal.timeout(ms);
  const both = AbortSignal.any([signal, timeout]);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("the purpose check did not answer in time"));
    both.addEventListener("abort", abort, { once: true });
    work(both)
      .then(resolve, reject)
      .finally(() => both.removeEventListener("abort", abort));
    if (both.aborted) abort();
  });
}

export interface PurposeGateDeps {
  readonly taint: TaskTaint;
  purpose(): Purpose;
  // The judge in use; none when the purpose check is off or nothing can judge.
  judge(): PurposeJudge | undefined;
  // Hosts the user has saved Always allow choices for.
  trusted(host: string): boolean;
  now?(): number;
  timeoutMs?: number;
}

// Decides, per task, whether private data the task has read may go to a host. Only a tainted
// task sending something to a host outside its purpose asks; decisions are kept per host, so a
// host is judged once and an allowed host never asks again in the task.
export class PurposeGate {
  readonly #allowed = new Set<string>();
  readonly #refused = new Map<string, "unrelated" | "carries">();
  #derived: { key: string; hosts: Promise<readonly string[]> } | undefined;
  #downUntil = 0;
  constructor(private readonly deps: PurposeGateDeps) {}
  get #now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  // The user allowed this host for the task.
  allow(destination: string): void {
    this.#allowed.add(destination);
    this.#refused.delete(destination);
  }
  async check(outbound: readonly Outbound[], signal: AbortSignal): Promise<PurposeVerdict> {
    for (const each of outbound) {
      const verdict = await this.#one(each, signal);
      if (!verdict.allow) return verdict;
    }
    return { allow: true };
  }
  async #one(outbound: Outbound, signal: AbortSignal): Promise<PurposeVerdict> {
    const { taint } = this.deps;
    const host = outbound.destination;
    if (!taint.tainted || this.#allowed.has(host)) return { allow: true };
    const judge = this.deps.judge();
    if (!judge) return { allow: true };
    const purpose = this.deps.purpose();
    const key = digest(purpose);
    if (this.#derived && this.#derived.key !== key) this.#refused.clear();
    const kinds = taint.kinds;
    const ask = (reason: "unrelated" | "carries" | "unavailable"): PurposeVerdict => ({
      allow: false,
      destination: host,
      why: purposeWhy(reason, host, kinds),
    });
    const pass = (): PurposeVerdict => {
      this.#allowed.add(host);
      return { allow: true };
    };
    const back = taint.origins("screen").some((origin) => within(host, origin));
    if (back || this.deps.trusted(host)) return pass();
    if (mentionedHosts(purpose).some((named) => within(host, named))) return pass();
    const refused = this.#refused.get(host);
    if (refused) return ask(refused);
    const overlap = taint.overlap(outbound.text);
    if (this.#now < this.#downUntil) return ask("unavailable");
    try {
      if (this.#derived?.key !== key) {
        const hosts = timed((s) => judge.destinations(purpose, s), signal, this.#timeout);
        hosts.catch(() => {});
        this.#derived = { key, hosts };
      }
      const derived = await this.#derived.hosts;
      if (derived.some((named) => within(host, named))) return pass();
      const bytes = Buffer.byteLength(outbound.text);
      const p = await timed(
        (s) =>
          judge.fits(
            purpose,
            {
              kind: outbound.kind,
              destination: host,
              method:
                outbound.kind === "open_page"
                  ? "GET"
                  : outbound.kind === "enter_text"
                    ? "typed"
                    : "command",
              bytes,
              shape: shapeOf(outbound),
              overlapsPrivateText: overlap.overlaps,
              privateData: kinds,
            },
            s,
          ),
        signal,
        this.#timeout,
      );
      signal.throwIfAborted();
      if (Number.isFinite(p) && p >= FITS_THRESHOLD) return pass();
      const reason = overlap.overlaps ? "carries" : "unrelated";
      this.#refused.set(host, reason);
      return ask(reason);
    } catch {
      signal.throwIfAborted();
      if (this.#derived?.key === key) this.#derived = undefined;
      this.#downUntil = this.#now + DOWN_MS;
      return ask("unavailable");
    }
  }
  get #timeout(): number {
    return this.deps.timeoutMs ?? JUDGE_TIMEOUT_MS;
  }
}

function shapeOf(outbound: Outbound): OutboundShape {
  if (outbound.kind === "run_command") return "command";
  if (outbound.kind === "enter_text") return "text";
  return outbound.text.includes("?") ? "web_address_with_parameters" : "web_address";
}
