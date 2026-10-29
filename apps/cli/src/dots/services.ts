import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type DotInstance, MAIN_DOT_ID } from "../../../../packages/protocol/src/dots.ts";
import { instanceEnvironment, keydArguments } from "../../../daemon/src/dots/instance.ts";
import {
  type DotServiceNames,
  launchdLabels,
  systemdUnits,
} from "../../../daemon/src/dots/service-names.ts";
import { plistDocument } from "../install/service-definition.ts";

export const INSTALLER_MARKER = "Managed by localDot's install.sh";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Exec = (command: string, args: readonly string[]) => Promise<ExecResult>;

export const exec: Exec = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: 30_000, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException).code === "number"
            ? Number((error as NodeJS.ErrnoException).code)
            : error
              ? 1
              : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });

export class ServicesError extends Error {}

// How the first dot's services start keyd and the daemon. A new dot's services are made from
// these, so every dot runs the same installation: keyd and Node from the same place, the same
// working directory, image pins and PATH.
export interface ServiceTemplate {
  marker: boolean;
  keyd: { program: string; args: string[] };
  daemon: {
    program: string;
    args: string[];
    env: Record<string, string>;
    workingDirectory: string;
  };
}

// Set per dot, never taken from the first dot's services.
const DOT_ENVIRONMENT = new Set([
  "LOCALDOT_HOME",
  "LOCALDOT_PORT",
  "LOCALDOT_TOOL_PORT",
  "LOCALDOT_KEYD_PORTS",
  "LOCALDOT_PREVIEW_PORTS",
  "LOCALDOT_PUBLIC_ORIGIN",
]);
const DOT_KEYD_FLAGS = new Set(["-home", "-ports", "-keychain-service"]);

const unsafeText = (value: string) => /\p{Cc}/u.test(value);

function replaceFile(path: string, text: string) {
  writeFileSync(`${path}.new`, text, { mode: 0o644 });
  renameSync(`${path}.new`, path);
}

function checkTemplate(template: ServiceTemplate): ServiceTemplate {
  const texts = [
    template.keyd.program,
    ...template.keyd.args,
    template.daemon.program,
    ...template.daemon.args,
    template.daemon.workingDirectory,
    ...Object.entries(template.daemon.env).flat(),
  ];
  if (
    !isAbsolute(template.keyd.program) ||
    !isAbsolute(template.daemon.program) ||
    !isAbsolute(template.daemon.workingDirectory) ||
    texts.some(unsafeText) ||
    Object.keys(template.daemon.env).some((name) => !/^[A-Z_][A-Z0-9_]*$/.test(name))
  )
    throw new ServicesError("The first dot's services look unusual, so no dot was made from them.");
  return template;
}

function keydExtraArgs(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (DOT_KEYD_FLAGS.has(arg)) i++;
    else kept.push(arg);
  }
  return kept;
}

function dotEnvironment(
  template: ServiceTemplate,
  dot: DotInstance,
  home: string,
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(template.daemon.env).filter(([name]) => !DOT_ENVIRONMENT.has(name)),
  );
  return { ...env, LOCALDOT_HOME: home, ...instanceEnvironment(dot) };
}

function keydCommand(template: ServiceTemplate, dot: DotInstance, home: string): string[] {
  return [template.keyd.program, "-home", home, ...template.keyd.args, ...keydArguments(dot)];
}

export interface DotServices {
  readonly manager: "launchd" | "systemd";
  names(id: string): DotServiceNames;
  // The first dot's services, which new dots are made from; it throws when there are none.
  template(): Promise<ServiceTemplate>;
  // Writes the dot's service files; false when they already said the same.
  write(dot: DotInstance, home: string, template: ServiceTemplate): Promise<boolean>;
  exists(id: string): Promise<boolean>;
  start(id: string, only?: "keyd"): Promise<void>;
  stop(id: string, only?: "daemon"): Promise<void>;
  // The data folder the dot's daemon service runs on; nothing when it has no service.
  home(id: string): Promise<string | undefined>;
  remove(id: string): Promise<void>;
  // Whether the dot starts when the user signs in, and changing that for later sign-ins.
  login(id: string): Promise<boolean>;
  setLogin(id: string, on: boolean): Promise<void>;
}

// Where a daemon started with this environment keeps its data, as the daemon itself decides.
const daemonHome = (env: Record<string, string>) =>
  env.LOCALDOT_HOME || join(env.HOME || homedir(), ".localdot");

export interface ServiceHost {
  exec: Exec;
  uid: number;
  // ~/Library/LaunchAgents or the systemd user unit folder.
  directory: string;
  // plutil's JSON for a plist; launchd only.
  readPlist?(file: string): Promise<unknown>;
}

export function launchdServices(host: ServiceHost): DotServices {
  const file = (label: string) => join(host.directory, `${label}.plist`);
  const domain = `gui/${host.uid}`;
  const loaded = async (label: string) =>
    (await host.exec("/bin/launchctl", ["print", `${domain}/${label}`])).code === 0;
  const readPlist =
    host.readPlist ??
    (async (path: string) => {
      const result = await host.exec("/usr/bin/plutil", ["-convert", "json", "-o", "-", path]);
      if (result.code !== 0) throw new ServicesError("missing");
      return JSON.parse(result.stdout);
    });
  const stop = async (id: string, only?: "daemon") => {
    const names = launchdLabels(id);
    for (const label of only ? [names.daemon] : [names.daemon, names.keyd]) {
      if (!(await loaded(label))) continue;
      await host.exec("/bin/launchctl", ["bootout", `${domain}/${label}`]);
      // bootout can return before launchd lets go of the job, and starting it before then does
      // nothing: wait, as install.sh does, up to ten seconds.
      for (let tries = 0; tries < 40 && (await loaded(label)); tries++) await sleep(250);
    }
  };
  const job = async (label: string) => {
    const value = (await readPlist(file(label)).catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const args = value?.ProgramArguments;
    if (
      !value ||
      value.Label !== label ||
      !Array.isArray(args) ||
      args.length === 0 ||
      !args.every((arg) => typeof arg === "string")
    )
      return undefined;
    const env = value.EnvironmentVariables ?? {};
    if (
      typeof env !== "object" ||
      Array.isArray(env) ||
      !Object.values(env as object).every((v) => typeof v === "string")
    )
      return undefined;
    return {
      args: args as string[],
      env: env as Record<string, string>,
      workingDirectory: typeof value.WorkingDirectory === "string" ? value.WorkingDirectory : "",
    };
  };
  return {
    manager: "launchd",
    names: launchdLabels,
    async template() {
      const names = launchdLabels(MAIN_DOT_ID);
      const [keyd, daemon] = [await job(names.keyd), await job(names.daemon)];
      if (!keyd || !daemon)
        throw new ServicesError(
          "The first dot isn't run by launchd here (dev.localdot.keyd and dev.localdot.daemon), so a dot can't be added automatically.",
        );
      let marker = false;
      try {
        marker = readFileSync(file(names.daemon), "utf8").includes(INSTALLER_MARKER);
      } catch {}
      const [keydProgram = "", ...keydArgs] = keyd.args;
      const [daemonProgram = "", ...daemonArgs] = daemon.args;
      return checkTemplate({
        marker,
        keyd: { program: keydProgram, args: keydExtraArgs(keydArgs) },
        daemon: {
          program: daemonProgram,
          args: daemonArgs,
          env: daemon.env,
          workingDirectory: daemon.workingDirectory,
        },
      });
    },
    async write(dot, home, template) {
      const names = launchdLabels(dot.id);
      const logs = join(home, "logs");
      mkdirSync(logs, { recursive: true, mode: 0o700 });
      mkdirSync(host.directory, { recursive: true, mode: 0o755 });
      const common = (label: string, log: string) => ({
        Label: label,
        KeepAlive: true,
        RunAtLoad: true,
        ThrottleInterval: 5,
        Umask: 0o077,
        StandardOutPath: join(logs, log),
        StandardErrorPath: join(logs, log),
      });
      const documents = {
        [names.keyd]: plistDocument({
          ...common(names.keyd, "keyd.log"),
          ProgramArguments: keydCommand(template, dot, home),
        }),
        [names.daemon]: plistDocument({
          ...common(names.daemon, "daemon.log"),
          ProgramArguments: [template.daemon.program, ...template.daemon.args],
          EnvironmentVariables: dotEnvironment(template, dot, home),
          WorkingDirectory: template.daemon.workingDirectory,
        }),
      };
      let changed = false;
      for (const [label, document] of Object.entries(documents)) {
        const text = template.marker
          ? document.replace("<plist ", `<!-- ${INSTALLER_MARKER} -->\n<plist `)
          : document;
        let before: string | undefined;
        try {
          before = readFileSync(file(label), "utf8");
        } catch {}
        if (before === text) continue;
        replaceFile(file(label), text);
        changed = true;
      }
      return changed;
    },
    async exists(id) {
      const names = launchdLabels(id);
      return !!(await job(names.keyd)) && !!(await job(names.daemon));
    },
    async home(id) {
      const daemon = await job(launchdLabels(id).daemon);
      return daemon && daemonHome(daemon.env);
    },
    async start(id, only) {
      const names = launchdLabels(id);
      for (const label of only ? [names.keyd] : [names.keyd, names.daemon]) {
        await host.exec("/bin/launchctl", ["enable", `${domain}/${label}`]);
        if (await loaded(label)) {
          await host.exec("/bin/launchctl", ["kickstart", `${domain}/${label}`]);
          continue;
        }
        const result = await host.exec("/bin/launchctl", ["bootstrap", domain, file(label)]);
        if (result.code !== 0 && !(await loaded(label)))
          throw new ServicesError(`macOS didn't start ${label}. Sign in to this Mac's desktop.`);
      }
    },
    stop,
    async remove(id) {
      if (id === MAIN_DOT_ID) throw new ServicesError("The first dot's services stay.");
      await stop(id);
      const names = launchdLabels(id);
      for (const label of [names.daemon, names.keyd]) {
        await host.exec("/bin/launchctl", ["enable", `${domain}/${label}`]);
        rmSync(file(label), { force: true });
      }
    },
    async login(id) {
      const result = await host.exec("/bin/launchctl", ["print-disabled", domain]);
      if (result.code !== 0) throw new ServicesError("launchd's startup settings can't be read.");
      const names = launchdLabels(id);
      return ![names.keyd, names.daemon].some(
        (label) =>
          result.stdout.includes(`"${label}" => true`) ||
          result.stdout.includes(`"${label}" => disabled`),
      );
    },
    async setLogin(id, on) {
      const names = launchdLabels(id);
      for (const label of [names.keyd, names.daemon])
        await host.exec("/bin/launchctl", [on ? "enable" : "disable", `${domain}/${label}`]);
    },
  };
}

// systemd reads C escapes and %-specifiers inside quotes, and $ in a command line: quoted as the
// source installer quotes them.
export function systemdWord(value: string, command = false): string {
  let word = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  if (command) word = word.replaceAll("$", "$$$$");
  return `"${word}"`;
}

export function systemdWords(text: string, command = false): string[] {
  const words: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"/g;
  let rest = text.trim();
  for (;;) {
    pattern.lastIndex = 0;
    const match = pattern.exec(rest);
    if (match?.index !== 0) break;
    let word = (match[1] ?? "").replace(/\\(.)/g, "$1").replaceAll("%%", "%");
    if (command) word = word.replaceAll("$$", "$");
    words.push(word);
    rest = rest.slice(match[0].length).trimStart();
  }
  if (rest)
    throw new ServicesError("The first dot's services look unusual, so no dot was made from them.");
  return words;
}

const systemdPath = (value: string) => value.replaceAll("%", "%%");

export function systemdServices(host: ServiceHost): DotServices {
  const file = (unit: string) => join(host.directory, unit);
  const systemctl = (...args: string[]) => host.exec("systemctl", ["--user", ...args]);
  const lines = (unit: string) => {
    try {
      return readFileSync(file(unit), "utf8").split("\n");
    } catch {
      return undefined;
    }
  };
  const setting = (text: string[], key: string) =>
    text.filter((line) => line.startsWith(`${key}=`)).map((line) => line.slice(key.length + 1));
  const environment = (text: string[]) => {
    const env: Record<string, string> = {};
    for (const value of setting(text, "Environment")) {
      const [assignment = ""] = systemdWords(value);
      const at = assignment.indexOf("=");
      if (at > 0) env[assignment.slice(0, at)] = assignment.slice(at + 1);
    }
    return env;
  };
  return {
    manager: "systemd",
    names: systemdUnits,
    async template() {
      const names = systemdUnits(MAIN_DOT_ID);
      const keyd = lines(names.keyd),
        daemon = lines(names.daemon);
      const keydStart = keyd && setting(keyd, "ExecStart")[0];
      const daemonStart = daemon && setting(daemon, "ExecStart")[0];
      if (!keyd || !daemon || !keydStart || !daemonStart)
        throw new ServicesError(
          "The first dot isn't run by systemd here (localdot-keyd.service and localdot-daemon.service), so a dot can't be added automatically.",
        );
      const [keydProgram = "", ...keydArgs] = systemdWords(keydStart, true);
      const [daemonProgram = "", ...daemonArgs] = systemdWords(daemonStart, true);
      const env = environment(daemon);
      return checkTemplate({
        marker: daemon.some((line) => line.includes(INSTALLER_MARKER)),
        keyd: { program: keydProgram, args: keydExtraArgs(keydArgs) },
        daemon: {
          program: daemonProgram,
          args: daemonArgs,
          env,
          workingDirectory: (setting(daemon, "WorkingDirectory")[0] ?? "").replaceAll("%%", "%"),
        },
      });
    },
    async write(dot, home, template) {
      const names = systemdUnits(dot.id);
      const logs = join(home, "logs");
      mkdirSync(logs, { recursive: true, mode: 0o700 });
      mkdirSync(host.directory, { recursive: true, mode: 0o755 });
      const marker = template.marker ? `# ${INSTALLER_MARKER}\n` : "";
      const log = (name: string) => systemdPath(join(logs, name));
      const environment = Object.entries(dotEnvironment(template, dot, home))
        .map(([name, value]) => `Environment=${systemdWord(`${name}=${value}`)}\n`)
        .join("");
      const units = {
        [names.keyd]: `${marker}[Unit]
Description=localDot key service (${dot.name})

[Service]
Type=exec
ExecStart=${keydCommand(template, dot, home)
          .map((word) => systemdWord(word, true))
          .join(" ")}
UMask=0077
Restart=on-failure
RestartSec=5
StandardOutput=append:${log("keyd.log")}
StandardError=append:${log("keyd.log")}

[Install]
WantedBy=default.target
`,
        [names.daemon]: `${marker}[Unit]
Description=localDot (${dot.name})
Wants=${names.keyd}
After=${names.keyd}

[Service]
Type=exec
WorkingDirectory=${systemdPath(template.daemon.workingDirectory)}
${environment}ExecStart=${[template.daemon.program, ...template.daemon.args]
          .map((word) => systemdWord(word, true))
          .join(" ")}
SuccessExitStatus=143
UMask=0077
Restart=on-failure
RestartSec=5
StandardOutput=append:${log("daemon.log")}
StandardError=append:${log("daemon.log")}

[Install]
WantedBy=default.target
`,
      };
      let changed = false;
      for (const [unit, text] of Object.entries(units)) {
        if (lines(unit)?.join("\n") === text) continue;
        replaceFile(file(unit), text);
        changed = true;
      }
      if (changed) await systemctl("daemon-reload");
      return changed;
    },
    async exists(id) {
      const names = systemdUnits(id);
      return !!lines(names.keyd) && !!lines(names.daemon);
    },
    async home(id) {
      const daemon = lines(systemdUnits(id).daemon);
      return daemon && daemonHome(environment(daemon));
    },
    async start(id, only) {
      const names = systemdUnits(id);
      for (const unit of only ? [names.keyd] : [names.keyd, names.daemon]) {
        const result = await systemctl("start", unit);
        if (result.code !== 0)
          throw new ServicesError(
            `systemd didn't start ${unit}. Check: systemctl --user status ${unit}`,
          );
      }
    },
    async stop(id, only) {
      const names = systemdUnits(id);
      await systemctl("stop", ...(only ? [names.daemon] : [names.daemon, names.keyd]));
    },
    async remove(id) {
      if (id === MAIN_DOT_ID) throw new ServicesError("The first dot's services stay.");
      const names = systemdUnits(id);
      await systemctl("stop", names.daemon, names.keyd);
      await systemctl("disable", "--quiet", names.daemon, names.keyd);
      for (const unit of [names.daemon, names.keyd]) rmSync(file(unit), { force: true });
      await systemctl("daemon-reload");
    },
    async login(id) {
      const names = systemdUnits(id);
      return (await systemctl("is-enabled", "--quiet", names.daemon)).code === 0;
    },
    async setLogin(id, on) {
      const names = systemdUnits(id);
      await systemctl(on ? "enable" : "disable", "--quiet", names.keyd, names.daemon);
    },
  };
}

export function hostServices(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): DotServices {
  const uid = process.getuid?.() ?? -1;
  const home = env.HOME || homedir();
  if (platform === "darwin")
    return launchdServices({ exec, uid, directory: join(home, "Library", "LaunchAgents") });
  if (platform === "linux")
    return systemdServices({
      exec,
      uid,
      directory: join(env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user"),
    });
  throw new ServicesError("Several dots run on macOS and Linux (including WSL 2).");
}
