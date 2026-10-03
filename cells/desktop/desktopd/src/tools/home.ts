import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}

function inside(home: string, path: string): boolean {
  const rel = relative(home, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// Resolve components in order: normalizing first would hide an escaping symlink in link/../x.
// Missing descendants are allowed for new files, but a dangling link is never a new directory.
// This checks the current filesystem; callers must not treat a returned path as an open handle.
export function resolveInHome(home: string, raw: string): string {
  if (raw.includes("\0")) throw new PathError("the path contains a NUL byte");
  try {
    const realHome = realpathSync(home);
    if (!statSync(realHome).isDirectory()) throw new PathError("the home is not a directory");
    let tail = raw === "~" ? "" : raw.startsWith("~/") ? raw.slice(2) : raw;
    if (isAbsolute(tail)) {
      // Accept both the configured home spelling and its canonical path (e.g. /tmp on macOS).
      const prefix = [resolve(home), realHome].find(
        (base) => tail === base || tail.startsWith(base.endsWith(sep) ? base : `${base}${sep}`),
      );
      if (prefix === undefined) throw new PathError(`${raw} is outside the home folder`);
      tail = tail.slice(prefix.length);
    }

    let current = realHome;
    const parts = tail.split(sep).filter((part) => part !== "" && part !== ".");
    for (const [index, part] of parts.entries()) {
      if (part === "..") {
        current = dirname(current);
      } else {
        const candidate = join(current, part);
        const stat = lstatSync(candidate, { throwIfNoEntry: false });
        current = stat ? realpathSync(candidate) : candidate;
        if (stat && index < parts.length - 1 && !statSync(current).isDirectory()) {
          throw new PathError(`${raw} has a non-directory ancestor`);
        }
      }
      if (!inside(realHome, current)) throw new PathError(`${raw} is outside the home folder`);
    }
    return current;
  } catch (error) {
    if (error instanceof PathError) throw error;
    throw new PathError(`the path cannot be resolved inside the home folder: ${raw}`);
  }
}
