import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ULID_PATTERN } from "@localdot/protocol";
import type { CellRecord } from "./types.ts";

// One cell.json per cell under <home>/cells/<id>/, mode 0600: it holds the per-cell tokens.
export class CellStore {
  readonly #root: string;

  constructor(home: string) {
    this.#root = join(home, "cells");
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    chmodSync(this.#root, 0o700);
  }

  list(): CellRecord[] {
    return readdirSync(this.#root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && ULID_PATTERN.test(entry.name))
      .flatMap((entry) => {
        const record = this.get(entry.name);
        return record ? [record] : [];
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
    let record: CellRecord | null;
    try {
      record = JSON.parse(text) as CellRecord | null;
    } catch {
      // V8's SyntaxError quotes the text around the fault, and that text holds the cell's tokens.
      console.error(`cell ${id}: cell.json is not valid JSON, skipping it`);
      return undefined;
    }
    return record?.v === 1 && record.id === id ? record : undefined;
  }

  save(record: CellRecord): void {
    mkdirSync(this.#dir(record.id), { recursive: true, mode: 0o700 });
    const file = this.#file(record.id);
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    try {
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  remove(id: string): void {
    rmSync(this.#dir(id), { recursive: true, force: true });
  }

  #dir(id: string): string {
    if (!ULID_PATTERN.test(id)) throw new Error("invalid cell id");
    return join(this.#root, id);
  }

  #file(id: string): string {
    return join(this.#dir(id), "cell.json");
  }
}
