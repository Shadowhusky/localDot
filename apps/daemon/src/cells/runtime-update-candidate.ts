import { isDeepStrictEqual as equal } from "node:util";
import { parseRuntimeUpdateJournal, type RuntimeUpdateJournal } from "./runtime-update-store.ts";
import { desktopSpec, gateSpec } from "./spec.ts";

type Role = "gate" | "desktop";
const object = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw);
const failure = () => new Error("Computer update container ownership is unconfirmed.");

export function runtimeCandidateSpec(input: RuntimeUpdateJournal, role: Role) {
  const j = parseRuntimeUpdateJournal(input);
  if (role !== "gate" && role !== "desktop") throw failure();
  const spec =
    role === "gate"
      ? gateSpec(j.source, j.images.gate)
      : desktopSpec(j.source, j.images.desktop, { fullcolor: j.fullcolor });
  return { ...spec, Labels: { ...spec.Labels, "localdot.runtime-update": j.operationId } };
}

/** Pure ownership proof shared by interrupted preparation and installer containment. It does
 * not prove quiescence: preparation requires stopped state; containment may stop a live owner. */
export function runtimeCandidateIdentity(
  input: RuntimeUpdateJournal,
  role: Role,
  raw: unknown,
): string {
  const j = parseRuntimeUpdateJournal(input),
    spec = runtimeCandidateSpec(j, role);
  if (
    j.phase === "retiring" ||
    !object(raw) ||
    typeof raw.Id !== "string" ||
    !/^[0-9a-f]{64}$/.test(raw.Id) ||
    raw.Name !== `/${j.source.docker[role]}` ||
    Object.values(j.source.ownership ?? {}).includes(raw.Id) ||
    (j.candidates[role] !== null && raw.Id !== j.candidates[role]) ||
    raw.Id === j.candidates[role === "gate" ? "desktop" : "gate"] ||
    !object(raw.Config) ||
    raw.Config.Image !== spec.Image ||
    !environment(raw.Config.Env, spec.Env) ||
    ("User" in spec && raw.Config.User !== spec.User) ||
    !subset(raw.Config.Labels, spec.Labels) ||
    !subset(raw.HostConfig, spec.HostConfig)
  )
    throw failure();
  return raw.Id;
}
function subset(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, i) => subset(actual[i], value))
    );
  if (object(expected))
    return (
      object(actual) && Object.entries(expected).every(([key, value]) => subset(actual[key], value))
    );
  return equal(actual, expected);
}
function environment(actual: unknown, expected: string[]): boolean {
  if (!Array.isArray(actual) || actual.some((value) => typeof value !== "string")) return false;
  return expected.every((value) => {
    const name = value.slice(0, value.indexOf("=") + 1);
    const matches = actual.filter((entry: string) => entry.startsWith(name));
    return matches.length === 1 && matches[0] === value;
  });
}
