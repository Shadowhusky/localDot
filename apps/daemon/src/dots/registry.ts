import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { z } from "zod";
import { DotId, MAIN_DOT_ID } from "../../../../packages/protocol/src/dots.ts";
import { PrivateJsonError, readPrivateJson, writePrivateJson } from "./private-json.ts";

const Home = z
  .string()
  .max(1024)
  .refine(
    (home) => isAbsolute(home) && normalize(home) === home && home !== "/",
    "an absolute home",
  );
const RegistryFile = z.strictObject({
  v: z.literal(1),
  dots: z
    .array(z.strictObject({ id: DotId, home: Home }))
    .min(1)
    .max(32),
});
export type RegistryEntry = z.infer<typeof RegistryFile>["dots"][number];

export class RegistryError extends Error {}

// Every dot of this user on this computer, by home; each home's instance.json says the rest.
// The first entry is the installation's own dot. Kept beside install-location.
export function registryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "localdot", "dots.json");
}

export class DotsRegistry {
  constructor(
    readonly path: string,
    // The home that is the first dot while no registry has been written.
    readonly mainHome: string,
  ) {}

  read(): RegistryEntry[] {
    let raw: unknown;
    try {
      raw = readPrivateJson(this.path);
    } catch (error) {
      if (error instanceof PrivateJsonError) throw new RegistryError(error.message);
      throw error;
    }
    if (raw === undefined) return [{ id: MAIN_DOT_ID, home: this.mainHome }];
    const parsed = RegistryFile.safeParse(raw);
    const dots = parsed.success ? parsed.data.dots : undefined;
    if (
      !dots ||
      dots[0]?.id !== MAIN_DOT_ID ||
      new Set(dots.map((dot) => dot.id)).size !== dots.length ||
      new Set(dots.map((dot) => dot.home)).size !== dots.length
    )
      throw new RegistryError(`${this.path} isn't a valid list of dots`);
    return dots;
  }

  // Read, change and write under a lock, so two commands never lose each other's dot.
  update(change: (dots: RegistryEntry[]) => RegistryEntry[]): RegistryEntry[] {
    const directory = join(this.path, "..");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const release = this.#lock();
    try {
      const next = change(this.read());
      writePrivateJson(this.path, RegistryFile.parse({ v: 1, dots: next }));
      return next;
    } finally {
      release();
    }
  }

  #lock(): () => void {
    const lock = `${this.path}.lock`;
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        const fd = openSync(lock, "wx", 0o600);
        writeSync(fd, String(process.pid));
        closeSync(fd);
        return () => rmSync(lock, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (staleLock(lock)) {
        rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline)
        throw new RegistryError("Another localdot command is changing the dots. Try again.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

// A lock whose process is gone, or that never got a process id in ten seconds, is stale.
function staleLock(lock: string): boolean {
  try {
    const stat = lstatSync(lock);
    if (!stat.isFile()) return false;
    const pid = Number(readFileSync(lock, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) return Date.now() - stat.mtimeMs > 10_000;
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
