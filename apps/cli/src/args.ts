import {
  COPY_CATEGORIES,
  type CopyCategory,
  DEFAULT_COPY,
} from "../../../packages/protocol/src/dots.ts";
import { ULID_PATTERN } from "../../../packages/protocol/src/ids.ts";
import { keyLikeMatches } from "../../../packages/protocol/src/key-like.ts";
import { RELEASE_VERSION } from "../../../packages/protocol/src/release.ts";
import { REPORT_ID, REPORT_MESSAGE_MAX } from "../../../packages/protocol/src/reports.ts";

export type DotsCommand =
  | { operation: "list"; json?: true }
  | {
      operation: "add";
      name: string;
      from?: string;
      copy: CopyCategory[];
      home?: string;
      json?: true;
    }
  | { operation: "remove"; dot: string; deleteData?: true; json?: true }
  | { operation: "start" | "stop"; dot: string; json?: true }
  | { operation: "env"; dot: string }
  | { operation: "refresh" | "uninstall" }
  | { operation: "login"; on: boolean };

export type ReportCommand =
  | { operation: "send"; message?: string; yes?: true; dryRun?: true; json?: true }
  | { operation: "delete"; id: string };

export type LinkKind = "local" | "network" | "remote";
export type ComputerOperation = "list" | "start" | "stop" | "restart" | "resume";

export type Command = (
  | { kind: "default" }
  | { kind: "help" }
  | { kind: "chat" }
  | { kind: "version" }
  | { kind: "open"; qr?: true }
  | { kind: "link"; only?: LinkKind; qr?: true; json?: true }
  | { kind: "status"; json?: true }
  | { kind: "remote"; operation: "on" | "off" | "status"; json?: true }
  | { kind: "tailscale"; operation: "on" | "status" }
  | { kind: "computer"; operation: ComputerOperation; cellId?: string; json?: true }
  | { kind: "restart" }
  | { kind: "down" }
  | { kind: "up"; atLogin?: true; fromLogin?: true }
  | { kind: "start-at-login"; operation: "on" | "off" | "status" }
  | { kind: "update"; version?: string; prepareOnly?: true; installPrepared?: true }
  | { kind: "logs"; follow: boolean }
  | { kind: "stop"; cellId?: string; all?: true; computers?: true }
  | {
      kind: "reset-computer";
      cellId: string;
      operation: "preview" | "reset" | "status";
      requestId?: string;
    }
  | { kind: "doctor"; fix?: true }
  | { kind: "recover"; cellId: string; confirmNativeExit?: true }
  | { kind: "unlock" }
  | { kind: "browser"; operation: "status" | "restart"; cellId?: string }
  | { kind: "report"; report: ReportCommand }
  | { kind: "dots"; dots: DotsCommand }
) & { dot?: string };

// A dot's name as typed: words, spaces and punctuation, never control characters.
const dotWord = (value: string | undefined): value is string =>
  !!value && value.trim().length > 0 && value.length <= 40 && !/[\p{Cc}<>]/u.test(value);

// The commands that act on one dot of this computer, chosen with --dot <name>.
const PER_DOT = new Set([
  "up",
  "down",
  "restart",
  "status",
  "doctor",
  "open",
  "link",
  "remote",
  "tailscale",
  "computer",
  "unlock",
  "logs",
  "browser",
  "report",
]);

const CELL = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// Words and flags in any order, each at most once; undefined for anything else.
function options(args: readonly string[], allowed: readonly string[]): Set<string> | undefined {
  const seen = new Set<string>();
  for (const arg of args) {
    if (!allowed.includes(arg) || seen.has(arg)) return undefined;
    seen.add(arg);
  }
  return seen;
}

function parseLink(args: readonly string[]): Command | undefined {
  const kinds: LinkKind[] = ["local", "network", "remote"];
  const seen = options(args, [...kinds, "--qr", "--json"]);
  const only = kinds.filter((kind) => seen?.has(kind));
  // A phone can't open this computer's own address, and a QR code isn't JSON.
  if (!seen || only.length > 1 || (seen.has("--qr") && (seen.has("--json") || only[0] === "local")))
    return undefined;
  return {
    kind: "link",
    ...(only[0] ? { only: only[0] } : {}),
    ...(seen.has("--qr") ? { qr: true as const } : {}),
    ...(seen.has("--json") ? { json: true as const } : {}),
  };
}

function parseComputer(args: readonly string[]): Command | undefined {
  const [operation, ...rest] = args;
  if (operation === "list") {
    const seen = options(rest, ["--json"]);
    return seen
      ? { kind: "computer", operation, ...(seen.size ? { json: true as const } : {}) }
      : undefined;
  }
  if (
    operation !== "start" &&
    operation !== "stop" &&
    operation !== "restart" &&
    operation !== "resume"
  )
    return undefined;
  if (rest.length === 0) return { kind: "computer", operation };
  if (rest.length === 2 && rest[0] === "--cell" && CELL.test(rest[1] ?? ""))
    return { kind: "computer", operation, cellId: rest[1] };
  return undefined;
}

// A problem in the user's own words: prose with its line breaks, bounded, never a flag or a key.
const prose = (value: string | undefined): value is string =>
  !!value?.trim() &&
  value.length <= REPORT_MESSAGE_MAX &&
  !value.startsWith("-") &&
  !/[\p{Cc}\p{Cf}]/u.test(value.replace(/[\n\t]/g, "")) &&
  keyLikeMatches(value).next().done === true;

function parseReport(args: readonly string[]): ReportCommand | undefined {
  if (args[0] === "delete")
    return args.length === 2 && REPORT_ID.test(args[1] ?? "")
      ? { operation: "delete", id: args[1] as string }
      : undefined;
  const report: Extract<ReportCommand, { operation: "send" }> = { operation: "send" };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index] ?? "";
    if (seen.has(flag)) return undefined;
    seen.add(flag);
    if (flag === "--message") {
      const message = args[++index];
      if (!prose(message)) return undefined;
      report.message = message;
    } else if (flag === "--yes") report.yes = true;
    else if (flag === "--dry-run") report.dryRun = true;
    else if (flag === "--json") report.json = true;
    else return undefined;
  }
  // A saved report is never sent, so there is nothing to agree to.
  return report.dryRun && report.yes ? undefined : report;
}

function parseDots(args: readonly string[]): DotsCommand | undefined {
  const [operation, ...rest] = args;
  const json = rest.at(-1) === "--json";
  const words = json ? rest.slice(0, -1) : rest;
  const flag = json ? { json: true as const } : {};
  switch (operation) {
    case "list":
      return words.length === 0 ? { operation, ...flag } : undefined;
    case "start":
    case "stop":
      return words.length === 1 && dotWord(words[0])
        ? { operation, dot: words[0], ...flag }
        : undefined;
    case "remove": {
      const [dot, extra, ...more] = words;
      if (!dotWord(dot) || more.length || (extra !== undefined && extra !== "--delete-data"))
        return undefined;
      return { operation, dot, ...(extra ? { deleteData: true as const } : {}), ...flag };
    }
    case "add": {
      const [name, ...options] = words;
      if (!dotWord(name)) return undefined;
      const result: Extract<DotsCommand, { operation: "add" }> = {
        operation,
        name,
        copy: [...DEFAULT_COPY],
        ...flag,
      };
      const seen = new Set<string>();
      for (let i = 0; i < options.length; i += 2) {
        const option = options[i] ?? "";
        const value = options[i + 1];
        if (seen.has(option) || value === undefined) return undefined;
        seen.add(option);
        if (option === "--from" && dotWord(value)) result.from = value;
        else if (option === "--home" && value.length <= 1024 && !/\p{Cc}/u.test(value))
          result.home = value;
        else if (option === "--copy") {
          const chosen = value === "none" ? [] : value.split(",");
          if (
            !chosen.every((c): c is CopyCategory =>
              (COPY_CATEGORIES as readonly string[]).includes(c),
            )
          )
            return undefined;
          result.copy = [...new Set(chosen)];
        } else return undefined;
      }
      return result;
    }
    case "env":
      return !json && words.length === 1 && dotWord(words[0])
        ? { operation, dot: words[0] }
        : undefined;
    case "refresh":
    case "uninstall":
      return !json && words.length === 0 ? { operation } : undefined;
    case "login":
      return !json && words.length === 1 && (words[0] === "on" || words[0] === "off")
        ? { operation, on: words[0] === "on" }
        : undefined;
  }
  return undefined;
}

// Keep the command line finite. In particular, never accept tokens, arbitrary URLs, shell text,
// or passthrough options. The installer and service lifecycle will extend this explicit grammar.
export function parseArgs(args: readonly string[]): Command | undefined {
  if (args[0] === "dots") {
    const dots = parseDots(args.slice(1));
    return dots ? { kind: "dots", dots } : undefined;
  }
  if (args.length >= 3 && args.at(-2) === "--dot") {
    const dot = args.at(-1);
    const command = parseCommand(args.slice(0, -2));
    if (!command || !PER_DOT.has(command.kind) || !dotWord(dot)) return undefined;
    if (command.kind === "up" && (command.atLogin || command.fromLogin)) return undefined;
    return { ...command, dot };
  }
  return parseCommand(args);
}

function parseCommand(args: readonly string[]): Command | undefined {
  const [first, ...rest] = args;
  if (first === "link") return parseLink(rest);
  if (first === "computer") return parseComputer(rest);
  if (first === "report") {
    const report = parseReport(rest);
    return report ? { kind: "report", report } : undefined;
  }
  if (first === "status") {
    const seen = options(rest, ["--json"]);
    return seen ? { kind: "status", ...(seen.size ? { json: true as const } : {}) } : undefined;
  }
  if (first === "remote") {
    const [operation, ...flags] = rest;
    if (operation === "status") {
      const seen = options(flags, ["--json"]);
      return seen
        ? { kind: "remote", operation, ...(seen.size ? { json: true as const } : {}) }
        : undefined;
    }
    return (operation === "on" || operation === "off") && flags.length === 0
      ? { kind: "remote", operation }
      : undefined;
  }
  if (first === "tailscale")
    return rest.length === 1 && (rest[0] === "on" || rest[0] === "status")
      ? { kind: "tailscale", operation: rest[0] }
      : undefined;
  if (args.length === 2 && args[0] === "doctor" && args[1] === "--fix")
    return { kind: "doctor", fix: true };
  if (
    args[0] === "recover" &&
    args[1] === "--cell" &&
    args[2] &&
    ULID_PATTERN.test(args[2]) &&
    (args.length === 3 || (args.length === 4 && args[3] === "--confirm-native-exit"))
  )
    return {
      kind: "recover",
      cellId: args[2],
      ...(args.length === 4 ? { confirmNativeExit: true as const } : {}),
    };
  if (args.length === 0) return { kind: "default" };
  if (
    args[0] === "browser" &&
    (args[1] === "status" || args[1] === "restart") &&
    (args.length === 2 ||
      (args.length === 4 && args[2] === "--cell" && ULID_PATTERN.test(args[3] ?? "")))
  )
    return { kind: "browser", operation: args[1], ...(args[3] ? { cellId: args[3] } : {}) };
  if (args[0] === "reset-computer") {
    let cellId: string | undefined, requestId: string | undefined;
    const seen = new Set<string>();
    for (let index = 1; index < args.length; index++) {
      const flag = args[index];
      if (!flag || seen.has(flag)) return undefined;
      seen.add(flag);
      if (flag === "--cell" || flag === "--request") {
        const value = args[++index];
        if (value?.length !== 26 || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) return undefined;
        if (flag === "--cell") cellId = value;
        else requestId = value;
      } else if (flag !== "--erase-computer" && flag !== "--status") return undefined;
    }
    if (
      !cellId ||
      (seen.has("--erase-computer") && seen.has("--status")) ||
      (seen.has("--status") && !requestId)
    )
      return undefined;
    return {
      kind: "reset-computer",
      cellId,
      operation: seen.has("--status")
        ? "status"
        : seen.has("--erase-computer")
          ? "reset"
          : "preview",
      ...(requestId ? { requestId } : {}),
    };
  }
  if (args[0] === "up" && args.length === 2) {
    if (args[1] === "--at-login") return { kind: "up", atLogin: true };
    if (args[1] === "--from-login") return { kind: "up", fromLogin: true };
    return undefined;
  }
  if (args[0] === "start-at-login") {
    const operation = args[1];
    if (args.length !== 2 || (operation !== "on" && operation !== "off" && operation !== "status"))
      return undefined;
    return { kind: "start-at-login", operation };
  }
  if (args.length === 1) {
    switch (args[0]) {
      case "help":
      case "--help":
      case "-h":
        return { kind: "help" };
      case "--version":
      case "-v":
        return { kind: "version" };
      case "chat":
      case "open":
      case "restart":
      case "down":
      case "up":
      case "update":
      case "stop":
      case "doctor":
      case "unlock":
        return { kind: args[0] };
      case "logs":
        return { kind: "logs", follow: false };
    }
  }
  if (args.length === 2 && args[0] === "open" && args[1] === "--qr")
    return { kind: "open", qr: true };
  if (args.length === 2 && args[0] === "logs" && args[1] === "--follow")
    return { kind: "logs", follow: true };
  if (
    args.length === 3 &&
    args[0] === "update" &&
    (args[1] === "--to" || args[1] === "--prepare" || args[1] === "--install-prepared") &&
    args[2] &&
    args[2].length <= 64 &&
    RELEASE_VERSION.test(args[2])
  )
    return {
      kind: "update",
      version: args[2],
      ...(args[1] === "--prepare" ? { prepareOnly: true as const } : {}),
      ...(args[1] === "--install-prepared" ? { installPrepared: true as const } : {}),
    };
  if (args.length === 2 && args[0] === "stop" && args[1] === "--computers")
    return { kind: "stop", computers: true };
  if (args.length === 2 && args[0] === "stop" && args[1] === "--all")
    return { kind: "stop", all: true };
  if (args.length === 3 && args[0] === "stop" && args[1] === "--cell" && CELL.test(args[2] ?? ""))
    return { kind: "stop", cellId: args[2] };
  return undefined;
}

export const HELP = `localDot — local computer agent

Start and stop:
  localdot                      Install or start localDot and open the browser
  localdot up                   Start localDot and print a sign-in link
  localdot up --at-login        Start localDot and start it again whenever you log in
  localdot down                 Shut down localDot and its computers; keep data
  localdot restart              Restart localDot from any state and print a sign-in link. A running
                                task stops; computers, data and task history are kept
  localdot status [--json]      Show the app, its services, computers, tasks, remote access and
                                updates; exits 1 when localDot isn't answering
  localdot start-at-login on|off|status
                                Turn start at login on or off, or show it
  localdot update [--to <version>]
                                Install the latest stable or an exact newer release; keep data
  localdot update --prepare <version>
                                Download and verify without interrupting the app

Sign in:
  localdot open [--qr]          Print a fresh, single-use sign-in link; --qr also draws it as
                                a QR code for your phone (needs remote access set up)
  localdot link [local|network|remote] [--qr | --json]
                                Print sign-in links for this computer, your network (Tailscale and
                                other HTTPS addresses) and remote access. Each works once, within a
                                minute; --qr draws the best one for your phone
  localdot remote on|off|status [--json]
                                Open localDot from anywhere through the localDot relay, or not
  localdot tailscale on|status  Share localDot with your devices on Tailscale, or show its state

Computers and tasks:
  localdot chat                 Talk to dot and follow progress in this terminal
  localdot computer list [--json]
                                List the computers and the task running on each
  localdot computer start|stop|restart|resume [--cell <id>]
                                Start, stop or restart a computer (its data is kept), or resume
                                one localdot stop froze. Stop and restart refuse while a task runs
  localdot stop [--cell <id>]   Stop agent actions and revoke access
  localdot stop --all           Stop every task, pause routines and freeze every computer
  localdot reset-computer --cell <id>
                                Explain reset without changing anything
  localdot reset-computer --cell <id> --erase-computer [--request <id>]
                                Erase that computer's home and browser profile; create a replacement
  localdot reset-computer --cell <id> --request <id> --status
                                Check a reset without resuming it
  localdot recover --cell <id>  Explain recovery for an old native task
  localdot recover --cell <id> --confirm-native-exit
                                Record your confirmation that the old native task is gone

Troubleshooting:
  localdot doctor               Check the local runtime
  localdot doctor --fix         Restart only localDot, preserve computer data, then recheck
  localdot logs [--follow]      Read recent service logs, optionally follow
  localdot unlock               Enter the passphrase that protects saved keys
  localdot browser status [--cell <id>]
                                Show the web browser's state and what last went wrong with it
  localdot browser restart [--cell <id>]
                                Restart the web browser; its saved sign-ins are kept
  localdot report [--message <text>] [--yes] [--dry-run] [--json]
                                Send a problem report: versions, checks, recent task states and
                                service logs, with keys, links, emails and names removed. Shows
                                it all and asks first; --dry-run saves it to a file instead
  localdot report delete <id>   Delete a report this computer sent

Several dots:
  localdot dots list            List the dots on this computer
  localdot dots add <name> [--from <dot>] [--copy <what>] [--home <folder>]
                                Add a dot with its own data, keys and computer. --copy chooses
                                from settings,keys,memory,skills,connectors (the default) and
                                conversations,computer,signins, or none
  localdot dots remove <dot> [--delete-data]
                                Remove a dot; its data folder stays unless --delete-data
  localdot dots start|stop <dot>
                                Start or stop another dot
  localdot <command> ... --dot <dot>
                                Run up, down, restart, status, open, link, remote, tailscale,
                                computer, browser, doctor, unlock, logs or report for one dot of
                                this computer

  localdot --version            Show this build's version
  localdot --help               Show this help

For remote chat, set LOCALDOT_SERVER=https://your-server and LOCALDOT_TOKEN_FILE=/private/path.
Use a private (0600) credential file. Credentials are never accepted as command-line arguments.

LOCALDOT_HOME selects the private installation directory.
LOCALDOT_PORT selects the local daemon port (default 4750).
LOCALDOT_PUBLIC_ORIGIN lists HTTPS addresses that reach this computer, such as Tailscale Serve.
LOCALDOT_REPORTS_URL sends problem reports to another service (default reports.localdot.dev).
`;

// The help's lines for the command that was mistyped, or a pointer to the help. Only words from
// the help itself are shown: an invalid command line may hold a pasted credential.
export function usageHint(args: readonly string[]): string {
  const word = args[0];
  const lines = word
    ? HELP.split("\n").filter(
        (line) => line.startsWith(`  localdot ${word} `) || line === `  localdot ${word}`,
      )
    : [];
  return lines.length
    ? ["Usage:", ...lines.map((line) => `  ${line.trim().replace(/\s{2,}.*$/, "")}`)].join("\n")
    : "Run localdot --help for usage.";
}
