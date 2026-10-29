import { createHash, randomUUID } from "node:crypto";
import { readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ULID_PATTERN, ulid } from "../../../../packages/protocol/src/ids.ts";
import { type DockerClient, DockerError } from "../../../daemon/src/cells/docker.ts";
import { NAME_PREFIX } from "../../../daemon/src/cells/spec.ts";
import { CellStore } from "../../../daemon/src/cells/store.ts";
import {
  BLANK_CREDENTIALS,
  ComputerSystemState,
  snapshotOf,
} from "../../../daemon/src/cells/system-state.ts";
import {
  COMPUTER_IMPORT_FILE,
  readComputerImport,
  writeComputerImport,
} from "../../../daemon/src/dots/computer-import.ts";
import { instanceOf } from "../../../daemon/src/dots/instance.ts";
import { writePrivateJson } from "../../../daemon/src/dots/private-json.ts";

type Docker = Pick<DockerClient, "request">;
type Raw = Record<string, unknown>;
const raw = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class DotDockerError extends Error {}

// The shared browser profile of a dot, named after its home and labelled as
// cells/accounts-profile.ts labels it; importing that module would load the browser's seccomp
// profile, which this command has no use for.
const ACCOUNTS_PROFILE_ROLE = "accounts-profile";

export function accountsVolume(home: string): string {
  const install = createHash("sha256").update(realpathSync(home)).digest("hex");
  return `${NAME_PREFIX}accounts-${install.slice(0, 12)}`;
}

async function inspect(docker: Docker, kind: "containers" | "volumes" | "images", id: string) {
  try {
    const path =
      kind === "containers"
        ? `/containers/${encodeURIComponent(id)}/json`
        : kind === "images"
          ? `/images/${encodeURIComponent(id)}/json`
          : `/volumes/${encodeURIComponent(id)}`;
    return await docker.request<Raw>({ method: "GET", path });
  } catch (error) {
    if (error instanceof DockerError && error.status === 404) return undefined;
    throw error;
  }
}

async function runningUsers(docker: Docker, volume: string): Promise<number> {
  const found = await docker.request<unknown>({
    method: "GET",
    path: "/containers/json",
    query: { filters: JSON.stringify({ volume: [volume], status: ["running", "paused"] }) },
  });
  if (!Array.isArray(found)) throw new DotDockerError("Docker's container list is unreadable.");
  return found.length;
}

// A one-shot copy of one volume's files into another, with no network and the source read-only.
async function copyVolume(
  docker: Docker,
  options: { name: string; image: string; user: string; from: string; to: string },
) {
  const made = await docker.request<{ Id?: unknown }>({
    method: "POST",
    path: "/containers/create",
    query: { name: options.name },
    body: {
      Image: options.image,
      User: options.user,
      Entrypoint: ["/bin/cp"],
      Cmd: ["-a", "--", "/source/.", "/destination/"],
      Labels: { "localdot.role": "dot-copy" },
      NetworkDisabled: true,
      HostConfig: {
        NetworkMode: "none",
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        CapAdd: options.user.startsWith("0:") ? ["CHOWN", "DAC_OVERRIDE", "FOWNER"] : [],
        SecurityOpt: ["no-new-privileges"],
        Mounts: [
          { Type: "volume", Source: options.from, Target: "/source", ReadOnly: true },
          { Type: "volume", Source: options.to, Target: "/destination" },
        ],
      },
    },
  });
  if (typeof made.Id !== "string") throw new DotDockerError("Docker didn't make the copy helper.");
  try {
    await docker.request({ method: "POST", path: `/containers/${made.Id}/start` });
    const result = await docker.request<{ StatusCode?: number }>({
      method: "POST",
      path: `/containers/${made.Id}/wait`,
      timeoutMs: 30 * 60_000,
    });
    if (result.StatusCode !== 0) throw new DotDockerError("Copying the files didn't finish.");
  } finally {
    await docker
      .request({ method: "DELETE", path: `/containers/${made.Id}`, query: { force: "true" } })
      .catch(() => {});
  }
}

// Browser sign-ins: the source dot's shared browser profile, copied into the new dot's. No
// browser of the source may be running, so the profile is copied as it was saved.
export async function copySignins(
  docker: Docker,
  options: { source: string; destination: string; image: string },
): Promise<boolean> {
  const from = accountsVolume(options.source);
  if (!(await inspect(docker, "volumes", from))) return false;
  if (await runningUsers(docker, from))
    throw new DotDockerError(
      "The source dot's browser is open. Stop its computer, then add the dot again.",
    );
  const owner = randomUUID();
  const to = accountsVolume(options.destination);
  if (await inspect(docker, "volumes", to))
    throw new DotDockerError("The new dot already has saved sign-ins.");
  await docker.request({
    method: "POST",
    path: "/volumes/create",
    body: {
      Name: to,
      Labels: { "localdot.role": ACCOUNTS_PROFILE_ROLE, "localdot.accounts-owner": owner },
    },
  });
  writePrivateJson(join(options.destination, "accounts-profile.json"), {
    v: 1,
    owner,
    migration: "done",
  });
  await copyVolume(docker, {
    name: `${to}-copy`,
    image: options.image,
    user: "1000:1000",
    from,
    to,
  });
  return true;
}

// dot's computer: its stopped desktop committed with blank credentials (as a recovery capture
// does) and its home folder copied, both labelled as a snapshot the new dot's first computer is
// made from, with fresh tokens.
export async function stageComputer(
  docker: Docker,
  options: { source: string; destination: string; desktopImage: string },
): Promise<boolean> {
  const sourceInstance = instanceOf(options.source);
  const store = new CellStore(options.source, {
    from: sourceInstance.ports.keyd[0],
    to: sourceInstance.ports.keyd[1],
  });
  const record = store.list().at(-1);
  if (!record?.ownership?.desktop) return false;
  const desktop = await inspect(docker, "containers", record.ownership.desktop);
  const state = raw(desktop?.State) ? desktop.State : undefined;
  const config = raw(desktop?.Config) ? desktop.Config : undefined;
  const labels = raw(config?.Labels) ? (config.Labels as Record<string, string>) : {};
  if (!desktop || !state || labels["localdot.cell"] !== record.id) return false;
  if (state.Running !== false || state.Paused !== false)
    throw new DotDockerError(
      "The source dot's computer is running. Stop it, then add the dot again.",
    );
  const id = ulid();
  let baseImage = labels["localdot.system-base"] || String(desktop.Image ?? "");
  const prior = snapshotOf(labels);
  if (prior)
    baseImage = (
      await new ComputerSystemState(options.source, docker, options.desktopImage).readImage(prior)
    ).baseImage;
  const volume = `${NAME_PREFIX}home-${id}`;
  const committed = await docker.request<{ Id?: unknown }>({
    method: "POST",
    path: "/commit",
    timeoutMs: 600_000,
    query: {
      container: record.ownership.desktop,
      pause: "false",
      repo: "localdot/system-state",
      tag: id.toLowerCase(),
    },
    body: {
      Env: BLANK_CREDENTIALS,
      Labels: { "localdot.snapshot": id, "localdot.snapshot-source": record.ownership.desktop },
    },
  });
  if (typeof committed.Id !== "string")
    throw new DotDockerError("Docker didn't save the computer.");
  try {
    await docker.request({
      method: "POST",
      path: "/volumes/create",
      body: { Name: volume, Labels: { "localdot.cell": id, "localdot.role": "home" } },
    });
    await copyVolume(docker, {
      name: `${NAME_PREFIX}dot-copy-${id}`,
      image: options.desktopImage,
      user: "0:0",
      from: record.docker.homeVolume,
      to: volume,
    });
    const after = await inspect(docker, "containers", record.ownership.desktop);
    if (!raw(after?.State) || after.State.Running !== false)
      throw new DotDockerError("The source dot's computer started during the copy. Try again.");
    new ComputerSystemState(options.destination, docker, options.desktopImage).records.write(id, {
      cellId: id,
      container: record.ownership.desktop,
      image: committed.Id,
      baseImage,
      homeVolume: volume,
    });
    writeComputerImport(options.destination, id);
    return true;
  } catch (error) {
    await removeStaged(docker, { volume, image: committed.Id });
    throw error;
  }
}

async function removeStaged(docker: Docker, staged: { volume?: string; image?: string }) {
  if (staged.volume)
    await docker
      .request({ method: "DELETE", path: `/volumes/${encodeURIComponent(staged.volume)}` })
      .catch(() => {});
  if (staged.image)
    await docker
      .request({ method: "DELETE", path: `/images/${encodeURIComponent(staged.image)}` })
      .catch(() => {});
}

// Everything a dot made in Docker: its computers' and browsers' containers, networks and home
// volumes (labelled with their cell), its brains and connectors (labelled with its home), its
// saved sign-ins, and a copied computer it never used. Images stay for image cleanup.
export async function removeDotDocker(docker: Docker, home: string): Promise<void> {
  const cells = new Set<string>();
  try {
    for (const entry of readdirSync(join(home, "cells"), { withFileTypes: true }))
      if (entry.isDirectory() && ULID_PATTERN.test(entry.name)) cells.add(entry.name);
  } catch {}
  const staged = readComputerImport(home);
  if (staged) cells.add(staged);
  const filters = [...[...cells].map((id) => `localdot.cell=${id}`), `localdot.home=${home}`];
  for (const label of filters) {
    const query = { all: "true", filters: JSON.stringify({ label: [label] }) };
    const containers = await docker.request<unknown>({
      method: "GET",
      path: "/containers/json",
      query,
    });
    for (const container of Array.isArray(containers) ? containers : [])
      if (raw(container) && typeof container.Id === "string")
        await docker.request({
          method: "DELETE",
          path: `/containers/${container.Id}`,
          query: { force: "true", v: "true" },
        });
  }
  for (const label of filters) {
    const networks = await docker.request<unknown>({
      method: "GET",
      path: "/networks",
      query: { filters: JSON.stringify({ label: [label] }) },
    });
    for (const network of Array.isArray(networks) ? networks : [])
      if (raw(network) && typeof network.Id === "string")
        await docker.request({ method: "DELETE", path: `/networks/${network.Id}` });
  }
  const volumes: string[] = [];
  for (const label of filters.filter((filter) => filter.startsWith("localdot.cell="))) {
    const listing = await docker.request<unknown>({
      method: "GET",
      path: "/volumes",
      query: { filters: JSON.stringify({ label: [label] }) },
    });
    const found = raw(listing) && Array.isArray(listing.Volumes) ? listing.Volumes : [];
    for (const volume of found)
      if (raw(volume) && typeof volume.Name === "string") volumes.push(volume.Name);
  }
  try {
    volumes.push(accountsVolume(home));
  } catch {}
  for (const volume of volumes)
    await docker
      .request({ method: "DELETE", path: `/volumes/${encodeURIComponent(volume)}` })
      .catch((error) => {
        if (!(error instanceof DockerError && error.status === 404)) throw error;
      });
  rmSync(join(home, COMPUTER_IMPORT_FILE), { force: true });
}
