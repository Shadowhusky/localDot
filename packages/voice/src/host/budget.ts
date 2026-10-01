import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { HAN } from "../lang.ts";
import type { Budget, CloudKind } from "./router.ts";

// Azure bills each Chinese character (hanzi, kanji, hanja) as two; ElevenLabs bills each character.
export function billableChars(kind: CloudKind, text: string): number {
  let count = 0;
  for (const ch of text) count += kind === "azure" && HAN.test(ch) ? 2 : 1;
  return count;
}

export type Limits = Record<CloudKind, number>;

// Azure's free tier is 0.5M characters a month; ElevenLabs stays off until the user sets a cap.
export const DEFAULT_LIMITS: Limits = { azure: 500_000, elevenlabs: 0 };

interface Usage {
  month: string;
  azure: number;
  elevenlabs: number;
}

// Characters each cloud voice spoke this calendar month (UTC), kept in a small JSON file.
export class UsageLedger implements Budget {
  readonly #file: string;
  readonly #limits: Limits;
  readonly #now: () => Date;
  #unsaved = false;

  constructor(file: string, limits: Limits = DEFAULT_LIMITS, now: () => Date = () => new Date()) {
    this.#file = file;
    this.#limits = limits;
    this.#now = now;
  }

  used(kind: CloudKind): number {
    return this.#read()?.[kind] ?? Number.POSITIVE_INFINITY;
  }

  // An unreadable or unsaved record refuses: spending without knowing what was spent is not allowed.
  allows(kind: CloudKind, text: string): boolean {
    return this.used(kind) + billableChars(kind, text) <= this.#limits[kind];
  }

  record(kind: CloudKind, text: string): void {
    const usage = this.#read();
    if (!usage) return;
    usage[kind] += billableChars(kind, text);
    try {
      mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
      const temp = `${this.#file}.tmp`;
      writeFileSync(temp, `${JSON.stringify(usage)}\n`, { mode: 0o600 });
      renameSync(temp, this.#file);
    } catch {
      this.#unsaved = true;
    }
  }

  #read(): Usage | null {
    if (this.#unsaved) return null;
    const month = this.#now().toISOString().slice(0, 7);
    let text: string;
    try {
      text = readFileSync(this.#file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { month, azure: 0, elevenlabs: 0 };
      return null;
    }
    try {
      const value = JSON.parse(text) as Partial<Usage>;
      if (typeof value.month !== "string") return null;
      if (value.month !== month) return { month, azure: 0, elevenlabs: 0 };
      const azure = value.azure;
      const elevenlabs = value.elevenlabs;
      if (!Number.isFinite(azure) || !Number.isFinite(elevenlabs)) return null;
      return { month, azure: azure as number, elevenlabs: elevenlabs as number };
    } catch {
      return null;
    }
  }
}
