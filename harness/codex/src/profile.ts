import { lstatSync, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import type { InstalledCodex } from "./install.ts";
import {
  assertOwnedCodexDirectory,
  assertOwnedCodexRoots,
  createOwnedCodexDirectory,
  type OwnedCodexDirectory,
  type OwnedCodexRoots,
  ownedCodexRealHome,
  PRIVATE_CREATE_FLAGS,
  removeOwnedCodexDirectory,
} from "./roots.ts";
import { CODEX_VERSION, codexRelease, releaseInstallKey } from "./version.ts";

export type SandboxPurpose = "task" | "account" | "login-browser";
export const CODEX_HOSTS = ["chatgpt.com:443", "auth.openai.com:443"] as const;
export const CODEX_HOME_DENY_WRITE = [
  "config.toml",
  "AGENTS.md",
  "AGENTS.override.md",
  "hooks.json",
  "rules",
  "skills",
  "prompts",
  "plugins",
  ".agents",
  "managed_config.toml",
  "requirements.toml",
] as const;
const SHARED_TEMP = ["/tmp/claude", "/private/tmp/claude"] as const;

export interface SandboxInput {
  readonly purpose: SandboxPurpose;
  readonly roots: OwnedCodexRoots;
  readonly installed: InstalledCodex;
  readonly work: OwnedCodexDirectory;
  readonly mcp?: OwnedCodexDirectory;
  readonly extraDenyRead?: readonly string[];
  readonly platform?: NodeJS.Platform;
}
export interface SrtSettings {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    strictAllowlist: true;
    allowUnixSockets?: string[];
    allowLocalBinding: false;
    loopbackBindPorts?: number[];
  };
  filesystem: {
    denyRead: string[];
    allowRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
  enableWeakerNetworkIsolation: false;
  enableWeakerNestedSandbox: false;
  allowPty: false;
  allowAppleEvents: false;
}
export interface OwnedSandboxProfile {
  readonly path: string;
  readonly directory: OwnedCodexDirectory;
}
const profiles = new WeakMap<SrtSettings, OwnedCodexRoots>();
export class SandboxProfileError extends Error {
  constructor() {
    super("The localDot Codex sandbox settings could not be verified.");
    this.name = "SandboxProfileError";
  }
}
function refuse(): never {
  throw new SandboxProfileError();
}
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function literal(path: string): string {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    normalize(path) !== path ||
    (path.length > 1 && path.endsWith(sep)) ||
    /[*?[\]\\\0\r\n]/.test(path)
  )
    return refuse();
  return path;
}
function spellings(path: string, platform: NodeJS.Platform): string[] {
  if (platform !== "darwin") return [path];
  const prefix = "/System/Volumes/Data";
  if (path === prefix) return [path];
  const ancestor = (entry: string) => {
    const tail: string[] = [];
    for (let current = entry; ; current = dirname(current)) {
      try {
        return { info: lstatSync(current), tail: tail.join(sep) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || current === dirname(current))
          throw error;
        tail.unshift(basename(current));
      }
    }
  };
  const alias = isInside(path, prefix) ? join(sep, relative(prefix, path)) : `${prefix}${path}`;
  const original = ancestor(path),
    alternate = ancestor(alias);
  // A missing protected descendant inherits the same verified ancestor spelling as its grant.
  return original.info.dev === alternate.info.dev &&
    original.info.ino === alternate.info.ino &&
    original.tail === alternate.tail &&
    !original.info.isSymbolicLink() &&
    !alternate.info.isSymbolicLink()
    ? [path, alias]
    : [path];
}
function protectedUserCodex(realHome: string): string[] {
  const entry = literal(join(realHome, ".codex"));
  let present = false;
  try {
    lstatSync(entry);
    present = true;
    return [entry, literal(realpathSync(entry))];
  } catch (error) {
    // A dangling or otherwise unresolved existing alias must not become an absent deny.
    if (present || (error as NodeJS.ErrnoException).code !== "ENOENT") return refuse();
    return [entry];
  }
}
function validateBin(input: SandboxInput): void {
  const pin = input.installed;
  if (pin.version !== CODEX_VERSION || !["darwin-arm64", "linux-x64"].includes(pin.platform))
    refuse();
  const [platform, arch] = pin.platform.split("-");
  const release = codexRelease(platform, arch);
  if (
    !release ||
    dirname(pin.binDir) !== input.roots.binRoot ||
    basename(pin.binDir) !== releaseInstallKey(release) ||
    pin.codexBin !== join(pin.binDir, "codex") ||
    pin.codeModeHostBin !== join(pin.binDir, "codex-code-mode-host")
  )
    refuse();
  for (const path of [pin.binDir, pin.codexBin, pin.codeModeHostBin]) {
    literal(path);
    const info = lstatSync(path);
    if (info.isSymbolicLink() || info.uid !== process.getuid?.() || realpathSync(path) !== path)
      refuse();
    if (
      path === pin.binDir
        ? !info.isDirectory() || (info.mode & 0o777) !== 0o700
        : !info.isFile() || (info.mode & 0o777) !== 0o555 || info.nlink !== 1
    )
      refuse();
  }
  // This only validates profile paths. The launcher must rehash via verifiedInstallation before execution.
}
export function sandboxSettings(input: SandboxInput): SrtSettings {
  try {
    const platform = input.platform ?? process.platform;
    if (platform !== "darwin" && platform !== "linux") return refuse();
    if (!["task", "account", "login-browser"].includes(input.purpose)) return refuse();
    // Native acceptance found localhost also permits wildcard binding at1455. No browser
    // profile is published until the exact loopback restriction can be enforced.
    if (input.purpose === "login-browser") return refuse();
    assertOwnedCodexRoots(input.roots);
    for (const path of Object.values(input.roots)) literal(path);
    const realHome = literal(ownedCodexRealHome(input.roots));
    assertOwnedCodexDirectory(input.roots, input.work, "workRoot");
    literal(input.work.path);
    validateBin(input);
    if (input.purpose === "task") {
      if (!input.mcp) return refuse();
      assertOwnedCodexDirectory(input.roots, input.mcp, "runRoot");
      literal(input.mcp.path);
    } else if (input.mcp !== undefined) return refuse();
    const extra = (input.extraDenyRead ?? []).map(literal);
    const both = (paths: readonly string[]) => [
      ...new Set(paths.flatMap((path) => spellings(path, platform))),
    ];
    const settings: SrtSettings = {
      network: {
        allowedDomains: [...CODEX_HOSTS],
        deniedDomains: [],
        strictAllowlist: true,
        allowLocalBinding: false,
        ...(input.mcp ? { allowUnixSockets: [join(input.mcp.path, "m.sock")] } : {}),
      },
      filesystem: {
        denyRead: both([
          realHome,
          ...protectedUserCodex(realHome),
          dirname(input.roots.root),
          "/Volumes",
          "/Network",
          ...SHARED_TEMP,
          ...extra,
        ]),
        allowRead: both([
          input.roots.home,
          input.installed.binDir,
          input.work.path,
          ...(input.mcp ? [input.mcp.path] : []),
        ]),
        allowWrite: both([input.roots.home, input.work.path]),
        denyWrite: both([
          ...CODEX_HOME_DENY_WRITE.map((name) => join(input.roots.home, name)),
          ...SHARED_TEMP,
        ]),
      },
      enableWeakerNetworkIsolation: false,
      enableWeakerNestedSandbox: false,
      allowPty: false,
      allowAppleEvents: false,
    };
    for (const values of Object.values(settings.network))
      if (Array.isArray(values)) Object.freeze(values);
    for (const values of Object.values(settings.filesystem)) Object.freeze(values);
    Object.freeze(settings.network);
    Object.freeze(settings.filesystem);
    Object.freeze(settings);
    profiles.set(settings, input.roots);
    return settings;
  } catch {
    return refuse();
  }
}
export async function writeSettingsFile(
  roots: OwnedCodexRoots,
  settings: SrtSettings,
): Promise<OwnedSandboxProfile> {
  let directory: OwnedCodexDirectory | undefined;
  try {
    if (profiles.get(settings) !== roots) return refuse();
    assertOwnedCodexRoots(roots);
    directory = createOwnedCodexDirectory(roots, "profilesRoot");
    const path = join(directory.path, "srt.json");
    const file = await open(path, PRIVATE_CREATE_FLAGS, 0o600);
    try {
      await file.writeFile(`${JSON.stringify(settings, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    assertOwnedCodexDirectory(roots, directory, "profilesRoot");
    return Object.freeze({ path, directory });
  } catch {
    try {
      if (directory) await removeOwnedCodexDirectory(directory);
    } catch {
      // Unverifiable staging remains private; only a safe fixed failure leaves this boundary.
    }
    return refuse();
  }
}
