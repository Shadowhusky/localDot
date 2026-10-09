import { randomBytes } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { fileKind, type JsonPreview, PREVIEW_LIMITS, type PreviewReason } from "@localdot/protocol";
import { outputPath } from "../agent/output-store.ts";
import { boundedJson, tableExcerpt, textExcerpt } from "./excerpt.ts";
import { PreviewRefused, previewPng } from "./image-preview.ts";
import { StoredFiles } from "./stored.ts";

// Renders an office document or PDF to a page image somewhere other than the Mac (inside dot's
// computer), or says why it could not.
export type Converted = Buffer | "computer_off" | "busy" | "failed";
export interface Converter {
  convert(name: string, bytes: Buffer, signal: AbortSignal): Promise<Converted>;
}
export type Preview = { png: Buffer; madeBy: "daemon" | "computer" } | { json: string };
const none = (reason: PreviewReason): Preview => ({
  json: JSON.stringify({ kind: "none", reason } satisfies JsonPreview),
});

// One preview per stored version; page images are cached beside the task and never change,
// because a version's bytes never change.
export class Previews {
  readonly #files: StoredFiles;
  readonly #pending = new Map<string, Promise<Preview>>();
  #converting: Promise<unknown> = Promise.resolve();
  constructor(
    home: string,
    private readonly converter: Converter,
  ) {
    this.#files = new StoredFiles(home);
  }
  preview(
    sessionId: string,
    name: string,
    version: number | null,
    signal: AbortSignal,
  ): Promise<Preview> {
    const key = `${sessionId}/${name}/${version ?? 0}`;
    const pending = this.#pending.get(key);
    if (pending) return pending;
    const work = this.#make(sessionId, name, version, signal).finally(() =>
      this.#pending.delete(key),
    );
    this.#pending.set(key, work);
    return work;
  }
  async #make(
    sessionId: string,
    name: string,
    version: number | null,
    signal: AbortSignal,
  ): Promise<Preview> {
    const rel = outputPath(sessionId, name, version);
    if (!rel || !this.#files.exists(rel)) return none("missing");
    const kind = fileKind(name);
    if (kind === "attachment") return none("attachment");
    if (kind === "text" || kind === "table") {
      const read = this.#files.head(rel, PREVIEW_LIMITS.readBytes);
      if (!read) return none("missing");
      return {
        json: boundedJson(
          (kind === "text" ? textExcerpt : tableExcerpt)(name, read.head, read.size),
        ),
      };
    }
    const cache = `sessions/${sessionId}/previews/${name}`;
    const cached = this.#files.head(`${cache}/${version ?? 0}.png`, PREVIEW_LIMITS.pngBytes);
    const madeBy = kind === "image" ? "daemon" : "computer";
    if (cached && cached.size <= PREVIEW_LIMITS.pngBytes) return { png: cached.head, madeBy };
    const limit = kind === "image" ? PREVIEW_LIMITS.imageInputBytes : PREVIEW_LIMITS.convertBytes;
    const whole = this.#files.head(rel, limit + 1);
    if (!whole) return none("missing");
    if (whole.size > limit) return none("too_large");
    let source = whole.head;
    if (kind !== "image") {
      const converted = await this.#oneAtATime(() =>
        this.converter.convert(name, whole.head, signal),
      );
      if (typeof converted === "string") return none(converted);
      source = converted;
    }
    let png: Buffer;
    try {
      png = await previewPng(source);
    } catch (error) {
      // A page image from the computer that is not a sane PNG is a failed conversion.
      return none(error instanceof PreviewRefused && kind === "image" ? error.reason : "failed");
    }
    this.#store(cache, `${version ?? 0}.png`, png);
    return { png, madeBy };
  }
  #oneAtATime<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#converting.then(work, work);
    this.#converting = run.catch(() => {});
    return run;
  }
  #store(dir: string, file: string, png: Buffer): void {
    this.#files.directory(dir);
    const target = this.#files.path(`${dir}/${file}`);
    const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, png, { flag: "wx", mode: 0o600 });
      renameSync(temp, target);
    } finally {
      rmSync(temp, { force: true });
    }
  }
}
