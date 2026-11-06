import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BrowserLifecycleError } from "./browser-ledger.ts";
import { type DockerClient, DockerError, dockerLogLines } from "./docker.ts";

type Docker = Pick<DockerClient, "request">;
type Raw = Record<string, unknown>;

export const ACCOUNTS_PROFILE_ROLE = "accounts-profile";
const OWNER_LABEL = "localdot.accounts-owner";
const COPY_MS = 10 * 60_000;
const BACKUP_ROLE = "accounts-backup";
const LAST_VERSION = /^[0-9]+(?:\.[0-9]+){3}$/u;
// What a browser rebuilds by itself isn't worth a copy, and a stale lock must not come back.
const NOT_COPIED = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GrShaderCache",
  "ShaderCache",
  "CacheStorage",
  "ScriptCache",
  "Singleton*",
];
// A one-way upgrade rests on this copy, so the files sign-ins depend on are compared after it, and
// there must be room for it before the first byte. Exits 28 for no room and 29 for a bad copy.
const COPY_PROFILE = `set -euo pipefail
excluded=(${NOT_COPIED.map((name) => `--exclude='${name}'`).join(" ")})
need=$(du -sk "\${excluded[@]}" /legacy | cut -f1)
have=$(df -k --output=avail /profile | tail -1)
[ "$have" -gt $((need + need / 10 + 65536)) ] || exit 28
find /profile -mindepth 1 -delete
tar -C /legacy "\${excluded[@]}" -cf - . | tar -C /profile -xpf -
for file in "chromium/Local State" chromium/Default/Cookies "chromium/Default/Login Data"; do
  [ ! -e "/legacy/$file" ] || cmp -s "/legacy/$file" "/profile/$file" || exit 29
done`;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/u;
const identitySchema = z.strictObject({
  v: z.literal(1),
  owner: z.uuid(),
  migration: z.enum(["pending", "done"]),
  from: z.string().regex(NAME).optional(),
});
type Identity = z.infer<typeof identitySchema>;
const raw = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface AccountsProfileDeps {
  home: string;
  docker: Docker;
  prefix: string;
  // The browser image: it has the profile folder the copy fills and runs as the same user.
  image(): string;
}

// The one browser profile the user's sign-ins live in. It belongs to no computer: browser cells
// mount it one at a time, and stopping, removing or replacing a computer never deletes it. It is
// named after this install's home, so another daemon on the same Docker engine never opens it.
export class AccountsProfile {
  readonly volume: string;
  readonly #path: string;

  constructor(private readonly deps: AccountsProfileDeps) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*-$/u.test(deps.prefix)) throw new BrowserLifecycleError();
    const install = createHash("sha256").update(realpathSync(deps.home)).digest("hex");
    this.volume = `${deps.prefix}accounts-${install.slice(0, 12)}`;
    this.#path = join(deps.home, "accounts-profile.json");
  }

  // Creates the volume on first use and fills it once from a profile one of this install's
  // browser cells kept for itself before sign-ins were shared: the first of `legacy` that no
  // container holds (the starting computer's own), else the newest.
  async ensure(legacy: readonly string[] = []): Promise<void> {
    const identity = await this.#identity();
    await this.#volume(identity);
    if (identity.migration === "done") return;
    const source = await this.#legacySource(legacy);
    if (source) await this.#copy(identity, source);
    this.#write({ ...identity, migration: "done", ...(source ? { from: source } : {}) });
  }

  async migrated(): Promise<boolean> {
    return (await this.#identity()).migration === "done";
  }

  // Containers that have the volume mounted, running or not.
  async holders(): Promise<string[]> {
    const found = await this.deps.docker.request<unknown>({
      method: "GET",
      path: "/containers/json",
      query: { all: "true", filters: JSON.stringify({ volume: [this.volume] }) },
    });
    if (!Array.isArray(found)) throw new BrowserLifecycleError();
    return found.map((entry) => {
      if (!raw(entry) || typeof entry.Id !== "string" || !/^[a-f0-9]{64}$/u.test(entry.Id))
        throw new BrowserLifecycleError();
      return entry.Id;
    });
  }

  // Signs out of everything: the volume is deleted and made again, empty. No browser may hold it.
  async wipe(): Promise<void> {
    const identity = await this.#identity();
    if ((await this.holders()).length) throw new BrowserLifecycleError("Saved sign-ins are in use");
    if (await this.#inspect()) {
      await this.#volume(identity);
      await this.deps.docker.request({
        method: "DELETE",
        path: `/volumes/${encodeURIComponent(this.volume)}`,
      });
      if (await this.#inspect()) throw new BrowserLifecycleError();
    }
    await this.dropBackup();
    const fresh: Identity = { v: 1, owner: identity.owner, migration: "done" };
    this.#write(fresh);
    await this.#volume(fresh);
  }

  get backupVolume(): string {
    return `${this.volume}-backup`;
  }

  // The version of the browser that last opened the profile; undefined for one no browser has.
  async lastVersion(): Promise<string | undefined> {
    if (!(await this.#inspect())) return undefined;
    const identity = await this.#identity();
    const { code, output } = await this.#helper(
      `${this.volume}-version`,
      this.labels(identity.owner),
      ["/bin/cat", "/legacy/chromium/Last Version"],
      this.volume,
      undefined,
      60_000,
    );
    const version = code === 0 ? output[0]?.trim() : undefined;
    return version && LAST_VERSION.test(version) ? version : undefined;
  }

  // A copy of the sign-ins in a volume of its own, kept beside the profile and never on the host.
  async backup(): Promise<void> {
    const identity = await this.#identity();
    const volume = this.backupVolume;
    const expected = { ...this.labels(identity.owner), "localdot.role": BACKUP_ROLE };
    if (!(await this.#inspect(volume)))
      await this.deps.docker.request({
        method: "POST",
        path: "/volumes/create",
        body: { Name: volume, Labels: expected },
      });
    await this.#copyProfile(identity, this.volume, volume, "backup");
  }

  async hasBackup(): Promise<boolean> {
    const found = await this.#inspect(this.backupVolume);
    return raw(found?.Labels) && found.Labels["localdot.role"] === BACKUP_ROLE;
  }

  // Puts the backup back in place of the profile. No browser may hold it.
  async restoreBackup(): Promise<void> {
    const identity = await this.#identity();
    if ((await this.holders()).length) throw new BrowserLifecycleError("Saved sign-ins are in use");
    if (!(await this.hasBackup())) throw new BrowserLifecycleError("There is no backup to restore");
    await this.#copyProfile(identity, this.backupVolume, this.volume, "restore");
  }

  async dropBackup(): Promise<void> {
    if (!(await this.#inspect(this.backupVolume))) return;
    await this.deps.docker.request({
      method: "DELETE",
      path: `/volumes/${encodeURIComponent(this.backupVolume)}`,
    });
  }

  async #copyProfile(identity: Identity, from: string, to: string, kind: string): Promise<void> {
    const { code } = await this.#helper(
      `${this.volume}-${kind}`,
      { ...this.labels(identity.owner), "localdot.role": "accounts-copy" },
      ["/bin/bash", "-c", COPY_PROFILE],
      from,
      to,
      COPY_MS,
    );
    if (code === 28)
      throw new BrowserLifecycleError("Docker doesn't have enough free disk space for a copy");
    if (code !== 0) throw new BrowserLifecycleError("Saved sign-ins could not be copied");
  }

  labels(owner: string): Record<string, string> {
    return { "localdot.role": ACCOUNTS_PROFILE_ROLE, [OWNER_LABEL]: owner };
  }

  async #identity(): Promise<Identity> {
    let text: string | undefined;
    try {
      text = readFileSync(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new BrowserLifecycleError("Saved sign-ins cannot be confirmed");
    }
    if (text !== undefined) {
      try {
        return identitySchema.parse(JSON.parse(text));
      } catch {
        throw new BrowserLifecycleError("Saved sign-ins cannot be confirmed");
      }
    }
    // A volume without its record (the daemon's folder was reset) still holds the user's
    // sign-ins: keep it, and never fill it from an older profile.
    const existing = await this.#inspect();
    const labels = existing && raw(existing.Labels) ? existing.Labels : undefined;
    const owner = labels?.[OWNER_LABEL];
    if (
      existing &&
      (labels?.["localdot.role"] !== ACCOUNTS_PROFILE_ROLE || !z.uuid().safeParse(owner).success)
    )
      throw new BrowserLifecycleError("Saved sign-ins cannot be confirmed");
    const identity: Identity = existing
      ? { v: 1, owner: owner as string, migration: "done" }
      : { v: 1, owner: randomUUID(), migration: "pending" };
    this.#write(identity);
    return identity;
  }

  #write(value: Identity): void {
    const temp = `${this.#path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(identitySchema.parse(value))}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temp, this.#path);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  async #inspect(name = this.volume): Promise<Raw | undefined> {
    try {
      const value = await this.deps.docker.request<unknown>({
        method: "GET",
        path: `/volumes/${encodeURIComponent(name)}`,
      });
      if (!raw(value) || value.Name !== name) throw new BrowserLifecycleError();
      return value;
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return undefined;
      throw error;
    }
  }

  async #volume(identity: Identity): Promise<void> {
    const expected = this.labels(identity.owner);
    let found = await this.#inspect();
    if (!found) {
      await this.deps.docker.request({
        method: "POST",
        path: "/volumes/create",
        body: { Name: this.volume, Labels: expected },
      });
      found = await this.#inspect();
    }
    const labels = found && raw(found.Labels) ? found.Labels : undefined;
    if (!labels || Object.entries(expected).some(([key, value]) => labels[key] !== value))
      throw new BrowserLifecycleError("Saved sign-ins cannot be confirmed");
  }

  async #legacySource(legacy: readonly string[]): Promise<string | undefined> {
    const listing = await this.deps.docker.request<unknown>({
      method: "GET",
      path: "/volumes",
      query: { filters: JSON.stringify({ label: ["localdot.role=profile"] }) },
    });
    const volumes = raw(listing) && Array.isArray(listing.Volumes) ? listing.Volumes : [];
    const prefix = this.deps.prefix.replace(/[.]/gu, "\\.");
    const own = new RegExp(`^${prefix}profile-([0-7][0-9A-HJKMNP-TV-Z]{25})$`, "u");
    const candidates = volumes
      .filter(raw)
      .filter((volume) => {
        const match = typeof volume.Name === "string" ? own.exec(volume.Name) : null;
        return (
          match &&
          legacy.includes(match[0]) &&
          raw(volume.Labels) &&
          volume.Labels["localdot.cell"] === match[1]
        );
      })
      .map((volume) => ({ name: volume.Name as string, created: String(volume.CreatedAt ?? "") }))
      .sort(
        (a, b) =>
          Number(b.name === legacy[0]) - Number(a.name === legacy[0]) ||
          b.created.localeCompare(a.created),
      );
    for (const candidate of candidates) {
      const mounted = await this.deps.docker.request<unknown>({
        method: "GET",
        path: "/containers/json",
        query: { all: "true", filters: JSON.stringify({ volume: [candidate.name] }) },
      });
      if (Array.isArray(mounted) && mounted.length === 0) return candidate.name;
    }
    return undefined;
  }

  async #copy(identity: Identity, source: string): Promise<void> {
    const { code } = await this.#helper(
      `${this.volume}-copy`,
      { ...this.labels(identity.owner), "localdot.role": "accounts-copy" },
      ["/bin/cp", "-a", "--", "/legacy/.", "/profile/"],
      source,
      this.volume,
      COPY_MS,
    );
    if (code !== 0) throw new BrowserLifecycleError("Saved sign-ins could not be copied");
  }

  // A short-lived container with one volume to read at /legacy and maybe one to fill at /profile: no
  // network, no capabilities, and the user the profile belongs to.
  async #helper(
    name: string,
    labels: Record<string, string>,
    [entrypoint, ...command]: readonly string[],
    read: string,
    write: string | undefined,
    timeoutMs: number,
  ): Promise<{ code: number; output: readonly string[] }> {
    const stale = await this.#container(name);
    if (stale) {
      const config = raw(stale.Config) ? stale.Config : undefined;
      const found = config && raw(config.Labels) ? config.Labels : undefined;
      if (!found || Object.entries(labels).some(([key, value]) => found[key] !== value))
        throw new BrowserLifecycleError("Saved sign-ins cannot be confirmed");
      await this.#remove(stale.Id);
    }
    const created = await this.deps.docker.request<{ Id?: unknown }>({
      method: "POST",
      path: "/containers/create",
      query: { name },
      body: {
        Image: this.deps.image(),
        User: "1000:1000",
        Entrypoint: [entrypoint],
        Cmd: command,
        NetworkDisabled: true,
        Labels: labels,
        HostConfig: {
          NetworkMode: "none",
          Mounts: [
            { Type: "volume", Source: read, Target: "/legacy", ReadOnly: true },
            ...(write ? [{ Type: "volume", Source: write, Target: "/profile" }] : []),
          ],
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
        },
      },
    });
    const id = created?.Id;
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/u.test(id)) throw new BrowserLifecycleError();
    try {
      await this.deps.docker.request({
        method: "POST",
        path: `/containers/${id}/start`,
      });
      const result = await this.deps.docker.request<unknown>({
        method: "POST",
        path: `/containers/${id}/wait`,
        timeoutMs,
      });
      if (!raw(result) || typeof result.StatusCode !== "number") throw new BrowserLifecycleError();
      const logs = write
        ? undefined
        : await this.deps.docker.request<Buffer>({
            method: "GET",
            path: `/containers/${id}/logs`,
            query: { stdout: "true", stderr: "false", tail: "1" },
            response: "buffer",
          });
      return {
        code: result.StatusCode,
        output: Buffer.isBuffer(logs) ? dockerLogLines(logs) : [],
      };
    } finally {
      await this.#remove(id);
    }
  }

  async #container(name: string): Promise<(Raw & { Id: string }) | undefined> {
    try {
      const value = await this.deps.docker.request<unknown>({
        method: "GET",
        path: `/containers/${encodeURIComponent(name)}/json`,
      });
      if (!raw(value) || typeof value.Id !== "string") throw new BrowserLifecycleError();
      return value as Raw & { Id: string };
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return undefined;
      throw error;
    }
  }

  async #remove(id: string): Promise<void> {
    try {
      await this.deps.docker.request({
        method: "DELETE",
        path: `/containers/${encodeURIComponent(id)}`,
        query: { force: "true" },
      });
    } catch (error) {
      if (!(error instanceof DockerError && error.status === 404)) throw error;
    }
  }
}
