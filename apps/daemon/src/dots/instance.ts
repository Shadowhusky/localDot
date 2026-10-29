import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_DOT_PORTS,
  DotInstance,
  type DotPortRange,
  KEYCHAIN_SERVICE,
  MAIN_DOT_ID,
} from "../../../../packages/protocol/src/dots.ts";
import { PrivateJsonError, readPrivateJson, writePrivateJson } from "./private-json.ts";

export const INSTANCE_FILE = "instance.json";

export class InstanceError extends Error {}

// A home without instance.json is the installation's first dot: today's ports and Keychain
// service, so an existing installation needs no migration.
export function mainInstance(name = "Main"): DotInstance {
  return {
    v: 1,
    id: MAIN_DOT_ID,
    name,
    ports: structuredClone(DEFAULT_DOT_PORTS),
    keychainService: KEYCHAIN_SERVICE,
  };
}

// A damaged instance file must stop the dot: falling back to the first dot's defaults would put a
// second dot on the first one's ports and Keychain items.
export function readInstance(home: string): DotInstance | undefined {
  let raw: unknown;
  try {
    raw = readPrivateJson(join(home, INSTANCE_FILE), 16 * 1024);
  } catch (error) {
    if (error instanceof PrivateJsonError) throw new InstanceError(error.message);
    throw error;
  }
  if (raw === undefined) return undefined;
  const parsed = DotInstance.safeParse(raw);
  if (!parsed.success || parsed.data.id === MAIN_DOT_ID)
    throw new InstanceError(`${join(home, INSTANCE_FILE)} isn't a valid dot description`);
  return parsed.data;
}

export function instanceOf(home: string): DotInstance {
  return readInstance(home) ?? mainInstance();
}

// A dot is called what its own settings call it (Settings → Your dot), else its instance's name.
export function dotName(home: string, fallback: string): string {
  try {
    const settings = JSON.parse(readFileSync(join(home, "agent.json"), "utf8"));
    if (typeof settings?.name === "string" && settings.name.trim())
      return settings.name.trim().slice(0, 40);
  } catch {}
  return fallback;
}

export function writeInstance(home: string, instance: DotInstance): void {
  writePrivateJson(join(home, INSTANCE_FILE), DotInstance.parse(instance));
}

export const formatRange = ([first, last]: DotPortRange) => `${first}-${last}`;

// What a dot's daemon reads from its environment. The service files set these; a daemon started
// by hand with only LOCALDOT_HOME takes them from the instance file.
export function instanceEnvironment(instance: DotInstance): Record<string, string> {
  return {
    LOCALDOT_PORT: String(instance.ports.app),
    LOCALDOT_TOOL_PORT: String(instance.ports.tool),
    LOCALDOT_KEYD_PORTS: formatRange(instance.ports.keyd),
    LOCALDOT_PREVIEW_PORTS: formatRange(instance.ports.preview),
    ...(instance.publicOrigins?.length
      ? { LOCALDOT_PUBLIC_ORIGIN: instance.publicOrigins.join(",") }
      : {}),
  };
}

export function applyInstanceEnvironment(env: NodeJS.ProcessEnv, instance: DotInstance): void {
  for (const [name, value] of Object.entries(instanceEnvironment(instance)))
    if (env[name] === undefined || env[name] === "") env[name] = value;
}

// keyd's flags for this dot. The first dot passes none, so its keyd starts exactly as before.
export function keydArguments(instance: DotInstance): string[] {
  if (instance.id === MAIN_DOT_ID) return [];
  return [
    "-ports",
    formatRange(instance.ports.keyd),
    "-keychain-service",
    instance.keychainService,
  ];
}
