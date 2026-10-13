import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type DockerClient, DockerError } from "./docker.ts";
import {
  ARCHIVE_SYSTEM,
  Manifest,
  migrationPlan,
  PREPARE_SYSTEM,
  SCAN_SYSTEM,
  SystemBaseMissing,
  verifyMigration,
} from "./system-migration-plan.ts";
import { ComputerSystemState, snapshotOf } from "./system-state.ts";
import { tar } from "./tar.ts";
import type { CellRecord } from "./types.ts";

type Docker = Pick<DockerClient, "request">;
const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const route = (id: string) => `/containers/${encodeURIComponent(id)}`;
export const SYSTEM_BASE = "localdot.system-base";
export const SYSTEM_SOURCE = "localdot.system-source";
const failure = () =>
  new Error(
    "Couldn’t prepare the computer update. Your apps and files are still there. Try again.",
  );
interface Container {
  Id: string;
  Image: string;
  State: { Running: boolean; Paused: boolean };
  Config: { Labels?: Record<string, string> };
}

// The original is never changed. Snapshot its stopped root filesystem, update a private clone,
// and commit the result. The update ledger must own the result before retiring the original.
export class SystemMigration {
  constructor(
    private readonly docker: Docker,
    private readonly home: string,
  ) {}

  // Check while the desktop is still running. Repeat under the stopped-container check before
  // copying anything, since Docker images can also be removed outside localDot.
  async preflight(record: CellRecord, target: string): Promise<void> {
    await this.#inspect(record, target, false);
  }

  async #inspect(record: CellRecord, target: string, stopped: boolean) {
    imageId.parse(target);
    const sourceId = record.ownership?.desktop;
    if (!sourceId) throw failure();
    const source = await this.docker.request<Container>({
      method: "GET",
      path: `${route(sourceId)}/json`,
    });
    if (
      source.Id !== sourceId ||
      (stopped && source.State.Running) ||
      source.State.Paused ||
      source.Config.Labels?.["localdot.cell"] !== record.id ||
      source.Config.Labels?.["localdot.role"] !== "desktop"
    )
      throw failure();
    let base = source.Config.Labels?.[SYSTEM_BASE] ?? source.Image;
    const snapshot = snapshotOf(source.Config.Labels);
    if (snapshot)
      base = (await new ComputerSystemState(this.home, this.docker, target).readImage(snapshot))
        .baseImage;
    imageId.parse(base);
    // Image config is the migration authority, not an editable container label.
    if (source.Config.Labels?.[SYSTEM_BASE]) {
      const image = await this.docker.request<{ Config: { Labels?: Record<string, string> } }>({
        method: "GET",
        path: `/images/${encodeURIComponent(source.Image)}/json`,
      });
      if (image.Config.Labels?.[SYSTEM_BASE] !== base) throw failure();
    }
    const image = await this.docker.request<{
      Id: string;
      Config: Record<string, unknown>;
      Architecture: string;
    }>({ method: "GET", path: `/images/${encodeURIComponent(target)}/json` });
    const previous = await this.docker
      .request<{ Id: string; Architecture: string }>({
        method: "GET",
        path: `/images/${encodeURIComponent(base)}/json`,
      })
      .catch((error: unknown) => {
        if (error instanceof DockerError && error.status === 404) throw new SystemBaseMissing(base);
        throw error;
      });
    if (previous.Id !== base || image.Id !== target || image.Architecture !== previous.Architecture)
      throw failure();
    // Rebuilding a development tag must not make a live computer's migration base dangling.
    // Keep both the old base and the new one under content-addressed local tags.
    for (const id of new Set([base, target]))
      await this.docker.request({
        method: "POST",
        path: `/images/${encodeURIComponent(id)}/tag`,
        query: { repo: "localdot/system-base", tag: id.slice("sha256:".length) },
      });
    return { sourceId, base, image };
  }

  async prepare(record: CellRecord, target: string): Promise<string> {
    const { sourceId, base, image } = await this.#inspect(record, target, true);
    const docker = this.docker;
    const operation = randomUUID();
    const helpers: string[] = [];
    const checkpoint = await this.docker.request<{ Id: string }>({
      method: "POST",
      path: "/commit",
      timeoutMs: 300000,
      query: {
        container: sourceId,
        pause: "false",
        repo: "localdot/update-backup",
        tag: operation,
      },
    });
    imageId.parse(checkpoint.Id);
    try {
      const original = await scan(base);
      const fresh = await scan(target);
      const saved = await scan(checkpoint.Id);
      const plan = migrationPlan(original.manifest, fresh.manifest, saved.manifest);
      const clone = await helper(
        checkpoint.Id,
        PREPARE_SYSTEM,
        JSON.stringify({
          remove: plan.remove,
          directories: plan.directories.map((p) => [p, fresh.manifest[p]]),
        }),
        false,
      );
      await run(clone);
      // Batch exact files into one archive; never copy a parent tree over user additions.
      if (plan.copy.length) {
        const exporter = await helper(target, ARCHIVE_SYSTEM, JSON.stringify(plan.copy), false);
        await run(exporter);
        const envelope = await this.docker.request<Buffer>({
          method: "GET",
          path: `${route(exporter)}/archive`,
          query: { path: "/tmp/localdot-update.tar" },
          response: "buffer",
          timeoutMs: 120000,
        });
        await this.docker.request({
          method: "PUT",
          path: `${route(clone)}/archive`,
          query: { path: "/", copyUIDGID: "true", noOverwriteDirNonDir: "true" },
          raw: { contentType: "application/x-tar", data: archivePayload(envelope) },
          timeoutMs: 120000,
        });
      }
      const committed = await this.docker.request<{ Id: string }>({
        method: "POST",
        path: "/commit",
        timeoutMs: 300000,
        query: {
          container: clone,
          pause: "false",
          repo: "localdot/updated-system",
          tag: operation,
        },
        body: {
          ...image.Config,
          Labels: {
            ...((image.Config.Labels as Record<string, string>) ?? {}),
            [SYSTEM_BASE]: target,
            [SYSTEM_SOURCE]: sourceId,
            // Commit merges in the clone's labels; a migrated system is no longer that snapshot.
            "localdot.snapshot": "",
            "localdot.snapshot-source": "",
          },
        },
      });
      const result = imageId.parse(committed.Id);
      verifyMigration(saved.manifest, fresh.manifest, (await scan(result)).manifest, plan);
      return result;
    } finally {
      for (const id of helpers.reverse()) {
        await this.docker
          .request({ method: "DELETE", path: route(id), query: { force: "true", v: "true" } })
          .catch(() => console.error("Computer update helper cleanup needs retry"));
      }
    }
    async function helper(
      image: string,
      script: string,
      argument?: string,
      readonly = true,
    ): Promise<string> {
      const made = await docker.request<{ Id: string }>({
        method: "POST",
        path: "/containers/create",
        body: {
          Image: image,
          User: "0:0",
          Entrypoint: ["python3", "-I", "-B", "-S", "-c", script],
          Cmd: argument ? ["/tmp/localdot-system-plan.json"] : [],
          NetworkDisabled: true,
          Labels: {
            "localdot.cell": record.id,
            "localdot.role": "system-migration",
            "localdot.migration": operation,
          },
          HostConfig: {
            NetworkMode: "none",
            ReadonlyRootfs: readonly,
            CapDrop: ["ALL"],
            CapAdd: ["DAC_OVERRIDE", "CHOWN", "FOWNER"],
            SecurityOpt: ["no-new-privileges"],
            Memory: 1024 * 1024 * 1024,
            NanoCpus: 1_000_000_000,
            PidsLimit: 32,
          },
        },
      });
      if (!made.Id) throw failure();
      helpers.push(made.Id);
      if (argument)
        await docker.request({
          method: "PUT",
          path: `${route(made.Id)}/archive`,
          query: { path: "/tmp" },
          raw: {
            contentType: "application/x-tar",
            data: tar([{ name: "localdot-system-plan.json", data: argument, mode: 0o600 }]),
          },
        });
      return made.Id;
    }
    async function run(id: string): Promise<Buffer> {
      await docker.request({ method: "POST", path: `${route(id)}/start` });
      const done = await docker.request<{ StatusCode: number }>({
        method: "POST",
        path: `${route(id)}/wait`,
        timeoutMs: 300000,
      });
      if (done.StatusCode !== 0) throw failure();
      return helperOutput(
        await docker.request<Buffer>({
          method: "GET",
          path: `${route(id)}/logs`,
          query: { stdout: "true", stderr: "true" },
          response: "buffer",
          timeoutMs: 120000,
        }),
      );
    }
    async function scan(image: string): Promise<{ id: string; manifest: Manifest }> {
      const id = await helper(image, SCAN_SYSTEM);
      const manifest = Manifest.parse(JSON.parse((await run(id)).toString("utf8")));
      return { id, manifest };
    }
  }
}

// Docker's non-TTY log stream has eight-byte frame headers. Refuse malformed/truncated replies.
export function helperOutput(buffer: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; ) {
    if (offset + 8 > buffer.length) throw failure();
    const channel = buffer[offset],
      length = buffer.readUInt32BE(offset + 4);
    offset += 8;
    if ((channel !== 1 && channel !== 2) || offset + length > buffer.length) throw failure();
    if (channel === 1) parts.push(buffer.subarray(offset, offset + length));
    offset += length;
  }
  return Buffer.concat(parts);
}

// Docker wraps the generated tar in a single-file tar response. Unwrap only that known file.
export function archivePayload(envelope: Buffer): Buffer {
  for (let offset = 0; offset + 512 <= envelope.length; ) {
    const header = envelope.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, "");
    const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, ""), 8);
    const checksum = Number.parseInt(
      header.subarray(148, 156).toString().trim().replace(/\0.*$/s, ""),
      8,
    );
    let actual = 0;
    for (let i = 0; i < 512; i++) actual += i >= 148 && i < 156 ? 32 : (header[i] ?? 0);
    if (
      checksum !== actual ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      offset + 512 + size > envelope.length
    )
      throw failure();
    if (name === "localdot-update.tar" && (header[156] === 48 || header[156] === 0))
      return envelope.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw failure();
}

// Used by both installers and daemon recovery before a migrated image can replace an original.
export async function verifyMigratedImage(
  docker: Docker,
  migrated: string,
  target: string,
  source?: string,
): Promise<void> {
  imageId.parse(migrated);
  const expected = await docker.request<{ Id: string; Architecture: string; Os: string }>({
    method: "GET",
    path: `/images/${encodeURIComponent(target)}/json`,
  });
  const image = await docker.request<{
    Id: string;
    Architecture: string;
    Os: string;
    Config: { Labels?: Record<string, string> };
  }>({ method: "GET", path: `/images/${encodeURIComponent(migrated)}/json` });
  const labels = image.Config?.Labels;
  if (
    image.Id !== migrated ||
    labels?.[SYSTEM_BASE] !== expected.Id ||
    !/^[a-f0-9]{64}$/.test(labels?.[SYSTEM_SOURCE] ?? "") ||
    (source !== undefined && labels?.[SYSTEM_SOURCE] !== source) ||
    image.Architecture !== expected.Architecture ||
    image.Os !== "linux" ||
    expected.Os !== "linux"
  )
    throw failure();
}
