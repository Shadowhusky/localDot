import { ULID_PATTERN } from "@localdot/protocol";
import { z } from "zod";
import { PrivateRecords } from "../agent/safety/private-records.ts";
import { type DockerClient, DockerError } from "./docker.ts";
import type { CellRecord } from "./types.ts";

export const SYSTEM_UPDATE_BLOCKED =
  "This computer has installed apps or system changes that this update cannot preserve yet. Your computer is unchanged; you can keep using it. Updating localDot itself is separate.";
export class SystemUpdateBlocked extends Error {
  constructor() {
    super(SYSTEM_UPDATE_BLOCKED);
  }
}

const Snapshot = z.strictObject({
  cellId: z.string().regex(ULID_PATTERN),
  container: z.string().min(1).max(200),
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  baseImage: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  homeVolume: z.string().min(1).max(200),
});
type Snapshot = z.infer<typeof Snapshot>;
type Docker = Pick<DockerClient, "request">;
const path = (id: string) => `/containers/${encodeURIComponent(id)}`;
const failure = () =>
  new Error(
    "Your computer's system data could not be preserved. Recovery has stopped without creating a clean computer.",
  );

// A recovery checkpoint retains the entire root filesystem, including package databases and
// dependencies. /config is a volume, which Docker commit excludes; copy it separately. Never
// substitute a base image when either half is missing. Snapshots remain for recovery/retry.
export class ComputerSystemState {
  readonly records: PrivateRecords<Snapshot>;
  constructor(
    home: string,
    private readonly docker: Docker,
    private readonly copyImage: string,
  ) {
    this.records = new PrivateRecords(home, "computer-system-state", (raw, id) => {
      const value = Snapshot.parse(raw);
      if (value.cellId !== id) throw failure();
      return value;
    });
  }

  async capture(record: CellRecord): Promise<void> {
    const saved = this.records.read(record.id);
    if (saved) {
      if (
        saved.container !== record.ownership?.desktop ||
        saved.homeVolume !== record.docker.homeVolume
      )
        throw failure();
      await this.read(record.id);
      return;
    }
    const id = record.ownership?.desktop;
    if (!id) throw failure();
    const source = await this.docker.request<{
      Id: string;
      Image: string;
      State: { Running: boolean; Paused: boolean };
      Config: { Labels?: Record<string, string> };
    }>({ method: "GET", path: `${path(id)}/json` });
    if (
      source.Id !== id ||
      source.State.Running !== false ||
      source.State.Paused !== false ||
      source.Config.Labels?.["localdot.cell"] !== record.id ||
      source.Config.Labels?.["localdot.role"] !== "desktop"
    )
      throw failure();
    let baseImage = source.Image;
    const priorId = source.Config.Labels?.["localdot.snapshot"];
    if (priorId) {
      const prior = await this.read(priorId);
      if (prior.image !== source.Image) throw failure();
      baseImage = prior.baseImage;
    }
    const image = await this.docker.request<{ Id: string }>({
      method: "POST",
      path: "/commit",
      timeoutMs: 300000,
      query: {
        container: id,
        pause: "false",
        repo: "localdot/system-state",
        tag: record.id.toLowerCase(),
      },
      body: { Labels: { "localdot.snapshot": record.id, "localdot.snapshot-source": id } },
    });
    const value = Snapshot.parse({
      cellId: record.id,
      container: id,
      image: image.Id,
      baseImage,
      homeVolume: record.docker.homeVolume,
    });
    await this.verify(value);
    const after = await this.docker.request<typeof source>({
      method: "GET",
      path: `${path(id)}/json`,
    });
    if (after.Id !== id || after.State.Running !== false || after.State.Paused !== false)
      throw failure();
    this.records.write(record.id, value);
  }

  async read(cellId: string): Promise<Snapshot> {
    const value = this.records.read(cellId);
    if (!value) throw failure();
    await this.verify(value);
    return value;
  }

  private async verify(value: Snapshot): Promise<void> {
    const image = await this.docker.request<{
      Id: string;
      Config: { Labels?: Record<string, string> };
    }>({ method: "GET", path: `/images/${encodeURIComponent(value.image)}/json` });
    const volume = await this.docker.request<{ Name: string; Labels?: Record<string, string> }>({
      method: "GET",
      path: `/volumes/${encodeURIComponent(value.homeVolume)}`,
    });
    if (
      image.Id !== value.image ||
      image.Config.Labels?.["localdot.snapshot"] !== value.cellId ||
      image.Config.Labels?.["localdot.snapshot-source"] !== value.container ||
      volume.Name !== value.homeVolume ||
      volume.Labels?.["localdot.cell"] !== value.cellId ||
      volume.Labels?.["localdot.role"] !== "home"
    )
      throw failure();
  }

  async cleanupCopy(targetId: string): Promise<void> {
    if (!ULID_PATTERN.test(targetId)) throw failure();
    const helper = await this.docker
      .request<{ Id: string; Config: { Labels?: Record<string, string> } }>({
        method: "GET",
        path: `${path(`localdot-system-copy-${targetId}`)}/json`,
      })
      .catch((error) => {
        if (error instanceof DockerError && error.status === 404) return undefined;
        throw error;
      });
    if (!helper) return;
    if (
      !helper.Id ||
      helper.Config.Labels?.["localdot.cell"] !== targetId ||
      helper.Config.Labels?.["localdot.role"] !== "system-copy"
    )
      throw failure();
    await this.docker.request({
      method: "DELETE",
      path: path(helper.Id),
      query: { force: "true", v: "true" },
    });
  }

  async copyHome(sourceId: string, targetId: string, destination: string): Promise<string> {
    const source = await this.read(sourceId);
    const target = await this.docker.request<{ Name: string; Labels?: Record<string, string> }>({
      method: "GET",
      path: `/volumes/${encodeURIComponent(destination)}`,
    });
    if (
      sourceId === targetId ||
      destination === source.homeVolume ||
      target.Name !== destination ||
      target.Labels?.["localdot.cell"] !== targetId ||
      target.Labels?.["localdot.role"] !== "home"
    )
      throw failure();
    for (const volume of [source.homeVolume, destination]) {
      const mounts = await this.docker.request<unknown[]>({
        method: "GET",
        path: "/containers/json",
        query: { all: "true", filters: JSON.stringify({ volume: [volume] }) },
      });
      if (!Array.isArray(mounts) || mounts.length) throw failure();
    }
    const made = await this.docker.request<{ Id: string }>({
      method: "POST",
      path: "/containers/create",
      query: { name: `localdot-system-copy-${targetId}` },
      body: {
        Image: this.copyImage,
        User: "0:0",
        Entrypoint: ["/bin/cp"],
        Cmd: ["-a", "--", "/source/.", "/destination/"],
        Labels: { "localdot.cell": targetId, "localdot.role": "system-copy" },
        NetworkDisabled: true,
        HostConfig: {
          NetworkMode: "none",
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER"],
          SecurityOpt: ["no-new-privileges"],
          Mounts: [
            { Type: "volume", Source: source.homeVolume, Target: "/source", ReadOnly: true },
            { Type: "volume", Source: destination, Target: "/destination" },
          ],
        },
      },
    });
    if (!made.Id || typeof made.Id !== "string") throw failure();
    try {
      await this.docker.request({ method: "POST", path: `${path(made.Id)}/start` });
      const result = await this.docker.request<{ StatusCode: number }>({
        method: "POST",
        path: `${path(made.Id)}/wait`,
        timeoutMs: 300000,
      });
      if (result.StatusCode !== 0) throw failure();
    } finally {
      await this.docker
        .request({ method: "DELETE", path: path(made.Id), query: { force: "true", v: "true" } })
        .catch((error) => {
          if (!(error instanceof DockerError && error.status === 404)) throw error;
        });
    }
    return source.image;
  }
}

// A clean-image swap is not a migration. Refuse it when the writable system layer contains
// anything: even package metadata, permissions and deletions can be essential to installed apps.
// This is deliberately conservative until system-preserving image migration is available.
export async function requireUnmodifiedSystem(docker: Docker, container: string): Promise<void> {
  const source = await docker.request<{ Config?: { Labels?: Record<string, string> } }>({
    method: "GET",
    path: `${path(container)}/json`,
  });
  const changes = await docker.request<unknown>({
    method: "GET",
    path: `${path(container)}/changes`,
  });
  if (source.Config?.Labels?.["localdot.snapshot"] || !Array.isArray(changes) || changes.length) {
    throw new SystemUpdateBlocked();
  }
}
