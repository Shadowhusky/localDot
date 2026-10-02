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
import { ULID_PATTERN } from "@localdot/protocol";
import { KEYD_PORT_RANGE, type PortRange } from "./ports.ts";
import type { CellDocker, CellRecord } from "./types.ts";

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

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const matches = (pattern: RegExp, value: unknown) =>
  typeof value === "string" && pattern.test(value);

// Each name ends in the cell's own id, so a record can only ever point at its own cell's objects.
const isOwnName = (value: unknown, id: string) =>
  matches(DOCKER_NAME_PATTERN, value) && (value as string).endsWith(`-${id}`);

// cell.json can be edited by hand, and its fields end up in Docker API paths, container env and
// keyd's port table, so a record counts only in the shape the daemon writes.
function isCellRecord(value: unknown, id: string, ports: PortRange): value is CellRecord {
  if (!isObject(value) || value.v !== 1 || value.id !== id) return false;
  const { createdAt, scale, keydPort, tokens, docker } = value;
  return (
    typeof createdAt === "string" &&
    (scale === 1 || scale === 2) &&
    typeof keydPort === "number" &&
    Number.isInteger(keydPort) &&
    keydPort >= ports.from &&
    keydPort <= ports.to &&
    isObject(tokens) &&
    matches(TOKEN_PATTERN, tokens.desktopd) &&
    matches(TOKEN_PATTERN, tokens.stream) &&
    isObject(docker) &&
    DOCKER_FIELDS.every(([field, kind]) =>
      kind === "name" ? isOwnName(docker[field], id) : matches(DOTTED_QUAD, docker[field]),
    )
  );
}

// One cell.json per cell under <home>/cells/<id>/, mode 0600: it holds the per-cell tokens.
export class CellStore {
  readonly #root: string;

  constructor(
    home: string,
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
    const records: CellRecord[] = [];
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
    if (!isCellRecord(value, id, this.keydPorts)) {
      console.error(`cell ${id}: cell.json does not hold a valid cell record, skipping it`);
      return undefined;
    }
    return value;
  }

  save(record: CellRecord): void {
    mkdirSync(this.#dir(record.id), { recursive: true, mode: 0o700 });
    const file = this.#file(record.id);
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  remove(id: string): void {
    rmSync(this.#dir(id), { recursive: true, force: true });
  }

  // Where a cell's record lives: what a user fixes or removes when it can't be read.
  folder(id: string): string {
    return this.#dir(id);
  }

  #listed(id: string): CellRecord | undefined {
    try {
      const record = this.get(id);
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
}
