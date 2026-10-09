import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  isJevKey,
  type KeydRecord,
  type PurposeCheck,
  type TaintKind,
  type ToolName,
} from "@localdot/protocol";
import { ownerOf } from "../../sites.ts";
import { commandLines } from "./classify.ts";
import type { RiskFacts } from "./risk.ts";
import type { TaskTaint } from "./taint.ts";

// The user's own words, and dot's plan as it stood before anything else reached the model: trusted,
// and all the judge reads besides the action's shape.
export interface Purpose {
  readonly request: readonly string[];
  readonly plan: readonly string[];
}
export type OutboundShape = "web_address" | "web_address_with_parameters" | "text" | "command";
// What the judge is told about an action. Never the outbound text itself, nor anything read. The
// destination is the name its owner holds: the names below it can carry data.
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
// Data about to leave, and the host it reaches when the action names one. The text stays here,
// for the overlap check.
export interface Outbound {
  readonly kind: JudgeAction["kind"];
  readonly destination?: string;
  readonly text: string;
}
export type PurposeVerdict =
  | { readonly allow: true }
  | {
      readonly allow: false;
      // The named hosts the check refused; one nothing names is only in the words.
      readonly destinations: readonly string[];
      readonly title: string;
      readonly why: string;
    };

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

const DNS_NAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/;
const NAME = String.raw`((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9])(?![\w-]|\.[a-z0-9])`;
// A name in the user's words; a scheme or www. before it marks it as a site.
const MENTIONED = new RegExp(String.raw`(?<![\w.@/-])(https?:\/\/|www\.)?${NAME}`, "gi");
// A name in a command, past a user (git@host) or a substitution ($(…).host); one right after @
// or in a path is a file.
const BARE = new RegExp(String.raw`(?<![\w~/@-])(?<![\w.~/@-]\.)(?:[\w.+-]+@)?${NAME}`, "gi");
const ADDRESS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>]+/gi;
const IP_ADDRESS = /(?<![\w.:])(?:\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:]+\])(?![\w.])/gi;
const LOCAL_NAME = /(?<![\w.-])localhost(?![\w.-])/;
// File names that look like hosts (notes.md, run.sh): written bare, they name no site.
const FILE_LIKE =
  /^(?:txt|md|markdown|json|jsonl|csv|tsv|log|py|sh|bash|zsh|js|mjs|cjs|ts|tsx|jsx|html?|css|xml|ya?ml|toml|ini|cfg|conf|env|pdf|png|jpe?g|gif|svg|webp|ico|zip|tar|gz|tgz|bz2|xz|7z|rar|docx?|xlsx?|pptx?|odt|rtf|rs|go|cpp|hpp|cc|java|kt|rb|pl|pm|php|sql|db|sqlite|bin|exe|dmg|iso|so|dll|mov|mp3|mp4|m4a|wav|ogg|webm|mkv|xcf|psd|pem|crt|key|lock|patch|diff|bak|tmp|out|whl|deb|rpm|jar|wasm|ipynb)$/;
// Programs whose work is reaching another machine: one that names no machine still reaches one.
const NETWORK =
  /^(?:curl|wget|nc|ncat|netcat|socat|ssh|sftp|ftp|tftp|telnet|dig|nslookup|host|drill|ping6?|traceroute6?|tracepath|mtr|whois|aria2c|https?|xh|lynx|w3m|e?links)$/;
// These reach the machine they name; given none, they work on this computer.
const NAMES_ITS_MACHINE = /^(?:scp|rsync|openssl)$/;
const PASTE_MODIFIER = /^(?:ctrl|control(?:_[lr])?|cmd|command|super(?:_[lr])?|meta|win)$/i;

function webAddress(value: string | undefined): URL | undefined {
  if (!value || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) ? url : undefined;
}

// The host of a web address, as data reaches it: lowercase, without the root's trailing dot.
export function hostOf(value: string | undefined): string | undefined {
  return webAddress(value)?.hostname.toLowerCase().replace(/\.$/, "");
}

// Who a destination belongs to: an address is its own; a name nobody can own has no owner.
function ownerOfHost(host: string): string | undefined {
  if (isIP(host.replace(/^\[(.*)\]$/, "$1"))) return host;
  return DNS_NAME.test(host) ? ownerOf(host) : undefined;
}

function fileLike(host: string): boolean {
  return FILE_LIKE.test(host.split(".").at(-1) ?? "");
}

// The owners of the sites the user's words name. A file name written bare names none.
export function mentionedHosts(request: readonly string[]): string[] {
  const found = new Set<string>();
  for (const text of request)
    for (const [, marked, name = ""] of text.matchAll(MENTIONED)) {
      const host = name.toLowerCase();
      const owner = ownerOfHost(host);
      if (owner && (marked || !fileLike(host))) found.add(owner);
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

interface Reach {
  readonly destination?: string;
  // What the address itself carries there: the host's names below its owner's, then its path,
  // query and fragment.
  readonly carried: string;
}

// Where an address leads, unless it stays on this computer.
function reach(url: URL): Reach | undefined {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || LOOPBACK.test(host)) return undefined;
  const owner = ownerOfHost(host);
  const below = owner ? host.slice(0, -owner.length).replace(/\.$/, "") : host;
  const carried = [
    below.replace(/^www$/, ""),
    decoded(`${url.pathname.replace(/^\/$/, "")}${url.search}${url.hash}`),
  ]
    .filter(Boolean)
    .join(" ");
  return { ...(owner ? { destination: host } : {}), carried };
}

function reachName(name: string): Reach | undefined {
  const address = `http://${name}`;
  return URL.canParse(address) ? reach(new URL(address)) : { carried: name };
}

function pastes(combo: unknown): boolean {
  if (!Array.isArray(combo)) return false;
  const has = (pattern: RegExp) => combo.some((key) => pattern.test(String(key)));
  return (
    (has(PASTE_MODIFIER) && has(/^v$/i)) ||
    (has(/^shift(?:_[lr])?$/i) && has(/^(?:insert|kp_insert)$/i))
  );
}

// What an action would carry to a host, if anything. Opening a site's front page carries nothing;
// typing into a desktop app or a field whose page is unknown carries nothing to a host either.
export function outboundOf(tool: ToolName, input: unknown, facts: RiskFacts): Outbound[] {
  const object = (input ?? {}) as Record<string, unknown>;
  if (tool === "browser_navigate" && typeof object.url === "string") {
    const url = webAddress(object.url);
    const where = url && reach(url);
    if (!where || (where.destination && !where.carried)) return [];
    return [
      {
        kind: "open_page",
        ...(where.destination && { destination: where.destination }),
        text: where.carried,
      },
    ];
  }
  if (tool === "computer") {
    const action = (object.action ?? {}) as Record<string, unknown>;
    // A paste carries what was copied, which may be anything dot read.
    const text =
      action.verb === "type" && typeof action.text === "string"
        ? action.text
        : action.verb === "key" && pastes(action.combo)
          ? ""
          : undefined;
    const url = webAddress(facts.target?.url);
    const where = url && reach(url);
    if (text === undefined || (action.verb === "type" && !text) || !where) return [];
    return [
      { kind: "enter_text", ...(where.destination && { destination: where.destination }), text },
    ];
  }
  if (tool === "shell" && typeof object.command === "string")
    return commandOutbound(object.command);
  return [];
}

// The hosts a command reaches: every address in it, and the names given to programs that reach
// other machines. Such a program given no name still reaches a machine nobody can name.
function commandOutbound(command: string): Outbound[] {
  const hosts = new Set<string>();
  let unnamed = false;
  const add = (where: Reach | undefined) => {
    if (where?.destination) hosts.add(where.destination);
    else if (where) unnamed = true;
  };
  const addresses = (text: string): boolean => {
    let found = false;
    for (const [value] of text.matchAll(ADDRESS)) {
      found = true;
      if (!URL.canParse(value)) unnamed = true;
      else if (new URL(value).protocol !== "file:") add(reach(new URL(value)));
    }
    return found;
  };
  addresses(command);
  for (const line of commandLines(command)) {
    const names = line.runs.map((words) => words[0]?.split("/").pop() ?? "");
    const network = names.some((name) => NETWORK.test(name));
    if (!network && !names.some((name) => NAMES_ITS_MACHINE.test(name))) continue;
    let named = addresses(line.text) || LOCAL_NAME.test(line.text);
    for (const [, name = ""] of line.text.matchAll(BARE)) {
      const host = name.toLowerCase();
      if (fileLike(host)) continue;
      named = true;
      add(reachName(host));
    }
    for (const [address] of line.text.matchAll(IP_ADDRESS)) {
      if (!isIP(address.replace(/^\[(.*)\]$/, "$1"))) continue;
      named = true;
      add(reachName(address));
    }
    // `curl --version` reaches nothing; `curl $URL` reaches somewhere.
    const probe =
      !/[$`]/.test(line.text) &&
      line.runs.every((words) => words.slice(1).every((word) => word.startsWith("-")));
    if (network && !named && !probe) unnamed = true;
  }
  return [
    ...[...hosts].map(
      (destination): Outbound => ({ kind: "run_command", destination, text: command }),
    ),
    ...(unnamed ? [{ kind: "run_command", text: command } as const] : []),
  ];
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

type Refusal = "unrelated" | "carries" | "unavailable";
const STRENGTH: Readonly<Record<Refusal, number>> = { unrelated: 0, unavailable: 1, carries: 2 };

// A long host keeps its end, where its owner's name is.
function short(host: string): string {
  return host.length <= 40 ? host : `…${host.slice(-39)}`;
}

// The card's title and reason. No refusal means only a destination nothing names was asked about.
export function purposeWords(
  refusal: Refusal | undefined,
  destinations: readonly string[],
  unnamed: boolean,
  kinds: readonly TaintKind[],
): { title: string; why: string } {
  const names = [...destinations.map(short), ...(unnamed ? ["an unknown site"] : [])];
  const shown = names.length > 2 ? `${names[0]} and ${names.length - 1} more` : names.join(" and ");
  const one = names.length === 1;
  const read = listed(kinds);
  const title = `Send data to ${shown}?`;
  if (refusal === "carries")
    return {
      title,
      why: `This sends text from ${read} to ${shown}, which ${one ? "doesn't" : "don't"} look related to your request.`,
    };
  if (refusal === "unavailable")
    return {
      title,
      why: `The purpose check couldn't tell whether ${shown} ${one ? "fits" : "fit"} your request, and dot has read ${read} in this task.`,
    };
  if (refusal === "unrelated")
    return {
      title,
      why: `${shown} ${one ? "doesn't" : "don't"} look related to your request, and dot has read ${read} in this task.`,
    };
  return {
    title,
    why: `dot can't tell where this sends data, and it has read ${read} in this task.`,
  };
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

const METHOD: Readonly<Record<JudgeAction["kind"], JudgeAction["method"]>> = {
  open_page: "GET",
  enter_text: "typed",
  run_command: "command",
};

function shapeOf(outbound: Outbound): OutboundShape {
  if (outbound.kind === "run_command") return "command";
  if (outbound.kind === "enter_text") return "text";
  return outbound.text.includes("?") ? "web_address_with_parameters" : "web_address";
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
// task sending something to a host outside its purpose asks, and one nothing names always asks.
// The judge's answer is kept per owner, so a site is judged once; a host the user allows never
// asks again in the task.
export class PurposeGate {
  readonly #allowed = new Set<string>();
  readonly #judged = new Map<string, boolean>();
  #derived: { key: string; hosts: Promise<readonly string[]> } | undefined;
  #downUntil = 0;
  constructor(private readonly deps: PurposeGateDeps) {}
  get #now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  // The user allowed these hosts for the rest of the task.
  allow(destinations: readonly string[]): void {
    for (const destination of destinations) this.#allowed.add(destination);
  }
  async check(outbound: readonly Outbound[], signal: AbortSignal): Promise<PurposeVerdict> {
    const { taint } = this.deps;
    const judge = taint.tainted ? this.deps.judge() : undefined;
    if (!judge) return { allow: true };
    const refused = new Map<string, Refusal>();
    let unnamed = false;
    for (const each of outbound) {
      const host = each.destination;
      if (host === undefined) {
        unnamed = true;
        continue;
      }
      const refusal = await this.#one({ ...each, destination: host }, judge, signal);
      const before = refused.get(host);
      if (refusal && (!before || STRENGTH[refusal] > STRENGTH[before])) refused.set(host, refusal);
    }
    if (!refused.size && !unnamed) return { allow: true };
    const strongest = [...refused.values()].sort((a, b) => STRENGTH[b] - STRENGTH[a])[0];
    const destinations = [...refused.keys()];
    return {
      allow: false,
      destinations,
      ...purposeWords(strongest, destinations, unnamed, taint.kinds),
    };
  }
  async #one(
    outbound: Outbound & { readonly destination: string },
    judge: PurposeJudge,
    signal: AbortSignal,
  ): Promise<Refusal | undefined> {
    const { taint } = this.deps;
    const host = outbound.destination;
    if (this.#allowed.has(host) || this.deps.trusted(host)) return undefined;
    const owner = ownerOfHost(host) ?? host;
    const purpose = this.deps.purpose();
    const key = digest(purpose);
    // What the user says next can make a refused site fit.
    if (this.#derived && this.#derived.key !== key)
      for (const [site, fits] of this.#judged) if (!fits) this.#judged.delete(site);
    // Data may go back where all of it came from.
    const back = taint.sources.every(
      (source) => source.kind === "screen" && ownerOfHost(source.origin) === owner,
    );
    if (back || mentionedHosts(purpose.request).includes(owner)) return undefined;
    const overlaps = taint.overlap(outbound.text).overlaps;
    const refusal = overlaps ? "carries" : "unrelated";
    const known = this.#judged.get(owner);
    if (known !== undefined) return known ? undefined : refusal;
    if (this.#now < this.#downUntil) return "unavailable";
    try {
      if (this.#derived?.key !== key) {
        const hosts = timed((s) => judge.destinations(purpose, s), signal, this.#timeout);
        hosts.catch(() => {});
        this.#derived = { key, hosts };
      }
      const derived = await this.#derived.hosts;
      if (derived.some((named) => ownerOfHost(named) === owner)) {
        this.#judged.set(owner, true);
        return undefined;
      }
      const p = await timed(
        (s) =>
          judge.fits(
            purpose,
            {
              kind: outbound.kind,
              destination: owner,
              method: METHOD[outbound.kind],
              bytes: Buffer.byteLength(outbound.text),
              shape: shapeOf(outbound),
              overlapsPrivateText: overlaps,
              privateData: taint.kinds,
            },
            s,
          ),
        signal,
        this.#timeout,
      );
      signal.throwIfAborted();
      const fits = Number.isFinite(p) && p >= FITS_THRESHOLD;
      this.#judged.set(owner, fits);
      return fits ? undefined : refusal;
    } catch {
      signal.throwIfAborted();
      if (this.#derived?.key === key) this.#derived = undefined;
      this.#downUntil = this.#now + DOWN_MS;
      return "unavailable";
    }
  }
  get #timeout(): number {
    return this.deps.timeoutMs ?? JUDGE_TIMEOUT_MS;
  }
}
