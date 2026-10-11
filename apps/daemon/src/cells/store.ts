import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type TimedOperationKind, ULID_PATTERN } from "@localdot/protocol";
import { z } from "zod";
import { KEYD_PORT_RANGE, type PortRange } from "./ports.ts";
import type {
  BrowserCellDocker,
  BrowserCellRecord,
  CellDocker,
  CellRecord,
  StoredCellRecord,
} from "./types.ts";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// Docker's own rule for container and volume names.
const DOCKER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]+$/;
const OCTET = "(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])";
const DOTTED_QUAD = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);
const DOCKER_FIELDS = Object.entries({
  internalNetwork: "name",
  egressNetwork: "name",
  homeVolume: "name",
  gate: "name",
  desktop: "name",
  gateInternalIp: "address",
  gateEgressIp: "address",
  desktopIp: "address",
} satisfies Record<keyof CellDocker, "name" | "address">);
const BROWSER_DOCKER_FIELDS = Object.entries({
  internalNetwork: "name",
  egressNetwork: "name",
  profileVolume: "name",
  gate: "name",
  browser: "name",
  gateInternalIp: "address",
  gateEgressIp: "address",
  browserIp: "address",
} satisfies Record<keyof BrowserCellDocker, "name" | "address">);

// Ten minutes: far past a start, which gives up after three.
export const MAX_TIMING_MS = 600_000;
const Duration = z.number().int().positive().max(MAX_TIMING_MS);
const LastMs = z.strictObject({
  "first-start": Duration.optional(),
  start: Duration.optional(),
  update: Duration.optional(),
  stop: Duration.optional(),
} satisfies Record<TimedOperationKind, unknown>);
const StoredTimings = z.strictObject({ v: z.literal(1), lastMs: LastMs });
export type CellTimings = z.infer<typeof LastMs>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

const matches = (pattern: RegExp, value: unknown) =>
  typeof value === "string" && pattern.test(value);

// Each name ends in the cell's own id, so a record can only ever point at its own cell's objects.
const isOwnName = (value: unknown, id: string) =>
  matches(DOCKER_NAME_PATTERN, value) && (value as string).endsWith(`-${id}`);

// cell.json can be edited by hand, and its fields end up in Docker API paths, container env and
// keyd's port table, so a record counts only in the shape the daemon writes.
export function decodeRecord(
  value: unknown,
  id: string,
  ports: PortRange,
): StoredCellRecord | undefined {
  if (!isObject(value) || value.id !== id || !ULID_PATTERN.test(id)) return undefined;
  const legacy = value.v === 1;
  const browser = value.v === 2 && value.kind === "browser";
  if (!legacy && !(value.v === 2 && value.kind === "desktop") && !browser) return undefined;
  const keys = ["v", "id", "createdAt", "scale", "keydPort", "tokens", "docker"];
  if (!legacy) keys.push("kind");
  if (browser) keys.push("parentCellId");
  if (!exactKeys(value, keys, ["ownership"])) return undefined;
  if (browser && (!matches(ULID_PATTERN, value.parentCellId) || value.parentCellId === id))
    return undefined;
  const fields = browser ? BROWSER_DOCKER_FIELDS : DOCKER_FIELDS;
  const service = browser ? "browserd" : "desktopd";
  const executable = browser ? "browser" : "desktop";
  const { createdAt, scale, keydPort, tokens, docker, ownership } = value;
  const valid =
    typeof createdAt === "string" &&
    (scale === 1 || scale === 2) &&
    typeof keydPort === "number" &&
    Number.isInteger(keydPort) &&
    keydPort >= ports.from &&
    keydPort <= ports.to &&
    isObject(tokens) &&
    exactKeys(tokens, [service, "stream"], browser ? [] : ["capture"]) &&
    matches(TOKEN_PATTERN, tokens[service]) &&
    matches(TOKEN_PATTERN, tokens.stream) &&
    (!browser || tokens[service] !== tokens.stream) &&
    (tokens.capture === undefined ||
      (matches(TOKEN_PATTERN, tokens.capture) &&
        tokens.capture !== tokens[service] &&
        tokens.capture !== tokens.stream)) &&
    (ownership === undefined ||
      (isObject(ownership) &&
        exactKeys(ownership, [executable, "gate", "internalNetwork", "egressNetwork"]) &&
        [executable, "gate", "internalNetwork", "egressNetwork"].every((field) =>
          matches(/^[a-zA-Z0-9_-]{1,200}$/, ownership[field]),
        ))) &&
    isObject(docker) &&
    exactKeys(
      docker,
      fields.map(([field]) => field),
    ) &&
    fields.every(([field, kind]) =>
      kind === "name" ? isOwnName(docker[field], id) : matches(DOTTED_QUAD, docker[field]),
    );
  if (!valid) return undefined;
  return (legacy ? { ...value, v: 2, kind: "desktop" } : value) as unknown as StoredCellRecord;
}

// One cell.json per cell under <home>/cells/<id>/, mode 0600: it holds the per-cell tokens.
export class CellStore {
  readonly #root: string;

  constructor(
    readonly home: string,
    readonly keydPorts: PortRange = KEYD_PORT_RANGE,
  ) {
    this.#root = join(home, "cells");
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    chmodSync(this.#root, 0o700);
  }

  list(): CellRecord[] {
    return this.inventory().records;
  }

  // The cells that can't be used are reported by id: one may still have containers running.
  inventory(): { records: CellRecord[]; skipped: string[] } {
    const inventory = this.inventoryAll();
    return {
      records: inventory.records.filter(
        (record): record is CellRecord => record.kind === "desktop",
      ),
      skipped: inventory.skipped,
    };
  }

  inventoryAll(): { records: StoredCellRecord[]; skipped: string[] } {
    const records: StoredCellRecord[] = [];
    const skipped: string[] = [];
    for (const entry of readdirSync(this.#root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ULID_PATTERN.test(entry.name)) continue;
      const record = this.#listed(entry.name);
      if (record) records.push(record);
      else skipped.push(entry.name);
    }
    records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { records, skipped };
  }

  get(id: string): CellRecord | undefined {
    const record = this.getStored(id);
    return record?.kind === "desktop" ? record : undefined;
  }

  getBrowser(id: string): BrowserCellRecord | undefined {
    const record = this.getStored(id);
    return record?.kind === "browser" ? record : undefined;
  }

  browserFor(parentCellId: string): BrowserCellRecord | undefined {
    if (!ULID_PATTERN.test(parentCellId)) throw new Error("invalid browser parent");
    const { records, skipped } = this.inventoryAll();
    if (skipped.length) throw new Error("browser profile association cannot be confirmed");
    const matches = records.filter(
      (record): record is BrowserCellRecord =>
        record.kind === "browser" && record.parentCellId === parentCellId,
    );
    if (matches.length > 1) throw new Error("browser profile association is ambiguous");
    return matches[0];
  }

  getStored(id: string): StoredCellRecord | undefined {
    if (!ULID_PATTERN.test(id)) return undefined;
    let text: string;
    try {
      text = readFileSync(this.#file(id), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      // V8's SyntaxError quotes the text around the fault, and that text holds the cell's tokens.
      console.error(`cell ${id}: cell.json is not valid JSON, skipping it`);
      return undefined;
    }
    const record = decodeRecord(value, id, this.keydPorts);
    if (!record) {
      console.error(`cell ${id}: cell.json does not hold a valid cell record, skipping it`);
      return undefined;
    }
    if (isObject(value) && value.v === 1) this.#write(record);
    return record;
  }

  save(record: CellRecord): void {
    if (!ULID_PATTERN.test(record.id)) throw new Error("invalid cell id");
    const checked = decodeRecord(record, record.id, this.keydPorts);
    if (checked?.kind !== "desktop" || record.v !== 2)
      throw new Error("invalid desktop cell record");
    const existing = this.getStored(record.id);
    if (!existing && existsSync(this.#file(record.id)))
      throw new Error("cell identity cannot be confirmed");
    if (existing?.kind === "browser") throw new Error("cell identity is already owned");
    this.#write(checked);
  }

  saveBrowser(record: BrowserCellRecord): void {
    const checked = decodeRecord(record, record.id, this.keydPorts);
    if (checked?.kind !== "browser") throw new Error("invalid browser cell record");
    const existing = this.getStored(record.id);
    if (!existing && existsSync(this.#file(record.id)))
      throw new Error("cell identity cannot be confirmed");
    if (
      existing &&
      (existing.kind !== "browser" ||
        existing.parentCellId !== record.parentCellId ||
        existing.docker.profileVolume !== record.docker.profileVolume)
    )
      throw new Error("cell identity is already owned");
    if (!this.get(record.parentCellId)) throw new Error("browser parent is unavailable");
    const associated = this.browserFor(record.parentCellId);
    if (associated && associated.id !== record.id)
      throw new Error("browser profile already exists");
    this.#write(checked);
  }

  #write(record: StoredCellRecord): void {
    mkdirSync(this.#dir(record.id), { recursive: true, mode: 0o700 });
    writeAtomic(this.#file(record.id), record);
  }

  // How long this computer's last operation of each kind took. A missing or unreadable file only
  // means there is no history yet.
  timings(id: string): CellTimings {
    try {
      return StoredTimings.parse(JSON.parse(readFileSync(this.#timingsFile(id), "utf8"))).lastMs;
    } catch {
      return {};
    }
  }

  // Kept beside the record and only while it is there: a folder left without its cell.json would
  // hold up every new computer.
  saveTimings(id: string, lastMs: CellTimings): void {
    if (!existsSync(this.#file(id))) return;
    writeAtomic(this.#timingsFile(id), StoredTimings.parse({ v: 1, lastMs }));
  }

  remove(id: string): void {
    rmSync(this.#dir(id), { recursive: true, force: true });
  }

  // Where a cell's record lives: what a user fixes or removes when it can't be read.
  folder(id: string): string {
    return this.#dir(id);
  }

  #listed(id: string): StoredCellRecord | undefined {
    try {
      const record = this.getStored(id);
      if (!record && !existsSync(this.#file(id))) {
        console.error(`cell ${id}: cell.json is missing, skipping it`);
      }
      return record;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "no error code";
      console.error(`cell ${id}: cell.json is unreadable (${code}), skipping it`);
      return undefined;
    }
  }

  #dir(id: string): string {
    if (!ULID_PATTERN.test(id)) throw new Error("invalid cell id");
    return join(this.#root, id);
  }

  #file(id: string): string {
    return join(this.#dir(id), "cell.json");
  }

  #timingsFile(id: string): string {
    return join(this.#dir(id), "timings.json");
  }
}

function writeAtomic(file: string, value: unknown): void {
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}
