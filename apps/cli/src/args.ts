import { RELEASE_VERSION } from "../../../packages/protocol/src/release.ts";

export type Command =
  | { kind: "default" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "open"; qr?: true }
  | { kind: "down" }
  | { kind: "up"; atLogin?: true; fromLogin?: true }
  | { kind: "start-at-login"; operation: "on" | "off" | "status" }
  | { kind: "update"; version?: string }
  | { kind: "logs"; follow: boolean }
  | { kind: "stop"; cellId?: string; all?: true }
  | {
      kind: "reset-computer";
      cellId: string;
      operation: "preview" | "reset" | "status";
      requestId?: string;
    }
  | { kind: "doctor" }
  | { kind: "unlock" };

// Keep the command line finite. In particular, never accept tokens, arbitrary URLs, shell text,
// or passthrough options. The installer and service lifecycle will extend this explicit grammar.
export function parseArgs(args: readonly string[]): Command | undefined {
  if (args.length === 0) return { kind: "default" };
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
      case "open":
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
    args[1] === "--to" &&
    args[2] &&
    args[2].length <= 64 &&
    RELEASE_VERSION.test(args[2])
  )
    return { kind: "update", version: args[2] };
  if (args.length === 2 && args[0] === "stop" && args[1] === "--all")
    return { kind: "stop", all: true };
  if (
    args.length === 3 &&
    args[0] === "stop" &&
    args[1] === "--cell" &&
    /^[0-9A-HJKMNP-TV-Z]{26}$/.test(args[2] ?? "")
  )
    return { kind: "stop", cellId: args[2] };
  return undefined;
}

export const HELP = `localDot — local computer agent

Usage:
  localdot                      Install or start localDot and open the browser
  localdot up                   Start the installed app and print a sign-in link
  localdot up --at-login        Start localDot and start it again whenever you log in
  localdot start-at-login on|off|status
                                Turn start at login on or off, or show it
  localdot update [--to <version>]
                                Install the latest stable or an exact newer release; keep data
  localdot open [--qr]          Print a fresh, single-use sign-in link; --qr also draws it as
                                a QR code for your phone (needs remote access set up)
  localdot stop [--cell <id>]   Stop agent actions and revoke access
  localdot stop --all           Stop every task, pause routines and freeze every computer
  localdot reset-computer --cell <id>
                                Explain reset without changing anything
  localdot reset-computer --cell <id> --erase-computer [--request <id>]
                                Erase that computer's home and browser profile; create a replacement
  localdot reset-computer --cell <id> --request <id> --status
                                Check a reset without resuming it
  localdot down                 Shut down managed services and computers; keep data
  localdot logs [--follow]       Read recent managed service logs, optionally follow
  localdot doctor               Check the local runtime
  localdot unlock               Enter the passphrase that protects saved keys (Linux servers)
  localdot --version            Show this build's version
  localdot --help               Show this help

LOCALDOT_HOME selects the private installation directory.
LOCALDOT_PORT selects the local daemon port (default 4750).
LOCALDOT_PUBLIC_ORIGIN lists HTTPS addresses that reach this computer, such as Tailscale Serve.
`;
