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
import { type CommandLine, commandLines } from "./classify.ts";
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
// destination is the name its owner holds, and the names below it only when they can't be data.
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

// The judge when the saved keys couldn't be read: it never answers, so a tainted task asks.
export const unreadableJudge: PurposeJudge = {
  name: "jev",
  destinations: () => Promise.reject(new Error("the saved keys couldn't be read")),
  fits: () => Promise.reject(new Error("the saved keys couldn't be read")),
};

export const FITS_THRESHOLD = 0.75;
export const JUDGE_TIMEOUT_MS = 3_000;
const DOWN_MS = 30_000;

const DNS_NAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/;
const NAME = String.raw`((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9])(?![\w-]|\.[a-z0-9])`;
const WHOLE_NAME = new RegExp(`^${NAME}$`, "i");
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
// The file endings above that are also top-level domains: in a command, such a name may be a host.
const FILE_LIKE_DOMAIN = /^(?:md|py|sh|zip|rs|cc|pl|pm|so|mov)$/;
// Programs whose work is reaching another machine: one that names no machine still reaches one.
const NETWORK =
  /^(?:curl|curlie|wget2?|nc|ncat|netcat|socat|ssh|sftp|ftp|tftp|lftp|ncftp|telnet|dig|kdig|nslookup|host|drill|delv|ping6?|traceroute6?|tracepath|mtr|whois|aria2c|axel|https?|xh|lynx|w3m|e?links|ssh-keyscan|ssh-copy-id|sshpass|mosh|rsh|rlogin|nmap|nping|hping3|fping|arping|smbclient|websocat|wscat|grpcurl|rclone|torsocks|tsocks|proxychains4?)$/;
// These reach the machine they name, in a word with its user or path (me@box, box:/tmp); given
// none, they work on this computer.
const NAMES_ITS_MACHINE = /^(?:scp|rsync|openssl)$/;
// git's commands that reach a remote; with no name, the remote it saved earlier. These take the
// remote's address itself.
const GIT_REMOTE = /^(?:clone|fetch|pull|push|ls-remote|archive|submodule)$/;
const GIT_ADDRESSED = /^(?:clone|ls-remote|archive)$/;
// Programs that run code written on their command line (python3 -c, perl -e, node -e, awk '…').
const INTERPRETER =
  /^(?:python[\d.]*|perl|ruby|node|nodejs|php|deno|bun|lua[\d.]*|[gm]?awk|tclsh|Rscript)$/;
const INLINE_FLAG = /^(?:-[A-Za-z]*[cerEp]|--(?:eval|print)|eval)$/;
// Code that can reach another machine, or run or build code that might.
const REACHES = new RegExp(
  [
    String.raw`socket|urllib|http|request|urlopen|fetch|\bnet\b|net::|io::|lwp|open-uri|curl|wget`,
    "connect|smtp|ftp|telnet|imap|pop3|nntp|rpc|dns|gethostby|getaddrinfo|webbrowser",
    "exec|eval|compile|system|popen|spawn|subprocess|child_process|proc_open|passthru",
    "fsockopen|stream_|file_get_contents|fopen|call_user_func|create_function|ctypes|ffi",
    String.raw`importlib|__|builtins|globals|vars\s*\(|getattr|sys\.modules|import\s*\(`,
    String.raw`new\s+Function|\bFunction\s*\(\s*["'\x60]|globalThis|\.(?:public_)?send\s*\(|const_get|instance_eval|class_eval`,
    String.raw`\bmethod\s*\(|(?<!\.)\bload(?:string)?\s*\(|\$\w+\s*\(|\x60|\bqx\b|%x`,
    String.raw`\/dev\/(?:tcp|udp)|\/inet[46]?\/`,
    String.raw`require\s*\(\s*(?!["'](?:node:)?(?:fs|path|os|util|zlib|readline|assert|events|buffer)["']\s*\))`,
  ].join("|"),
  "i",
);
// awk runs a command through a pipe; perl, ruby and tcl open one.
const AWK_PIPE = /\|\s*getline|\|&|\bprintf?\b[^;}\n]*\|/;
const OPEN_PIPE = /\bopen\b[^;\n]*["'][^"'\n]*\|/;
// The shell's own network files: bash's /dev/tcp/host/port and gawk's /inet/tcp/0/host/port.
const SPECIAL_FILE = /\/dev\/(?:tcp|udp)\/([^/\s'"]*)|\/inet[46]?\/(?:tcp|udp)\/\d+\/([^/\s'"]*)/gi;
// A command whose program is an expansion ($c, "$CURL", $(which curl), `which curl`), found
// where a command starts, after its assignments.
const EXPANDED_PROGRAM =
  /(?:^|[|&;{!\n`]|(?<![$(])\((?!\()|\$\((?!\()|\b(?:then|do|else|elif|if|while|until|exec|command|builtin|eval|xargs|sudo|doas|env|nohup|setsid|nice|time|stdbuf|timeout|watch|busybox)\s)\s*(?:[A-Za-z_]\w*=\S*\s+)*["']?(?:\$[{(A-Za-z_@*#?!\d-]|`)/;
// The options of these programs whose value is a local file: a name there is never a host.
const FILE_OPTIONS: Readonly<Record<string, { short: string; long: RegExp }>> = {
  curl: {
    short: "oTKcbDE",
    long: /^--(?:output|upload-file|config|cookie|cookie-jar|dump-header|cert|key|cacert|capath|trace|trace-ascii|stderr|netrc-file|output-dir|proxy-cacert|proxy-cert|proxy-key|crlfile|etag-save|etag-compare|hsts|alt-svc)$/,
  },
  wget: {
    short: "OoaiP",
    long: /^--(?:output-document|output-file|append-output|input-file|directory-prefix|post-file|body-file|load-cookies|save-cookies|ca-certificate|ca-directory|certificate|private-key|config|warc-file|rejected-log|hsts-file)$/,
  },
  ssh: { short: "iFE", long: /^$/ },
  scp: { short: "iF", long: /^$/ },
  sftp: { short: "iFb", long: /^$/ },
};
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

// The sites the user's words name, as written. A file name written bare names none, and neither
// does a suffix nobody owns.
export function mentionedHosts(request: readonly string[]): string[] {
  const found = new Set<string>();
  for (const text of request)
    for (const [, marked, name = ""] of text.matchAll(MENTIONED)) {
      const host = name.toLowerCase();
      if (ownerOfHost(host) && (marked || !fileLike(host))) found.add(host);
    }
  return [...found];
}

// A named site covers its own names below it, and www.site the site itself; never a sibling.
function covers(named: string, host: string): boolean {
  const site = named.toLowerCase().replace(/\.$/, "");
  return host === site || host.endsWith(`.${site}`) || `www.${host}` === site;
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

type Role = "network" | "remote" | "interpreter" | "other";
// Where a name sits in a command's words: what leads a stage, an address a program reaches, a
// local file, inline code, or another program's word.
type Place = "lead" | "reach" | "file" | "code" | "other";

function roleOf(words: readonly string[]): Role {
  const name = words[0]?.split("/").pop() ?? "";
  if (NETWORK.test(name)) return "network";
  if (NAMES_ITS_MACHINE.test(name)) return "remote";
  if (name === "git" && words.slice(1).some((word) => GIT_REMOTE.test(word))) return "remote";
  return INTERPRETER.test(name) ? "interpreter" : "other";
}

function fileValue(words: readonly string[], at: number): boolean {
  const options = FILE_OPTIONS[words[0]?.split("/").pop() ?? ""];
  if (!options) return false;
  const long = /^(--[\w-]+)=/.exec(words[at] ?? "");
  if (long) return options.long.test(long[1] ?? "");
  const before = words[at - 1] ?? "";
  if (before.startsWith("--")) return options.long.test(before);
  return /^-[A-Za-z]+$/.test(before) && options.short.includes(before.at(-1) ?? "");
}

function placeOf(words: readonly string[], role: Role, at: number): Place {
  if (at === 0) return "lead";
  if (role === "interpreter") return "code";
  if (role === "network") return fileValue(words, at) ? "file" : "reach";
  if (role === "remote") return /[:@]/.test(words[at] ?? "") ? "reach" : "other";
  return "other";
}

// Whether a name in a command line is a machine it reaches. A file name is one only where a
// program that reaches machines takes it as an address, or nothing else explains it; a name in
// inline code or a file option's value is never one.
function reachesName(line: CommandLine, name: string, at: number): boolean {
  // The path after a machine's name (git@host:repo.git, me@box:notes.md) is a file there.
  if (/[\w-]\.[a-z][\w-]*:$/i.test(line.text.slice(0, at))) return false;
  const places = line.runs.flatMap((words) => {
    const role = roleOf(words);
    return words.flatMap((word, n) =>
      word.toLowerCase().includes(name) ? [placeOf(words, role, n)] : [],
    );
  });
  if (!fileLike(name)) return !places.length || places.some((p) => p !== "code" && p !== "file");
  if (!FILE_LIKE_DOMAIN.test(name.split(".").at(-1) ?? "")) return false;
  if (places.length) return places.some((p) => p === "reach" || p === "lead");
  return !/[<>]\|?\s*["']?$/.test(line.text.slice(0, at));
}

// Whether a stage runs code that can reach another machine: inline code (python3 -c, perl -e,
// awk '…') or a program it reads on its input (python3 - <<EOF), anywhere in the command.
function connects(words: readonly string[], command: string): boolean {
  const name = words[0]?.split("/").pop() ?? "";
  const args = words.slice(1);
  const awk = /awk$/.test(name);
  const code =
    awk || args.some((word) => INLINE_FLAG.test(word))
      ? args.join(" ")
      : args.every((word) => word.startsWith("-"))
        ? command
        : undefined;
  if (code === undefined) return false;
  const pipes = awk ? AWK_PIPE : /^(?:perl|ruby|tclsh)$/.test(name) ? OPEN_PIPE : undefined;
  return REACHES.test(code) || pipes?.test(code) === true;
}

// The line with its quoted text taken out, keeping a quoted word that starts with an expansion.
function unquoted(text: string): string {
  return text
    .replace(/'[^']*'/g, "''")
    .replace(/"((?:[^"\\]|\\.)*)"/g, (_, inner: string) =>
      /^[$\x60]/.test(inner) ? '"$x"' : '""',
    );
}

// The hosts a command reaches: every address in it, and the names given to programs that reach
// other machines. Such a program given no name still reaches a machine nobody can name, as does
// a program named by an expansion, inline code that can connect, and the shell's network files.
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
    const roles = line.runs.map(roleOf);
    const network = roles.includes("network");
    const expanded = EXPANDED_PROGRAM.test(unquoted(line.text));
    const code = line.runs.some(
      (words, n) => roles[n] === "interpreter" && connects(words, command),
    );
    const special = [...line.text.matchAll(SPECIAL_FILE)].map(
      (match) => match[1] ?? match[2] ?? "",
    );
    if (!network && !expanded && !code && !special.length && !roles.includes("remote")) continue;
    let named = addresses(line.text) || LOCAL_NAME.test(line.text);
    for (const host of special) {
      const name = host.toLowerCase();
      if (WHOLE_NAME.test(name) || isIP(name)) {
        named = true;
        add(reachName(name));
      } else unnamed = true;
    }
    for (const match of line.text.matchAll(BARE)) {
      const host = (match[1] ?? "").toLowerCase();
      if (!reachesName(line, host, match.index)) continue;
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
    // `git clone $REPO` reaches somewhere; `git pull origin $BRANCH`, the remote git saved.
    const cloned = line.runs.some(
      (words) =>
        words[0]?.split("/").pop() === "git" &&
        words.some((word) => GIT_ADDRESSED.test(word)) &&
        /[$`]/.test(line.text),
    );
    if (code || ((network || expanded || cloned) && !named && !probe)) unnamed = true;
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

// The host as the judge sees it: its owner, with the names below it only when they read as a plain
// service name (script.google.com), never when they could carry what dot read.
function judgedName(host: string, taint: TaskTaint): string {
  const owner = ownerOfHost(host);
  if (!owner || owner === host) return host;
  const below = host.slice(0, -owner.length - 1);
  const labels = below.split(".");
  const plain =
    labels.length <= 2 && labels.every((label) => /^[a-z]{1,20}(?:-[a-z]{1,20})?$/.test(label));
  return plain && !taint.overlap(labels.join(" ")).overlaps ? host : owner;
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
// The judge's answer is kept per host, so a host is judged once; a host the user allows never
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
    const purpose = this.deps.purpose();
    const key = digest(purpose);
    // What the user says next can make a refused site fit.
    if (this.#derived && this.#derived.key !== key)
      for (const [site, fits] of this.#judged) if (!fits) this.#judged.delete(site);
    // Data may go back to the one host all of it came from.
    const back = taint.sources.every(
      (source) => source.kind === "screen" && source.origin === host,
    );
    if (back || mentionedHosts(purpose.request).some((named) => covers(named, host)))
      return undefined;
    const overlaps = taint.overlap(outbound.text).overlaps;
    const refusal = overlaps ? "carries" : "unrelated";
    const known = this.#judged.get(host);
    if (known !== undefined) return known ? undefined : refusal;
    if (this.#now < this.#downUntil) return "unavailable";
    try {
      if (this.#derived?.key !== key) {
        const hosts = timed((s) => judge.destinations(purpose, s), signal, this.#timeout);
        hosts.catch(() => {});
        this.#derived = { key, hosts };
      }
      const derived = await this.#derived.hosts;
      if (derived.some((named) => covers(named, host))) {
        this.#judged.set(host, true);
        return undefined;
      }
      const p = await timed(
        (s) =>
          judge.fits(
            purpose,
            {
              kind: outbound.kind,
              destination: judgedName(host, taint),
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
      this.#judged.set(host, fits);
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
