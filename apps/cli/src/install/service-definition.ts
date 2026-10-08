import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { ReleaseIdentity } from "../../../../packages/protocol/src/install-update.ts";
import {
  IMAGE_ROLES,
  imageRef,
  ReleaseManifest,
} from "../../../../packages/protocol/src/release.ts";
import { readInstalledRelease } from "./promote-release.ts";
import { releaseDirectoryName } from "./release-layout.ts";

export type ServiceRole = "keyd" | "daemon";
export interface ServiceSettings {
  state: string;
  home: string;
  userHome: string;
  node: string;
  dockerSocket: string;
  uid: number;
  port: number;
  ownerId: string;
}
const invalid = () => new Error("Invalid localDot service configuration.");
const unsafeCharacter = (value: string) =>
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      code < 32 ||
      (code >= 127 && code <= 159) ||
      (code >= 0xd800 && code <= 0xdfff) ||
      code === 0xfffe ||
      code === 0xffff
    );
  });

function path(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    value === "/" ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    unsafeCharacter(value)
  )
    throw invalid();
  return value;
}

/** Lexical location only. The caller must verify private canonical directories and durable job
 * ownership before publishing a plist or controlling a loaded job. Labels never contain paths.
 */
export function serviceLocation(
  stateInput: string,
  homeInput: string,
  uid: number,
  ownerId: string,
  configuration: string,
) {
  const state = path(stateInput),
    home = path(homeInput);
  if (!Number.isSafeInteger(uid) || uid <= 0 || uid > 0xffff_fffe) throw invalid();
  if (!/^[a-f0-9]{32}$/.test(ownerId) || !/^[a-f0-9]{64}$/.test(configuration)) throw invalid();
  const suffix = createHash("sha256").update(home).digest("hex");
  const domain = `gui/${uid}`;
  const location = (role: ServiceRole) => {
    if (role !== "keyd" && role !== "daemon") throw invalid();
    const label = `dev.localdot.${suffix}.${ownerId}.${role}`;
    return Object.freeze({
      role,
      label,
      domain,
      target: `${domain}/${label}`,
      plist: join(state, "services", ownerId, configuration, `${role}.plist`),
      state,
      home,
      uid,
      ownerId,
      configuration,
    });
  };
  return Object.freeze({ keyd: location("keyd"), daemon: location("daemon") });
}
export type ServiceLocation = ReturnType<typeof serviceLocation>[ServiceRole];

/** Stable identity for the exact launch configuration, including engine, runtime and port. */
export function serviceConfigurationId(input: ServiceSettings, identityInput: ReleaseIdentity) {
  const settings = { ...input };
  for (const field of ["state", "home", "userHome", "node", "dockerSocket"] as const)
    path(settings[field]);
  if (
    /[?#]/.test(settings.dockerSocket) ||
    !Number.isInteger(settings.port) ||
    settings.port < 1024 ||
    settings.port > 65535 ||
    settings.node.includes(":")
  )
    throw invalid();
  const identity = ReleaseIdentity.parse(identityInput);
  const configuration = createHash("sha256")
    .update(
      JSON.stringify({
        identity,
        home: settings.home,
        userHome: settings.userHome,
        node: settings.node,
        dockerSocket: settings.dockerSocket,
        uid: settings.uid,
        port: settings.port,
      }),
    )
    .digest("hex");
  serviceLocation(settings.state, settings.home, settings.uid, settings.ownerId, configuration);
  return configuration;
}

type PlistValue = string | number | boolean | readonly string[] | Readonly<Record<string, string>>;
const xml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c] as string,
  );
function plistValue(value: PlistValue): string {
  if (typeof value === "string") return `<string>${xml(value)}</string>`;
  if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
  if (typeof value === "number") return `<integer>${value}</integer>`;
  if (Array.isArray(value)) return `<array>${value.map(plistValue).join("")}</array>`;
  return `<dict>${Object.entries(value)
    .map(([k, v]) => `<key>${xml(k)}</key>${plistValue(v)}`)
    .join("")}</dict>`;
}

/** Pure builder: inputs must already be verified. No filesystem/process effects, no shell, no
 * dev-image defaults. The production entry point below obtains manifest authority from the
 * installed anchor. env -i also clears launchd's inherited environment, including NODE_OPTIONS.
 */
export function defineReleaseServices(
  input: ServiceSettings,
  identityInput: ReleaseIdentity,
  manifestInput: ReleaseManifest,
) {
  const settings = { ...input };
  const identity = ReleaseIdentity.parse(identityInput);
  const configuration = serviceConfigurationId(settings, identity);
  const manifest = ReleaseManifest.parse(manifestInput);
  if (identity.version !== manifest.version || !Object.hasOwn(manifest.files, "dist/daemon.mjs"))
    throw invalid();
  // Configuration directories are immutable, including changes of Node path, port or engine.
  // The owner label stays stable across releases so an installation has one job per role.
  const locations = serviceLocation(
    settings.state,
    settings.home,
    settings.uid,
    settings.ownerId,
    configuration,
  );
  const release = join(settings.state, "releases", releaseDirectoryName(identity));
  const common = {
    HOME: settings.userHome,
    PATH: `${dirname(settings.node)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: join(settings.state, "tmp"),
    LANG: "en_US.UTF-8",
    LOCALDOT_HOME: settings.home,
    LOCALDOT_SERVICE_IDENTITY: JSON.stringify({ ownerId: settings.ownerId, release: identity }),
  };
  const environment: Record<ServiceRole, Record<string, string>> = {
    keyd: { ...common },
    daemon: {
      ...common,
      DOCKER_HOST: `unix://${settings.dockerSocket}`,
      LOCALDOT_PORT: String(settings.port),
      LOCALDOT_KEYD_PORTS: "4760-4789",
      SHARP_IGNORE_GLOBAL_LIBVIPS: "1",
      ...Object.fromEntries(
        IMAGE_ROLES.map((role) => [
          `LOCALDOT_${role.toUpperCase()}_IMAGE`,
          imageRef(manifest.images[role]),
        ]),
      ),
    },
  };
  const definition = (role: ServiceRole) => {
    const location = locations[role];
    const args = Object.freeze([
      "/usr/bin/env",
      "-i",
      ...Object.entries(environment[role]).map(([k, v]) => `${k}=${v}`),
      // The signed helper admits only this journaled start, acquires the lifetime lease, then
      // execs the exact role from its configuration. It offers no arbitrary-command interface.
      join(release, "keyd", "bin/keyd"),
      "service-exec",
      settings.state,
      settings.home,
      settings.ownerId,
      configuration,
      role,
    ]);
    const values: Record<string, PlistValue> = {
      Label: location.label,
      ProgramArguments: args,
      WorkingDirectory: settings.home,
      RunAtLoad: false,
      KeepAlive: false,
      ProcessType: "Background",
      Umask: 0o077,
      ExitTimeOut: 20,
      StandardOutPath: join(settings.state, "logs", `${role}.log`),
      StandardErrorPath: join(settings.state, "logs", `${role}.error.log`),
    };
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${Object.entries(
      values,
    )
      .map(([k, v]) => `<key>${k}</key>${plistValue(v)}`)
      .join("")}</dict></plist>\n`;
    return Object.freeze({ ...location, arguments: args, contents: plist });
  };
  return Object.freeze({ keyd: definition("keyd"), daemon: definition("daemon") });
}

/** Hold the installation lock through definition publication and startup. This reopens the
 * entire installed payload and verifies its Apple signature before returning executable paths.
 * It does not certify a mutable Node runtime, filesystem layout or loaded launchd job.
 */
export async function installedServiceDefinitions(
  settingsInput: ServiceSettings,
  identityInput: ReleaseIdentity,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const settings = { ...settingsInput },
    identity = ReleaseIdentity.parse(identityInput);
  const installed = await readInstalledRelease(settings.state, identity, signal);
  signal.throwIfAborted();
  return defineReleaseServices(settings, identity, installed.manifest);
}
