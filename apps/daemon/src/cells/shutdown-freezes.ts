import { ULID_PATTERN } from "@localdot/protocol";
import { z } from "zod";
import { PrivateFiles } from "../agent/private-files.ts";

const FILE = "shutdown-frozen.json";
const Stored = z.object({ cells: z.array(z.string().regex(ULID_PATTERN)).max(64) });

// Computers a service stop froze while a task was live: the next start thaws them. One someone
// stops after that start is forgotten, so a user's Stop is never undone.
export class ShutdownFreezes {
  readonly #files: PrivateFiles;
  #pending = new Set<string>();
  constructor(home: string) {
    this.#files = new PrivateFiles(home);
  }
  record(cellIds: Iterable<string>): void {
    const cells = [...new Set(cellIds)].filter((id) => ULID_PATTERN.test(id));
    if (cells.length) this.#files.write(FILE, `${JSON.stringify({ cells })}\n`);
  }
  // Read once at start; the record is cleared, so a later start thaws nothing again.
  load(): void {
    try {
      const text = this.#files.text(FILE, 16 * 1024);
      if (text === undefined) return;
      this.#files.write(FILE, `${JSON.stringify({ cells: [] })}\n`);
      const stored = Stored.safeParse(JSON.parse(text));
      if (stored.success) this.#pending = new Set(stored.data.cells);
    } catch {
      // An unreadable record thaws nothing.
    }
  }
  forget(cellId: string): void {
    this.#pending.delete(cellId);
  }
  take(): string[] {
    const cells = [...this.#pending];
    this.#pending.clear();
    return cells;
  }
}
