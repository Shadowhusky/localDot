import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BrowserLifecycleError } from "./browser-ledger.ts";
import { type DockerClient, DockerError } from "./docker.ts";

type Docker = Pick<DockerClient, "request">;
type Raw = Record<string, unknown>;

export const ACCOUNTS_PROFILE_ROLE = "accounts-profile";
const OWNER_LABEL = "localdot.accounts-owner";
const COPY_MS = 10 * 60_000;
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
    const fresh: Identity = { v: 1, owner: identity.owner, migration: "done" };
    this.#write(fresh);
    await this.#volume(fresh);
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
    const name = `${this.volume}-copy`;
    const labels = { ...this.labels(identity.owner), "localdot.role": "accounts-copy" };
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
        Entrypoint: ["/bin/cp"],
        Cmd: ["-a", "--", "/legacy/.", "/profile/"],
        NetworkDisabled: true,
        Labels: labels,
        HostConfig: {
          NetworkMode: "none",
          Mounts: [
            { Type: "volume", Source: source, Target: "/legacy", ReadOnly: true },
            { Type: "volume", Source: this.volume, Target: "/profile" },
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
        timeoutMs: COPY_MS,
      });
      if (!raw(result) || result.StatusCode !== 0)
        throw new BrowserLifecycleError("Saved sign-ins could not be copied");
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
