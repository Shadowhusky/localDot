import { randomBytes } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import {
  fileKind,
  type JsonPreview,
  PREVIEW_LIMITS,
  type PreviewReason,
  VIEWER_LIMITS,
} from "@localdot/protocol";
import { outputPath } from "../agent/output-store.ts";
import { boundedJson, tableExcerpt, textExcerpt } from "./excerpt.ts";
import { PreviewRefused, previewPng } from "./image-preview.ts";
import { StoredFiles } from "./stored.ts";

// Renders an office document or PDF somewhere other than the Mac (inside dot's computer), or says
// why it could not: its first page as a picture, or an office document's every page as a PDF.
export type Converted = Buffer | "computer_off" | "busy" | "failed" | "too_large";
export interface Converter {
  convert(name: string, bytes: Buffer, signal: AbortSignal): Promise<Converted>;
  pages(name: string, bytes: Buffer, signal: AbortSignal): Promise<Converted>;
}
export type Preview = { png: Buffer; madeBy: "daemon" | "computer" } | { json: string };
export type Pages = { pdf: Buffer } | { json: string };
const none = (reason: PreviewReason): { json: string } => ({
  json: JSON.stringify({ kind: "none", reason } satisfies JsonPreview),
});

// One preview per stored version; page images and pages are cached beside the task and never
// change, because a numbered version's bytes never change.
export class Previews {
  readonly #files: StoredFiles;
  readonly #pending = new Map<string, Promise<Preview | Pages>>();
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
    return this.#once(`${sessionId}/${name}/${version ?? 0}`, () =>
      this.#make(sessionId, name, version, signal),
    );
  }
  // An office document's every page as a PDF, made inside dot's computer.
  pages(
    sessionId: string,
    name: string,
    version: number | null,
    signal: AbortSignal,
  ): Promise<Pages> {
    return this.#once(`${sessionId}/${name}/${version ?? 0}/pages`, () =>
      this.#makePages(sessionId, name, version, signal),
    );
  }
  #once<T extends Preview | Pages>(key: string, make: () => Promise<T>): Promise<T> {
    const pending = this.#pending.get(key);
    if (pending) return pending as Promise<T>;
    const work = make().finally(() => this.#pending.delete(key));
    this.#pending.set(key, work);
    return work;
  }
  async #makePages(
    sessionId: string,
    name: string,
    version: number | null,
    signal: AbortSignal,
  ): Promise<Pages> {
    const rel = outputPath(sessionId, name, version);
    if (!rel || !this.#files.exists(rel)) return none("missing");
    if (fileKind(name) !== "office") return none("attachment");
    // Without a version the bytes are out/<name>, which a later version replaces: never cached.
    const cache = version === null ? undefined : `sessions/${sessionId}/previews/${name}`;
    const cached = cache && this.#files.head(`${cache}/${version}.pdf`, VIEWER_LIMITS.pdfBytes);
    if (cached && cached.size <= VIEWER_LIMITS.pdfBytes) return { pdf: cached.head };
    const whole = this.#files.head(rel, PREVIEW_LIMITS.convertBytes + 1);
    if (!whole) return none("missing");
    if (whole.size > PREVIEW_LIMITS.convertBytes) return none("too_large");
    const pdf = await this.#oneAtATime(() => this.converter.pages(name, whole.head, signal));
    if (typeof pdf === "string") return none(pdf);
    if (pdf.byteLength > VIEWER_LIMITS.pdfBytes) return none("too_large");
    if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") return none("failed");
    if (cache) this.#store(cache, `${version}.pdf`, pdf);
    return { pdf };
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
    // Without a version the bytes are out/<name>, which a later version replaces: never cached.
    const cache = version === null ? undefined : `sessions/${sessionId}/previews/${name}`;
    const cached = cache && this.#files.head(`${cache}/${version}.png`, PREVIEW_LIMITS.pngBytes);
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
    if (cache) this.#store(cache, `${version}.png`, png);
    return { png, madeBy };
  }
  #oneAtATime<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#converting.then(work, work);
    this.#converting = run.catch(() => {});
    return run;
  }
  #store(dir: string, file: string, bytes: Buffer): void {
    this.#files.directory(dir);
    const target = this.#files.path(`${dir}/${file}`);
    const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
      renameSync(temp, target);
    } finally {
      rmSync(temp, { force: true });
    }
  }
}
