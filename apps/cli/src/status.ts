import { resolve } from "node:path";
import type { TailscaleAccess } from "../../../packages/protocol/src/access-links.ts";
import { terminalText } from "./chat.ts";
import { type Computer, computers, describeComputer } from "./computer.ts";
import { describeTailscale } from "./links.ts";
import { type LocalApi, type LocalDot, notRunning } from "./local-dot.ts";
import type { ConsoleIO } from "./runtime.ts";

interface Update {
  supported: boolean;
  currentVersion: string;
  phase: string;
  availableVersion: string | null;
  error: string | null;
}
interface Remote {
  supported: boolean;
  enabled: boolean;
  state: string;
  url: string | null;
}

const shortVersion = (version: string) =>
  /^[0-9a-f]{40}$/.test(version) ? version.slice(0, 12) : version;

async function serviceFacts(l: LocalDot) {
  const services = l.services;
  if (l.managed || !services) return null;
  const names = services.names(l.dot);
  const home = (await services.exists(l.dot)) ? await services.home(l.dot) : undefined;
  return {
    manager: services.manager,
    keyd: names.keyd,
    daemon: names.daemon,
    installed: home !== undefined && resolve(home) === resolve(l.home),
    // The data folder the services run, when they exist.
    runs: home ?? null,
    startAtLogin: await services.login(l.dot).catch(() => null),
  };
}

async function appFacts(api: LocalApi) {
  const read = <T>(path: string) => api<T>("GET", path).catch(() => null);
  const [update, list, remote, access] = await Promise.all([
    read<Update>("/api/app-update"),
    computers(api).catch(() => null),
    read<Remote>("/api/remote-access"),
    read<{ tailscale?: TailscaleAccess }>("/api/access-links"),
  ]);
  return {
    update: update && {
      supported: update.supported,
      currentVersion: update.currentVersion,
      phase: update.phase,
      availableVersion: update.availableVersion,
      error: update.error,
    },
    computers: list,
    remoteAccess: remote && {
      supported: remote.supported,
      enabled: remote.enabled,
      state: remote.state,
      url: remote.url,
    },
    tailscale: access?.tailscale ?? null,
  };
}

function updateLine(update: Update): string {
  if (update.phase === "installing") return "installing an update now";
  if (update.error) return terminalText(update.error);
  if (!update.supported) return "managed outside the app for this installation";
  if (update.availableVersion)
    return `${shortVersion(update.availableVersion)} is available (Settings › Updates, or localdot update)`;
  return "up to date";
}

function remoteLine(l: LocalDot, remote: Remote): string {
  if (!remote.supported) return "unavailable";
  if (!remote.enabled) return `off (turn on: localdot remote on${l.dotFlag})`;
  return remote.state === "online"
    ? `on, connected${remote.url ? ` at ${remote.url}` : ""}`
    : `on, ${remote.state}`;
}

function computerLines(list: Computer[]): string[] {
  return list.length ? list.map((c) => `${c.id}  ${describeComputer(c)}`) : ["none yet"];
}

export async function runStatus(
  l: LocalDot,
  io: ConsoleIO,
  options: { json: boolean; version: string },
): Promise<number> {
  const app = await l.app();
  const [keyd, docker, services] = await Promise.all([l.keyd(), l.docker(), serviceFacts(l)]);
  let api: LocalApi | undefined;
  try {
    if (app === "running") api = l.api();
  } catch {}
  const facts = api ? await appFacts(api) : null;
  const version = facts?.update?.currentVersion ?? options.version;
  const report = {
    name: l.name,
    dot: l.dot,
    version,
    home: l.home,
    port: l.port,
    app,
    pid: l.lockHolder("daemon") ?? null,
    install: l.managed ? "managed" : services?.installed ? "services" : "unmanaged",
    services,
    keyd,
    docker: docker ? "running" : "stopped",
    computers: facts?.computers ?? null,
    remoteAccess: facts?.remoteAccess ?? null,
    tailscale: facts?.tailscale ?? null,
    update: facts?.update ?? null,
  };
  if (options.json) {
    io.out(JSON.stringify(report));
    return app === "running" ? 0 : 1;
  }
  const pid = report.pid ? ` (process ${report.pid})` : "";
  io.out(
    app === "running"
      ? `${l.name} ${shortVersion(version)} is running at http://127.0.0.1:${l.port}${pid}.`
      : notRunning(l, app),
  );
  const rows: [string, string | string[]][] = [["Data folder", l.home]];
  if (services)
    rows.push([
      "Services",
      services.installed
        ? `${services.daemon} and ${services.keyd} (${services.manager}); start at login ${services.startAtLogin === false ? "off" : "on"}`
        : services.runs
          ? `${services.daemon} runs ${services.runs}, not this folder`
          : `not set up (${services.daemon} and ${services.keyd}); rerun the localDot installer`,
    ]);
  else if (l.managed) rows.push(["Services", "managed by the localDot installer"]);
  rows.push([
    "Key service",
    keyd === "down"
      ? "not answering; computers can't start"
      : keyd === "locked"
        ? `running; saved keys locked (localdot unlock${l.dotFlag})`
        : "running",
  ]);
  rows.push(["Docker", docker ? "running" : "not running; computers can't start"]);
  if (facts?.computers) rows.push(["Computers", computerLines(facts.computers)]);
  if (facts?.remoteAccess) rows.push(["Remote access", remoteLine(l, facts.remoteAccess)]);
  if (facts?.tailscale)
    rows.push([
      "Tailscale",
      facts.tailscale.state === "ready-to-enable"
        ? `off (turn on: localdot tailscale on${l.dotFlag})`
        : describeTailscale(facts.tailscale),
    ]);
  if (facts?.update) rows.push(["Updates", updateLine(facts.update)]);
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) {
    const [first = "", ...rest] = typeof value === "string" ? [value] : value;
    io.out(`  ${label.padEnd(width)}  ${first}`);
    for (const line of rest) io.out(`  ${"".padEnd(width)}  ${line}`);
  }
  return app === "running" ? 0 : 1;
}
