import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  USER_UPLOAD,
  type UserUploadCreate,
  UserUploadId,
  type UserUploadReceipt,
  UserUploadStatus,
  userUploadPath,
} from "@localdot/protocol";
import { z } from "zod";

const Record = UserUploadStatus.extend({ cellId: z.string(), updatedAt: z.number() });
type Record = z.infer<typeof Record>;
export class UserUploadError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 422 | 507,
    message: string,
  ) {
    super(message);
  }
}
export type PlaceUserUpload = (
  cellId: string,
  file: { path: string; bytes: number; sha256: string },
  source: ReadableStream<Uint8Array>,
) => Promise<UserUploadReceipt>;

// The authenticated daemon owns staging and receipts, outside the agent's computer. Each
// acknowledgement follows a durable chunk + offset write. A lost reply is resolved by GET;
// retries never append the same chunk twice or replace an unrelated Downloads file.
export class UserUploads {
  readonly directory: string;
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #jobs = new Map<string, Promise<void>>();
  constructor(
    home: string,
    private readonly place: PlaceUserUpload,
    private readonly now = Date.now,
  ) {
    this.directory = join(home, "user-uploads");
  }
  async #locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(work);
    this.#locks.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.#locks.get(key) === pending) this.#locks.delete(key);
    }
  }
  #path(id: string, suffix: string) {
    if (!UserUploadId.safeParse(id).success) throw new UserUploadError(400, "Invalid upload ID.");
    return join(this.directory, `${id}.${suffix}`);
  }
  async #load(cellId: string, id: string): Promise<Record> {
    try {
      const record = Record.parse(JSON.parse(await readFile(this.#path(id, "json"), "utf8")));
      if (
        record.id !== id ||
        record.cellId !== cellId ||
        this.now() - record.updatedAt > USER_UPLOAD.retentionMs
      )
        throw new UserUploadError(404, "This upload expired. Select the file again.");
      return record;
    } catch (error) {
      if (error instanceof UserUploadError) throw error;
      throw new UserUploadError(404, "This upload is unavailable. Select the file again.");
    }
  }
  async #save(record: Record) {
    const temp = this.#path(record.id, "json.tmp");
    const file = await open(temp, "w", 0o600);
    try {
      await file.writeFile(JSON.stringify(record));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, this.#path(record.id, "json"));
    const dir = await open(this.directory, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
  #public(record: Record): UserUploadStatus {
    const { cellId: _cell, updatedAt: _time, ...value } = record;
    // A daemon restart retires the old worker, but leaves all acknowledged data resumable.
    return value.phase === "placing" && !this.#jobs.has(record.id)
      ? { ...value, phase: "paused", problem: "computer_unavailable" }
      : value;
  }
  async create(cellId: string, input: UserUploadCreate): Promise<UserUploadStatus> {
    return this.#locked("create", () =>
      this.#locked(input.id, async () => {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        try {
          const record = await this.#load(cellId, input.id);
          if (record.name !== input.name || record.bytes !== input.bytes)
            throw new UserUploadError(409, "This upload belongs to a different file.");
          return this.#public(record);
        } catch (error) {
          if (!(error instanceof UserUploadError && error.status === 404)) throw error;
        }
        // No ID reuse across computers, even if the caller knows someone else's ID.
        const files = await readdir(this.directory);
        let reserved = 0,
          remaining = 0,
          count = 0;
        for (const name of files) {
          if (!name.endsWith(".json")) continue;
          const record = Record.parse(
            JSON.parse(await readFile(join(this.directory, name), "utf8")),
          );
          if (
            this.now() - record.updatedAt > USER_UPLOAD.retentionMs &&
            !this.#jobs.has(record.id) &&
            !this.#locks.has(record.id)
          ) {
            await rm(this.#path(record.id, "part"), { force: true });
            await rm(this.#path(record.id, "json"), { force: true });
            continue;
          }
          if (record.id === input.id)
            throw new UserUploadError(409, "This upload ID is already in use.");
          if (record.phase !== "complete") {
            reserved += record.bytes;
            remaining += record.bytes - record.offset;
            count++;
          }
        }
        if (count >= 64 || reserved + input.bytes > USER_UPLOAD.totalBytes)
          throw new UserUploadError(
            413,
            "Finish or remove other uploads before adding more (20 GiB total).",
          );
        const disk = await statfs(this.directory);
        if (disk.bavail * disk.bsize < remaining + input.bytes + 256 * 1024 ** 2)
          throw new UserUploadError(507, "There is not enough free space for this upload.");
        const data = await open(this.#path(input.id, "part"), "wx", 0o600);
        await data.close();
        const record: Record = {
          ...input,
          cellId,
          offset: 0,
          phase: "receiving",
          updatedAt: this.now(),
        };
        await this.#save(record);
        return this.#public(record);
      }),
    );
  }
  async status(cellId: string, id: string) {
    return this.#public(await this.#load(cellId, id));
  }
  async append(cellId: string, id: string, offset: number, chunk: Uint8Array, sha256: string) {
    return this.#locked(id, async () => {
      const record = await this.#load(cellId, id);
      if (record.phase !== "receiving" || offset !== record.offset)
        throw new UserUploadError(409, "Upload offset changed. Check its status before retrying.");
      if (
        !chunk.byteLength ||
        chunk.byteLength > USER_UPLOAD.chunkBytes ||
        record.offset + chunk.byteLength > record.bytes
      )
        throw new UserUploadError(413, "The upload chunk exceeds the declared file size.");
      if (createHash("sha256").update(chunk).digest("hex") !== sha256)
        throw new UserUploadError(422, "The upload chunk did not pass verification. Retry it.");
      const data = await open(this.#path(id, "part"), "r+");
      try {
        // Discard an unacknowledged tail left by a process interruption.
        await data.truncate(record.offset);
        let written = 0;
        while (written < chunk.byteLength) {
          const part = await data.write(
            chunk,
            written,
            chunk.byteLength - written,
            record.offset + written,
          );
          if (!part.bytesWritten) throw new Error("upload write made no progress");
          written += part.bytesWritten;
        }
        await data.sync();
      } finally {
        await data.close();
      }
      record.offset += chunk.byteLength;
      record.updatedAt = this.now();
      await this.#save(record);
      return this.#public(record);
    });
  }
  async complete(cellId: string, id: string) {
    return this.#locked(id, async () => {
      const record = await this.#load(cellId, id);
      if (record.phase === "complete" || this.#jobs.has(id)) return this.#public(record);
      if (record.offset !== record.bytes)
        throw new UserUploadError(409, "The upload is not finished yet.");
      record.phase = "placing";
      delete record.problem;
      record.updatedAt = this.now();
      await this.#save(record);
      const job = this.#finish(record);
      this.#jobs.set(id, job);
      void job.catch(() => {}).finally(() => this.#jobs.delete(id));
      return this.#public(record);
    });
  }
  async #finish(record: Record): Promise<void> {
    try {
      if (!record.sha256) {
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(this.#path(record.id, "part")))
          hash.update(chunk);
        record.sha256 = hash.digest("hex");
        await this.#save(record);
      }
      const path = userUploadPath(record.id, record.name);
      const source = createReadStream(this.#path(record.id, "part"));
      let receipt: UserUploadReceipt;
      try {
        receipt = await this.place(
          record.cellId,
          { path, bytes: record.bytes, sha256: record.sha256 },
          Readable.toWeb(source, {
            strategy: { highWaterMark: 256 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
          }) as ReadableStream<Uint8Array>,
        );
      } finally {
        source.destroy();
      }
      if (
        receipt.path !== `~/${path}` ||
        receipt.bytes !== record.bytes ||
        receipt.sha256 !== record.sha256
      )
        throw new UserUploadError(422, "File receipt did not match.");
      record.path = receipt.path;
      record.phase = "complete";
      record.updatedAt = this.now();
      await this.#save(record);
      // Keep the small receipt so lost final responses can be reconciled after reload/restart.
      await rm(this.#path(record.id, "part"), { force: true });
    } catch (error) {
      if (record.phase === "complete") return;
      record.phase = "paused";
      record.problem =
        (error as NodeJS.ErrnoException)?.code === "ENOSPC" ||
        (error as { status?: number })?.status === 507
          ? "storage_full"
          : (error as { status?: number })?.status === 404
            ? "computer_update_required"
            : error instanceof UserUploadError && error.status === 422
              ? "verification_failed"
              : "computer_unavailable";
      record.updatedAt = this.now();
      await this.#save(record);
    }
  }
  async remove(cellId: string, id: string) {
    return this.#locked(id, async () => {
      const record = await this.#load(cellId, id);
      // The durable receipt is visible before the worker finishes removing its staging file.
      // Dismissing a completed chip is already safe during that final cleanup.
      if (record.phase === "complete") return; // Removing a chip does not delete a computer file.
      if (this.#jobs.has(id))
        throw new UserUploadError(409, "The file is being placed in Downloads.");
      await rm(this.#path(id, "part"), { force: true });
      await rm(this.#path(id, "json"), { force: true });
    });
  }
}
