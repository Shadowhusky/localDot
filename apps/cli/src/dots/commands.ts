import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type CopyCategory,
  type DotInstance,
  DotName,
  keychainServiceFor,
  MAIN_DOT_ID,
} from "../../../../packages/protocol/src/dots.ts";
import type { KeydStatus, KeydVault, Sealed } from "../../../../packages/protocol/src/keyd.ts";
import { type DockerClient, DockerError } from "../../../daemon/src/cells/docker.ts";
import { browserImagesFromEnv, imagesFromEnv } from "../../../daemon/src/cells/images.ts";
import {
  dotName,
  formatRange,
  INSTANCE_FILE,
  instanceOf,
  writeInstance,
} from "../../../daemon/src/dots/instance.ts";
import type { DotsRegistry, RegistryEntry } from "../../../daemon/src/dots/registry.ts";
import { KeydError } from "../../../daemon/src/keyd/client.ts";
import type { ConsoleIO } from "../runtime.ts";
import { type PassphrasePrompt, passphraseRecord, runUnlock } from "../unlock.ts";
import { copyFiles, FILE_CATEGORIES } from "./copy.ts";
import { copySignins, removeDotDocker, stageComputer } from "./docker.ts";
import { allocatePorts, type PortProbe } from "./ports.ts";
import type { DotServices, ServiceTemplate } from "./services.ts";
import { type TailscalePort, tailnetName } from "./tailscale.ts";

export class DotsCommandError extends Error {}
function fail(message: string): never {
  throw new DotsCommandError(message);
}

export interface DotsKeyd {
  status(): Promise<Pick<KeydStatus, "sealKey" | "vault" | "keyCopy" | "vaultForget">>;
  unlockVault(sealed: Sealed): Promise<KeydVault>;
  copyKeys(home: string): Promise<{ secrets: number; logins: number; skipped: number }>;
  forgetVault(): Promise<{ secrets: number; logins: number }>;
}

export interface DotsDeps {
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  registry: DotsRegistry;
  services: DotServices;
  // Managed releases keep one dot until their installer learns several.
  managed: boolean;
  keyd(home: string): DotsKeyd;
  docker(): Pick<DockerClient, "request">;
  probe?: PortProbe;
  // Whether a dot's daemon answers on its port.
  running(port: number): Promise<boolean>;
  // Stops a stopped dot's computers, as localdot down does; false when that can't be confirmed.
  stopComputers?(home: string, port: number): Promise<boolean>;
  tailscale?: TailscalePort;
  // A terminal to ask for a new dot's passphrase; absent when the app runs the command.
  prompt?: PassphrasePrompt;
  // The app's answers, one JSON line each, when it runs the command.
  answers?: AsyncIterator<string>;
  signInLink(home: string, port: number): Promise<string | undefined>;
  openBrowser?(link: string): void;
  waitMs?: number;
  passphraseWaitMs?: number;
}

export interface DotsIO extends ConsoleIO {
  json?: boolean;
}

function say(io: DotsIO, message: Record<string, unknown> & { step?: string }) {
  if (io.json) io.out(JSON.stringify(message));
  else if (message.step) io.out(message.step);
}

interface Dot extends RegistryEntry {
  instance: DotInstance;
  name: string;
}

function described(entry: RegistryEntry): Dot {
  const instance = instanceOf(entry.home);
  return { ...entry, instance, name: dotName(entry.home, instance.name) };
}

function dots(deps: DotsDeps): Dot[] {
  return deps.registry.read().map(described);
}

export function findDot(all: readonly Dot[], wanted: string): Dot {
  const lower = wanted.trim().toLowerCase();
  return (
    all.find((dot) => dot.id === lower) ??
    all.find(
      (dot) => dot.name.toLowerCase() === lower || dot.instance.name.toLowerCase() === lower,
    ) ??
    fail(`There's no dot called ${wanted} on this computer. See: localdot dots list`)
  );
}

export function resolveDot(deps: DotsDeps, wanted: string): Dot {
  return findDot(dots(deps), wanted);
}

// A short id for labels, service names and the Keychain: the name's letters and digits.
export function dotIdFor(name: string, taken: ReadonlySet<string>): string {
  let base = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(base)) base = `dot${base ? `-${base}` : ""}`.slice(0, 20);
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (id !== MAIN_DOT_ID && !taken.has(id)) return id;
  }
}

// A data folder's sockets must fit their path limit (see install.sh's check_locations).
export function homeProblem(home: string, platform: NodeJS.Platform = process.platform) {
  const limit = platform === "darwin" ? 87 : 60;
  if (!isAbsolute(home) || normalize(home) !== home || home === "/")
    return "A dot's folder must be an absolute path.";
  if (Buffer.byteLength(home) > limit)
    return `${home} is too long for the sockets a dot keeps in it: at most ${limit} bytes fit.`;
  if (/[\p{Cc}"]/u.test(home)) return "A dot's folder can't contain quotes or control characters.";
  return undefined;
}

const sameOrInside = (path: string, folder: string) =>
  path === folder || path.startsWith(`${folder}/`) || folder.startsWith(`${path}/`);

async function waitFor(check: () => Promise<boolean>, ms: number, signal: AbortSignal) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (await check().catch(() => false)) return true;
    await sleep(500, undefined, { signal });
  }
  return false;
}

export interface AddOptions {
  name: string;
  from?: string;
  copy: readonly CopyCategory[];
  home?: string;
}

export async function addDot(deps: DotsDeps, io: DotsIO, options: AddOptions): Promise<string> {
  if (deps.managed) fail("This installation keeps one dot for now.");
  const parsed = DotName.safeParse(options.name);
  if (!parsed.success)
    fail("Give the new dot a name of up to 40 letters, numbers and punctuation.");
  const name = parsed.data as string;
  const all = dots(deps);
  if (all.some((dot) => dot.name.toLowerCase() === name.toLowerCase()))
    fail(`There's already a dot called ${name} on this computer.`);
  const source = findDot(all, options.from ?? MAIN_DOT_ID);
  const main = all[0] ?? fail("The first dot can't be found.");
  const id = dotIdFor(name, new Set(all.map((dot) => dot.id)));
  const home = options.home ? resolve(options.home) : `${main.home}-${id}`;
  const problem = homeProblem(home);
  if (problem) fail(problem);
  if (all.some((dot) => sameOrInside(home, dot.home)))
    fail(`${home} is another dot's folder. Choose a folder of its own.`);
  if (existsSync(home) && readdirSync(home).length)
    fail(`${home} already holds files. Choose a new or empty folder with --home.`);
  const template = await deps.services.template();
  const copy = new Set(options.copy);
  if (copy.has("keys")) {
    const status = await deps
      .keyd(source.home)
      .status()
      .catch(() => fail(`Start ${source.name} first: its key service copies the keys.`));
    if (!status.keyCopy)
      fail(`Update localDot first: ${source.name}'s key service can't copy keys.`);
    if (status.vault?.state !== undefined && status.vault.state !== "ready")
      fail(`Unlock ${source.name}'s saved keys first: localdot unlock --dot ${source.id}`);
  }
  const ports = await allocatePorts(
    all.map((dot) => dot.instance.ports),
    deps.probe,
  );
  const instance: DotInstance = {
    v: 1,
    id,
    name,
    ports,
    keychainService: keychainServiceFor(id),
  };
  const undo: (() => Promise<void> | void)[] = [];
  try {
    say(io, { step: `Making ${name}'s folder`, dot: id });
    mkdirSync(home, { recursive: true, mode: 0o700 });
    undo.push(() => rmSync(home, { recursive: true, force: true }));
    writeInstance(home, instance);
    if (FILE_CATEGORIES.some((category) => copy.has(category)))
      say(io, { step: `Copying from ${source.name}` });
    await copyFiles({ source: source.home, destination: home, name, categories: [...copy] });
    if (copy.has("computer") || copy.has("signins")) {
      const docker = deps.docker();
      undo.push(() => removeDotDocker(docker, home));
      const images = {
        ...imagesFromEnv(template.daemon.env),
        ...browserImagesFromEnv(template.daemon.env),
      };
      if (copy.has("computer")) {
        say(io, { step: `Copying ${source.name}'s computer` });
        if (
          !(await stageComputer(docker, {
            source: source.home,
            destination: home,
            desktopImage: images.desktop,
          }))
        )
          say(io, { step: `${source.name} has no computer to copy yet` });
      }
      if (copy.has("signins")) {
        say(io, { step: "Copying browser sign-ins" });
        if (
          !(await copySignins(docker, {
            source: source.home,
            destination: home,
            image: images.browser,
          }))
        )
          say(io, { step: `${source.name} has no browser sign-ins to copy` });
      }
    }
    // Served to the tailnet when the dot it is copied from is.
    const tailnet = tailnetName(
      source.id === MAIN_DOT_ID
        ? template.daemon.env.LOCALDOT_PUBLIC_ORIGIN
        : source.instance.publicOrigins?.join(","),
    );
    if (tailnet && deps.tailscale) {
      try {
        const origin = await deps.tailscale.serve(tailnet, ports.app);
        undo.push(() => deps.tailscale?.off(ports.app));
        instance.publicOrigins = [origin];
        writeInstance(home, instance);
      } catch (error) {
        say(io, { step: (error as Error).message });
      }
    }
    say(io, { step: `Starting ${name}` });
    await deps.services.write(instance, home, template);
    undo.push(() => deps.services.remove(id));
    const login = await deps.services.login(MAIN_DOT_ID).catch(() => true);
    if (!login) await deps.services.setLogin(id, false);
    await deps.services.start(id);
    deps.registry.update((entries) => [...entries, { id, home }]);
    undo.push(() => {
      deps.registry.update((entries) => entries.filter((entry) => entry.id !== id));
    });
    const keyd = deps.keyd(home);
    if (!(await waitFor(async () => !!(await keyd.status()), deps.waitMs ?? 60_000, deps.signal)))
      fail(`${name}'s key service didn't start. See ${join(home, "logs", "keyd.log")}`);
    if (copy.has("keys")) {
      await unlockNew(deps, io, keyd, home, name);
      say(io, { step: "Copying keys" });
      const copied = await deps
        .keyd(source.home)
        .copyKeys(home)
        .catch((error) => fail(copyFailure(error, source.name, name)));
      say(io, {
        step: `Copied ${copied.secrets} key${copied.secrets === 1 ? "" : "s"}${copied.logins ? ` and ${copied.logins} saved password${copied.logins === 1 ? "" : "s"}` : ""}`,
      });
    }
    say(io, { step: `Waiting for ${name} to answer` });
    if (!(await waitFor(() => deps.running(ports.app), deps.waitMs ?? 120_000, deps.signal)))
      fail(`${name} didn't start. See ${join(home, "logs", "daemon.log")}`);
  } catch (error) {
    for (const step of undo.reverse()) await Promise.resolve(step()).catch(() => {});
    throw error;
  }
  if (io.json) io.out(JSON.stringify({ done: true, dot: id }));
  else {
    io.out(`${name} is ready at http://127.0.0.1:${ports.app} (its own data folder: ${home}).`);
    const link = await deps.signInLink(home, ports.app).catch(() => undefined);
    if (link) {
      io.out(`Open ${name} (within a minute; this link works once):`);
      io.out(`  ${link}`);
      deps.openBrowser?.(link);
    } else io.out(`For a sign-in link: localdot open --dot ${id}`);
  }
  return id;
}

function copyFailure(error: unknown, from: string, to: string): string {
  const code = error instanceof KeydError ? error.code : "unavailable";
  if (code === "not-keyd")
    return `${to}'s key service isn't one localDot recognises, so no keys were copied.`;
  if (code === "vault-locked")
    return `${from}'s saved keys are locked. Unlock them, then try again.`;
  if (code === "receiver-locked") return `${to}'s saved keys are locked, so no keys were copied.`;
  return `The keys couldn't be copied (${code}).`;
}

// A passphrase vault starts empty and waits for its first passphrase, which becomes its own.
async function unlockNew(deps: DotsDeps, io: DotsIO, keyd: DotsKeyd, home: string, name: string) {
  const status = await keyd.status();
  if (status.vault?.backend !== "file" || status.vault.state === "ready") return;
  const record = passphraseRecord(join(home, "passphrase-chosen"));
  if (deps.prompt && !io.json) {
    io.out(`Choose a passphrase for ${name}'s saved keys.`);
    const code = await runUnlock(deps.signal, io, keyd, deps.prompt, record);
    if (code !== 0) fail(`${name}'s saved keys are still locked, so no keys were copied.`);
    return;
  }
  if (!deps.answers)
    fail(`${name}'s saved keys need a passphrase: run localdot unlock --dot ${name}`);
  say(io, {
    step: `Choose a passphrase for ${name}'s saved keys`,
    needs: "passphrase",
    sealKey: status.sealKey,
  });
  const answer = await Promise.race([
    deps.answers.next(),
    sleep(deps.passphraseWaitMs ?? 15 * 60_000, { done: true, value: undefined }, { ref: false }),
  ]);
  let sealed: Sealed | undefined;
  try {
    sealed = JSON.parse(String(answer.value)).sealed;
  } catch {}
  if (answer.done || !sealed) fail(`Adding ${name} was cancelled.`);
  const vault = await keyd
    .unlockVault(sealed as Sealed)
    .catch(() => fail("That passphrase couldn't be used. Choose another one."));
  if (vault.fingerprint) record.remember(vault.fingerprint);
}

export async function removeDot(
  deps: DotsDeps,
  io: DotsIO,
  options: { dot: string; deleteData: boolean },
): Promise<void> {
  const all = dots(deps);
  const dot = findDot(all, options.dot);
  if (dot.id === MAIN_DOT_ID) fail("The first dot stays; localdot uninstall removes localDot.");
  say(io, { step: `Stopping ${dot.name}`, dot: dot.id });
  await deps.services.stop(dot.id);
  const keyd = deps.keyd(dot.home);
  if (await deps.services.exists(dot.id)) {
    await deps.services.start(dot.id, "keyd").catch(() => {});
    if (await waitFor(async () => !!(await keyd.status()), deps.waitMs ?? 30_000, deps.signal)) {
      say(io, { step: "Removing its saved keys" });
      const status = await keyd.status();
      if (status.vaultForget)
        await keyd
          .forgetVault()
          .catch(() => say(io, { step: "Its saved keys are locked, so they stay in its folder." }));
    }
    await deps.services.stop(dot.id);
  }
  say(io, { step: "Removing its computers" });
  try {
    await removeDotDocker(deps.docker(), dot.home);
  } catch (error) {
    if (!(error instanceof DockerError)) throw error;
    say(io, { step: "Docker isn't running, so its computers stay in Docker." });
  }
  if (dot.instance.publicOrigins?.length)
    await deps.tailscale?.off(dot.instance.ports.app).catch(() => {});
  await deps.services.remove(dot.id);
  deps.registry.update((entries) => entries.filter((entry) => entry.id !== dot.id));
  if (options.deleteData) {
    // Only a folder that is this dot's own: its instance file names it.
    if (instanceOf(dot.home).id !== dot.id || !existsSync(join(dot.home, INSTANCE_FILE)))
      fail(`${dot.home} doesn't look like ${dot.name}'s folder, so it was kept.`);
    rmSync(dot.home, { recursive: true, force: true });
    say(io, { step: `Removed ${dot.name} and its data` });
  } else say(io, { step: `Removed ${dot.name}. Its data is still in ${dot.home}` });
  if (io.json) io.out(JSON.stringify({ done: true, dot: dot.id }));
}

export async function startDot(deps: DotsDeps, io: DotsIO, wanted: string, on: boolean) {
  const dot = findDot(dots(deps), wanted);
  say(io, { step: `${on ? "Starting" : "Stopping"} ${dot.name}`, dot: dot.id });
  if (on) {
    await deps.services.start(dot.id);
    if (
      !(await waitFor(
        () => deps.running(dot.instance.ports.app),
        deps.waitMs ?? 120_000,
        deps.signal,
      ))
    )
      fail(`${dot.name} didn't start. See ${join(dot.home, "logs", "daemon.log")}`);
  } else {
    await deps.services.stop(dot.id);
    // A computer left running without its dot still holds Docker's memory.
    if (deps.stopComputers && !(await deps.stopComputers(dot.home, dot.instance.ports.app)))
      say(io, { step: `${dot.name}'s computers couldn't be confirmed stopped. Check Docker.` });
  }
  if (io.json) io.out(JSON.stringify({ done: true, dot: dot.id }));
}

export async function listDots(deps: DotsDeps, io: DotsIO) {
  const rows = await Promise.all(
    dots(deps).map(async (dot) => ({
      id: dot.id,
      name: dot.name,
      port: dot.instance.ports.app,
      state: (await deps.running(dot.instance.ports.app)) ? "running" : "stopped",
      home: dot.home,
    })),
  );
  if (io.json) {
    io.out(JSON.stringify({ dots: rows }));
    return;
  }
  for (const row of rows)
    io.out(
      `${row.name.padEnd(20)} ${row.id.padEnd(16)} ${String(row.port).padEnd(6)} ${row.state.padEnd(8)} ${row.home}`,
    );
}

// What the source installer needs to run its commands for one dot.
export function dotEnvironmentLines(deps: DotsDeps, wanted: string): string[] {
  const dot = findDot(dots(deps), wanted);
  const names = deps.services.names(dot.id);
  const values: Record<string, string> = {
    DOT_ID: dot.id,
    LD_HOME: dot.home,
    PORT: String(dot.instance.ports.app),
    KEYD_PORTS: formatRange(dot.instance.ports.keyd),
    PUBLIC_ORIGIN: (dot.instance.publicOrigins ?? []).join(","),
    KEYD_SERVICE: names.keyd,
    DAEMON_SERVICE: names.daemon,
  };
  return Object.entries(values).map(([key, value]) => {
    if (/["$`\\\n]/.test(value)) fail("That dot's settings can't be passed on safely.");
    return `${key}="${value}"`;
  });
}

// After an update: every other dot runs the new installation too, so its services are made again
// from the first dot's and it restarts.
export async function refreshDots(deps: DotsDeps, io: DotsIO) {
  const others = dots(deps).filter((dot) => dot.id !== MAIN_DOT_ID);
  if (!others.length) return;
  const template: ServiceTemplate = await deps.services.template();
  const login = await deps.services.login(MAIN_DOT_ID).catch(() => true);
  for (const dot of others) {
    try {
      const running = await deps.running(dot.instance.ports.app);
      await deps.services.write(dot.instance, dot.home, template);
      await deps.services.setLogin(dot.id, login);
      if (running) {
        await deps.services.stop(dot.id);
        await deps.services.start(dot.id);
      }
      say(io, { step: `${dot.name} ${running ? "restarted" : "updated"}` });
    } catch (error) {
      io.err(`${dot.name} couldn't be updated: ${(error as Error).message}`);
    }
  }
}

export async function setDotsLogin(deps: DotsDeps, on: boolean) {
  for (const dot of dots(deps))
    if (dot.id !== MAIN_DOT_ID) await deps.services.setLogin(dot.id, on).catch(() => {});
}

// Uninstalling removes every dot's services with the installation; their data stays.
export async function uninstallDots(deps: DotsDeps, io: DotsIO) {
  for (const dot of dots(deps)) {
    if (dot.id === MAIN_DOT_ID) continue;
    await deps.services.remove(dot.id).catch(() => {});
    if (dot.instance.publicOrigins?.length)
      await deps.tailscale?.off(dot.instance.ports.app).catch(() => {});
    io.out(`${dot.name}'s services were removed; its data is still in ${dot.home}`);
  }
}

export function openInBrowser(link: string, env: NodeJS.ProcessEnv = process.env) {
  if (env.SSH_CONNECTION || env.SSH_TTY) return;
  const opener =
    process.platform === "darwin"
      ? "/usr/bin/open"
      : env.DISPLAY || env.WAYLAND_DISPLAY
        ? "xdg-open"
        : undefined;
  if (!opener) return;
  try {
    spawn(opener, [link], { stdio: "ignore", detached: true }).unref();
  } catch {}
}
