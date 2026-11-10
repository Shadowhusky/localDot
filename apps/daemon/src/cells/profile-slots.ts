import { BrowserLifecycleError } from "./browser-ledger.ts";
import { type DockerClient, DockerError, dockerLogLines } from "./docker.ts";

type Docker = Pick<DockerClient, "request">;
type Raw = Record<string, unknown>;
const raw = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Sites that end a sign-in used from two browsers at once, signing every holder out (Google did in
// the Nov 6 trial; Microsoft's account hosts are likely to). A copied slot leaves their cookies out:
// a conversation's browser signs in to them itself.
export const EXCLUSIVE_SIGN_INS =
  /(^|\.)(google\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})|youtube\.com|gmail\.com|live\.com|microsoftonline\.com|microsoft\.com|office\.com)$/u;

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
  "Sessions",
  "Current Session",
  "Current Tabs",
  "Last Session",
  "Last Tabs",
];
const EXCLUDED = `excluded=(${NOT_COPIED.map((name) => `--exclude='${name}'`).join(" ")})`;
// Everything but the caches, while the main browser runs: its components hardly change. Exits 28
// when Docker has no room for it.
const COPY_BULK = `set -euo pipefail
${EXCLUDED}
find /profile -mindepth 1 -delete
[ -d /legacy/chromium ] || exit 0
need=$(du -sk "\${excluded[@]}" /legacy/chromium | cut -f1)
have=$(df -k --output=avail /profile | tail -1)
[ "$have" -gt $((need + need / 10 + 65536)) ] || exit 28
mkdir -p /profile/chromium
tar -C /legacy/chromium "\${excluded[@]}" -cf - . | tar -C /profile/chromium -xpf -`;
// The profile's own state, again, while the main browser is paused: no file changes under the copy.
const COPY_STATE = `set -euo pipefail
${EXCLUDED}
[ -d /legacy/chromium ] || exit 0
rm -rf "/profile/chromium/Default" "/profile/chromium/Local State"
parts=()
[ ! -e "/legacy/chromium/Local State" ] || parts+=("Local State")
[ ! -d /legacy/chromium/Default ] || parts+=(Default)
[ \${#parts[@]} -eq 0 ] || tar -C /legacy/chromium "\${excluded[@]}" -cf - "\${parts[@]}" | tar -C /profile/chromium -xpf -`;
// On the copy only: takes the exclusive sites' cookies out, overwriting what they held, and checks
// every database opens whole. Prints how many cookies it took out; exits 30 for a damaged database.
const SCRUB = `import os, re, sqlite3, sys
root = "/profile/chromium"
sites = re.compile(${JSON.stringify(EXCLUSIVE_SIGN_INS.source)})
removed = 0
for folder, _, names in os.walk(root):
    for name in names:
        path = os.path.join(folder, name)
        try:
            with open(path, "rb") as handle:
                head = handle.read(16)
        except OSError:
            continue
        if head != b"SQLite format 3\\x00":
            continue
        db = sqlite3.connect("file:" + path + "?mode=rw", uri=True, isolation_level=None)
        try:
            if name == "Cookies":
                db.create_function("exclusive", 1, lambda host: 1 if sites.search((host or "").lstrip(".").lower()) else 0, deterministic=True)
                db.execute("PRAGMA secure_delete=ON")
                removed += db.execute("DELETE FROM cookies WHERE exclusive(host_key)").rowcount
                db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            ok = db.execute("PRAGMA quick_check").fetchone()[0]
        except sqlite3.DatabaseError:
            ok = "damaged"
        finally:
            db.close()
        if ok != "ok":
            sys.exit(30)
print(removed)`;

const BULK_MS = 10 * 60_000;
// The longest the main browser stays paused; a copy that takes longer is given up.
export const PAUSE_MS = 15_000;
const SCRUB_MS = 2 * 60_000;

export class SlotCopyError extends BrowserLifecycleError {}
// The main browser stayed paused after the copy: it must be restarted.
export class SlotPauseStuck extends SlotCopyError {}

export interface ProfileSlotDeps {
  docker: Docker;
  // The browser image: its user owns the profile, and it has tar and Python.
  image(): string;
  report?(message: string): void;
}

// Fills a conversation's slot from the main one. Every step runs in a container of its own with no
// network or capabilities, the main slot mounted read-only: nothing writes to the main profile, its
// lock included.
export class ProfileSlots {
  constructor(private readonly deps: ProfileSlotDeps) {}

  // `running` is the container of the browser that has the main slot open now, if one does: it is
  // paused while the profile's state is copied.
  async fill(
    slot: string,
    main: string,
    labels: Record<string, string>,
    running?: string,
  ): Promise<{ cookiesLeftOut: number }> {
    const base = { ...labels, "localdot.role": "profile-copy" };
    const bulk = await this.#run(`${slot}-copy`, base, ["/bin/bash", "-c", COPY_BULK], main, slot);
    if (bulk.code === 28)
      throw new SlotCopyError("Docker doesn't have enough free disk space for another browser");
    if (bulk.code !== 0) throw new SlotCopyError("The sign-ins couldn't be copied");
    const state = await this.#create(
      `${slot}-state`,
      base,
      ["/bin/bash", "-c", COPY_STATE],
      main,
      slot,
    );
    try {
      const code = await this.#paused(running, () => this.#start(state, PAUSE_MS));
      if (code !== 0) throw new SlotCopyError("The sign-ins couldn't be copied");
    } finally {
      await this.#remove(state);
    }
    const scrub = await this.#run(
      `${slot}-check`,
      base,
      ["/usr/bin/python3", "-I", "-c", SCRUB],
      undefined,
      slot,
      true,
    );
    if (scrub.code === 30) throw new SlotCopyError("A copied database was damaged");
    if (scrub.code !== 0) throw new SlotCopyError("The copied sign-ins couldn't be checked");
    const count = Number(scrub.output.at(-1));
    return { cookiesLeftOut: Number.isSafeInteger(count) ? count : 0 };
  }

  // A pause that can't be undone leaves the main browser frozen: it is tried again, and the caller
  // hears so it can restart that browser.
  async #paused<T>(container: string | undefined, work: () => Promise<T>): Promise<T> {
    if (!container) return work();
    await this.deps.docker.request({ method: "POST", path: `/containers/${container}/pause` });
    const outcome = await work().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    if (!(await this.#resume(container))) {
      this.deps.report?.("the main web browser couldn't be resumed after a profile copy");
      throw new SlotPauseStuck("The main web browser couldn't be resumed");
    }
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }

  async #resume(container: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.deps.docker.request({
          method: "POST",
          path: `/containers/${container}/unpause`,
        });
        return true;
      } catch (error) {
        if (error instanceof DockerError && (error.status === 404 || error.status === 409))
          return true;
      }
    }
    return false;
  }

  async #run(
    name: string,
    labels: Record<string, string>,
    command: readonly string[],
    read: string | undefined,
    write: string,
    output = false,
  ): Promise<{ code: number; output: readonly string[] }> {
    const id = await this.#create(name, labels, command, read, write);
    try {
      const code = await this.#start(id, output ? SCRUB_MS : BULK_MS);
      if (!output) return { code, output: [] };
      const logs = await this.deps.docker.request<Buffer>({
        method: "GET",
        path: `/containers/${id}/logs`,
        query: { stdout: "true", stderr: "false", tail: "1" },
        response: "buffer",
      });
      return { code, output: Buffer.isBuffer(logs) ? dockerLogLines(logs) : [] };
    } finally {
      await this.#remove(id);
    }
  }

  async #create(
    name: string,
    labels: Record<string, string>,
    [entrypoint, ...command]: readonly string[],
    read: string | undefined,
    write: string,
  ): Promise<string> {
    await this.#removeStale(name, labels);
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
            ...(read ? [{ Type: "volume", Source: read, Target: "/legacy", ReadOnly: true }] : []),
            { Type: "volume", Source: write, Target: "/profile" },
          ],
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
        },
      },
    });
    const id = created?.Id;
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/u.test(id)) throw new SlotCopyError();
    return id;
  }

  async #start(id: string, timeoutMs: number): Promise<number> {
    await this.deps.docker.request({ method: "POST", path: `/containers/${id}/start` });
    const result = await this.deps.docker.request<unknown>({
      method: "POST",
      path: `/containers/${id}/wait`,
      timeoutMs,
    });
    if (!raw(result) || typeof result.StatusCode !== "number") throw new SlotCopyError();
    return result.StatusCode;
  }

  // A helper an earlier copy left behind, which must be this copy's own.
  async #removeStale(name: string, labels: Record<string, string>): Promise<void> {
    let found: unknown;
    try {
      found = await this.deps.docker.request<unknown>({
        method: "GET",
        path: `/containers/${encodeURIComponent(name)}/json`,
      });
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return;
      throw error;
    }
    const config = raw(found) && raw(found.Config) ? found.Config : undefined;
    const held = config && raw(config.Labels) ? config.Labels : undefined;
    if (!held || Object.entries(labels).some(([key, value]) => held[key] !== value))
      throw new SlotCopyError("A browser profile copy's helper isn't localDot's");
    await this.#remove(name);
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
