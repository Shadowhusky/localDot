import { z } from "zod";
import { PrivateFiles } from "../private-files.ts";

const FILE = "account.json";
const FOLDER = "account";
const Stored = z.object({ separate: z.literal(true) });

// Which Claude account this dot's Claude Code uses: the one signed in on this Mac, or one of its
// own whose folder is in this dot's home. Only the choice is kept here; Claude Code keeps the
// sign-in itself, and localDot never reads it.
export class ClaudeAccountChoice {
  readonly #files: PrivateFiles;
  constructor(home: string) {
    this.#files = new PrivateFiles(home, "claude-code");
  }
  get separate(): boolean {
    try {
      const text = this.#files.text(FILE, 1024);
      return text !== undefined && Stored.safeParse(JSON.parse(text)).success;
    } catch {
      return false;
    }
  }
  set(separate: boolean): void {
    if (separate) this.#files.write(FILE, `${JSON.stringify({ separate: true })}\n`);
    else this.#files.remove(FILE);
  }
  // The account's folder, made on first use; undefined while the dot uses the Mac's account.
  folder(): string | undefined {
    return this.separate ? this.#files.directory(FOLDER) : undefined;
  }
}
