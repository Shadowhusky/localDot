import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual as equal } from "node:util";
import { ULID_PATTERN } from "../../../../packages/protocol/src/ids.ts";
import type { ServiceConfiguration } from "../../../../packages/protocol/src/install-services.ts";
import { KEYD_PORT_RANGE } from "../../../daemon/src/cells/ports.ts";
import { runtimeCandidateIdentity } from "../../../daemon/src/cells/runtime-update-candidate.ts";
import {
  parseRuntimeUpdateJournal,
  preparedRuntimeRecord,
  type RuntimeUpdateJournal,
} from "../../../daemon/src/cells/runtime-update-store.ts";
import { decodeRecord } from "../../../daemon/src/cells/store.ts";
import type { StoredCellRecord } from "../../../daemon/src/cells/types.ts";
import { type InstallContainerClient, installContainerClient } from "./container-client.ts";
import { privateDirectory } from "./copy-inventory.ts";
import { privateRecordStore } from "./private-record.ts";
import { readRuntimeUpdateInventory } from "./runtime-update-inventory.ts";
import { checkedServiceConfiguration, verifyServiceOwner } from "./service-journal.ts";

const failure = () => new Error("LocalDot container shutdown could not be confirmed.");
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const idPattern = /^[a-f0-9]{64}$/;
interface Inventory {
  records: StoredCellRecord[];
  updates?: RuntimeUpdateJournal[];
  invalid: boolean;
  digest: string;
}
interface Target {
  id: string;
  labels: Record<string, string>;
  update?: { journal: RuntimeUpdateJournal; role: "gate" | "desktop" };
}

/** Read bounded private records without constructing a store that creates/chmods directories.
 * Tokens are decoded only in memory and never returned in receipts, Docker requests or errors.
 */
export async function readContainerInventory(home: string): Promise<Inventory> {
  await privateDirectory(home);
  let updates: RuntimeUpdateJournal[] = [],
    updatesInvalid = false;
  try {
    updates = await readRuntimeUpdateInventory(home);
  } catch {
    updatesInvalid = true;
  }
  const inventory = (records: StoredCellRecord[], invalid: boolean, absent = false): Inventory => ({
    records,
    ...(updates.length ? { updates } : {}),
    invalid: invalid || updatesInvalid,
    digest:
      absent && !updates.length && !updatesInvalid
        ? "absent"
        : createHash("sha256")
            .update(JSON.stringify({ records, invalid: invalid || updatesInvalid, updates }))
            .digest("hex"),
  });
  const directory = join(home, "cells");
  try {
    await lstat(directory);
  } catch (error) {
    if (missing(error)) return inventory([], false, true);
    throw failure();
  }
  await privateDirectory(directory);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > 4096) throw failure();
  const records: StoredCellRecord[] = [];
  let invalid = false;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!ULID_PATTERN.test(entry.name)) continue;
    try {
      if (!entry.isDirectory()) throw failure();
      const record = await privateRecordStore(join(directory, entry.name), "cell.json", {
        parse(value: unknown) {
          const record = decodeRecord(value, entry.name, KEYD_PORT_RANGE);
          if (!record) throw failure();
          return record;
        },
      }).read();
      if (!record) throw failure();
      records.push(record);
    } catch {
      invalid = true;
    }
  }
  return inventory(records, invalid);
}
function labelsOf(value: unknown): Record<string, string> {
  if (
    !object(value) ||
    Object.keys(value).length > 256 ||
    Object.values(value).some((v) => typeof v !== "string")
  )
    throw failure();
  return value as Record<string, string>;
}
function identity(raw: unknown) {
  if (!object(raw) || typeof raw.Id !== "string" || !idPattern.test(raw.Id) || !object(raw.Config))
    throw failure();
  return { raw, id: raw.Id, labels: labelsOf(raw.Config.Labels) };
}
function stopped(raw: unknown, target: Target, final = false): boolean {
  if (
    target.update &&
    runtimeCandidateIdentity(target.update.journal, target.update.role, raw) !== target.id
  )
    throw failure();
  const current = identity(raw);
  if (
    current.id !== target.id ||
    Object.entries(target.labels).some(([k, v]) => current.labels[k] !== v)
  )
    throw failure();
  const state = current.raw.State,
    host = current.raw.HostConfig;
  if (
    !object(state) ||
    !object(host) ||
    !object(host.RestartPolicy) ||
    typeof host.RestartPolicy.Name !== "string" ||
    (final && !["", "no"].includes(host.RestartPolicy.Name)) ||
    [state.Running, state.Paused, state.Restarting].some((v) => typeof v !== "boolean")
  )
    throw failure();
  return !state.Running && !state.Paused && !state.Restarting;
}

/** Daemon/keyd retirement must be confirmed first, under the install lock. Inspect ownership,
 * kill only exact container IDs, then independently re-enumerate and inspect. No volumes, networks,
 * records or profiles are removed. Unknown resources/engine changes leave recovery pending.
 */
export async function containServiceContainers(
  configInput: ServiceConfiguration,
  client: InstallContainerClient,
  inventory: () => Promise<Inventory>,
  callerSignal: AbortSignal,
) {
  const config = checkedServiceConfiguration(configInput);
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(60_000)]);
  signal.throwIfAborted();
  const before = await inventory(),
    engine = await client.engine(signal);
  const home = createHash("sha256").update(config.settings.home).digest("hex").slice(0, 16);
  const records = new Map(before.records.map((record) => [record.id, record]));
  let failed = before.invalid;
  const updates = new Map<string, RuntimeUpdateJournal>();
  for (const input of before.updates ?? []) {
    try {
      const update = parseRuntimeUpdateJournal(input),
        current = records.get(update.source.id);
      if (
        updates.has(update.source.id) ||
        (current &&
          !equal(current, update.source) &&
          !(update.phase === "prepared" && equal(current, preparedRuntimeRecord(update))))
      )
        throw failure();
      updates.set(update.source.id, update);
    } catch {
      failed = true;
    }
  }

  const scope = (raw: unknown): Target | null => {
    const current = identity(raw),
      labels = current.labels;
    const update = updates.get(labels["localdot.cell"] ?? "");
    const record = records.get(labels["localdot.cell"] ?? "") ?? update?.source;
    if (record) {
      // Orphaned journals after a completed reset are harmless only when their objects are absent.
      // If an object survives, contain its proven owner but do not certify a complete shutdown.
      if (!records.has(record.id)) failed = true;
      const role = labels["localdot.role"];
      if (role !== "gate" && role !== record.kind) throw failure();
      if (update && record.kind === "desktop" && (role === "gate" || role === "desktop")) {
        const old = update.source.ownership?.[role];
        if (current.id !== old) {
          const id = runtimeCandidateIdentity(update, role, raw);
          return {
            id,
            labels: {
              "localdot.cell": record.id,
              "localdot.role": role,
              "localdot.runtime-update": update.operationId,
            },
            update: { journal: update, role },
          };
        }
        if (update.phase !== "retiring") failed = true;
        // Original exact IDs remain valid containment owners even after a partial record save.
        return { id: current.id, labels: { "localdot.cell": record.id, "localdot.role": role } };
      }
      const expected =
        record.kind === "desktop"
          ? record.ownership?.[role === "gate" ? "gate" : "desktop"]
          : record.ownership?.[role === "gate" ? "gate" : "browser"];
      if (expected && current.id !== expected) throw failure();
      const match: Record<string, string> = { "localdot.cell": record.id, "localdot.role": role };
      if (record.kind === "browser") match["localdot.parent"] = record.parentCellId;
      if (labels["localdot.browser-owner"] !== undefined)
        match["localdot.browser-owner"] = labels["localdot.browser-owner"];
      if (Object.entries(match).some(([k, v]) => labels[k] !== v)) throw failure();
      return { id: current.id, labels: match };
    }
    if (labels["localdot.home"] === home) {
      if (
        !ULID_PATTERN.test(labels["localdot.brain"] ?? "") ||
        !ULID_PATTERN.test(labels["localdot.session"] ?? "") ||
        !["brain", "brain-gate"].includes(labels["localdot.role"] ?? "")
      )
        throw failure();
      return {
        id: current.id,
        labels: Object.fromEntries(
          ["localdot.home", "localdot.brain", "localdot.session", "localdot.role"].map((k) => [
            k,
            labels[k] as string,
          ]),
        ),
      };
    }
    if (records.has(labels["localdot.parent"] ?? "")) throw failure();
    return null;
  };
  async function discover() {
    const found = new Map<string, Target>();
    const consider = (raw: unknown, required = false, cellId?: string) => {
      try {
        if (cellId && identity(raw).labels["localdot.cell"] !== cellId) throw failure();
        const target = scope(raw);
        if (required && !target) throw failure();
        if (target) found.set(target.id, target);
      } catch {
        failed = true;
      }
    };
    const listed = await client.list(signal);
    if (!Array.isArray(listed) || listed.length > 4096) throw failure();
    for (const row of listed) {
      if (!object(row) || typeof row.Id !== "string" || !idPattern.test(row.Id)) throw failure();
      const labels = labelsOf(row.Labels);
      if (
        !records.has(labels["localdot.cell"] ?? "") &&
        !updates.has(labels["localdot.cell"] ?? "") &&
        !records.has(labels["localdot.parent"] ?? "") &&
        labels["localdot.home"] !== home
      )
        continue;
      try {
        const raw = await client.inspect(row.Id, signal);
        if (raw !== null) {
          if (identity(raw).id !== row.Id) throw failure();
          consider(raw, true);
        }
      } catch {
        failed = true;
      }
    }
    for (const record of [...before.records, ...[...updates.values()].map((row) => row.source)]) {
      const refs =
        record.kind === "desktop"
          ? [
              record.docker.desktop,
              record.docker.gate,
              record.ownership?.desktop,
              record.ownership?.gate,
            ]
          : [
              record.docker.browser,
              record.docker.gate,
              record.ownership?.browser,
              record.ownership?.gate,
            ];
      for (const ref of new Set(refs.filter((v): v is string => !!v))) {
        try {
          const raw = await client.inspect(ref, signal);
          if (raw !== null) {
            if (idPattern.test(ref) && identity(raw).id !== ref) throw failure();
            consider(raw, true, record.id);
          }
        } catch {
          failed = true;
        }
      }
    }
    for (const update of updates.values()) {
      for (const id of Object.values(update.candidates)) {
        if (!id) continue;
        try {
          const raw = await client.inspect(id, signal);
          if (raw !== null) {
            if (identity(raw).id !== id) throw failure();
            consider(raw, true, update.source.id);
          }
        } catch {
          failed = true;
        }
      }
    }
    return found;
  }
  const targets = await discover();
  const order = [...targets.values()].sort(
    (a, b) =>
      Number(b.labels["localdot.role"]?.includes("gate")) -
      Number(a.labels["localdot.role"]?.includes("gate")),
  );
  for (const target of order) {
    try {
      signal.throwIfAborted();
      const raw = await client.inspect(target.id, signal);
      if (raw === null) continue;
      if (!stopped(raw, target)) {
        try {
          await client.kill(target.id, signal);
        } catch {
          signal.throwIfAborted();
        }
        let confirmed = false;
        for (let attempt = 0; attempt < 50; attempt++) {
          const after = await client.inspect(target.id, signal);
          if (after === null || stopped(after, target, true)) {
            confirmed = true;
            break;
          }
          await delay(100, undefined, { signal });
        }
        if (!confirmed) throw failure();
      }
    } catch {
      failed = true;
    }
  }
  const finalTargets = await discover();
  for (const target of new Map([...finalTargets, ...targets]).values()) {
    try {
      if (!targets.has(target.id)) throw failure();
      const raw = await client.inspect(target.id, signal);
      if (raw !== null && !stopped(raw, target, true)) throw failure();
    } catch {
      failed = true;
    }
  }
  const after = await inventory(),
    finalEngine = await client.engine(signal);
  signal.throwIfAborted();
  if (failed || after.invalid || before.digest !== after.digest || engine.id !== finalEngine.id)
    throw failure();
  return { engineId: engine.id, observedContainers: targets.size };
}

export async function containInstalledContainers(input: ServiceConfiguration, signal: AbortSignal) {
  const config = await verifyServiceOwner(input);
  return containServiceContainers(
    config,
    installContainerClient(config.settings.dockerSocket),
    () => readContainerInventory(config.settings.home),
    signal,
  );
}
