import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { HostExport } from "@localdot/protocol";
import { z } from "zod";

export const EXPORTS_DIR = "exports";
const INDEX = "exports.json";
const PART = ".part";

export interface ExportLimits {
  // A finished video older than this goes.
  maxAgeMs: number;
  // The newest this many finished videos are kept.
  maxCount: number;
  // All videos together, and any one while it is made.
  maxBytes: number;
}

export const DEFAULT_EXPORT_LIMITS: ExportLimits = {
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxCount: 10,
  maxBytes: 2 * 1024 * 1024 * 1024,
};

export const INTERRUPTED =
  "localDot restarted before this video was finished. Try again to make it.";

const Index = z.strictObject({ v: z.literal(1), exports: z.array(HostExport).max(64) });

function finished(record: HostExport): boolean {
  return record.phase === "done" || record.phase === "failed";
}

// The host's exported videos: one file per video under <home>/exports, named by its id alone, and
// an index of them replaced whole on each change of phase.
export class ExportStore {
  readonly dir: string;
  readonly limits: ExportLimits;
  #records = new Map<string, HostExport>();

  constructor(home: string, limits: ExportLimits = DEFAULT_EXPORT_LIMITS) {
    this.dir = join(home, EXPORTS_DIR);
    this.limits = limits;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.#load();
  }

  // Newest first.
  list(): HostExport[] {
    return [...this.#records.values()].reverse().sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): HostExport | undefined {
    return this.#records.get(id);
  }

  // Changes a record in memory; `save` writes the index.
  set(record: HostExport): void {
    this.#records.set(record.id, record);
  }

  save(): void {
    const file = join(this.dir, INDEX);
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ v: 1, exports: this.list() }), { mode: 0o600 });
    renameSync(temporary, file);
  }

  file(record: Pick<HostExport, "id" | "request">): string {
    return join(this.dir, `${record.id}.${record.request.format}`);
  }

  partFile(record: Pick<HostExport, "id" | "request">): string {
    return `${this.file(record)}${PART}`;
  }

  remove(id: string): void {
    const record = this.#records.get(id);
    if (!record) return;
    this.#records.delete(id);
    rmSync(this.file(record), { force: true });
    rmSync(this.partFile(record), { force: true });
    this.save();
  }

  // Lets go of finished videos past their age, beyond the newest few, and the oldest while all of
  // them together are over the size limit; a video still being made is never touched. Files no
  // record names (left by a crash) go too.
  sweep(now: number): string[] {
    const gone: string[] = [];
    const done = this.list().filter(finished);
    let keptBytes = 0;
    done.forEach((record, index) => {
      if (
        now - record.createdAt > this.limits.maxAgeMs ||
        index >= this.limits.maxCount ||
        keptBytes + record.bytes > this.limits.maxBytes
      ) {
        gone.push(record.id);
        this.#records.delete(record.id);
      } else keptBytes += record.bytes;
    });
    const kept = new Set<string>(
      [...this.#records.values()].flatMap((record) =>
        record.phase === "done"
          ? [this.file(record)]
          : record.phase === "failed"
            ? []
            : [this.partFile(record)],
      ),
    );
    for (const name of readdirSync(this.dir)) {
      const path = join(this.dir, name);
      if (name === INDEX || kept.has(path)) continue;
      rmSync(path, { force: true, recursive: false });
    }
    if (gone.length) this.save();
    return gone;
  }

  #load(): void {
    let parsed: z.infer<typeof Index> | undefined;
    try {
      const file = join(this.dir, INDEX);
      if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) return;
      parsed = Index.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      console.error("exports: the list of exported videos could not be read; starting afresh");
      return;
    }
    let interrupted = false;
    for (const record of parsed.exports.toReversed()) {
      if (finished(record)) this.#records.set(record.id, record);
      else {
        interrupted = true;
        this.#records.set(record.id, {
          ...record,
          phase: "failed",
          leftMs: null,
          error: INTERRUPTED,
        });
      }
    }
    if (interrupted) this.save();
  }
}
