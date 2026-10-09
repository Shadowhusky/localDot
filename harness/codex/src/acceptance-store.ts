import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { LocalAcceptance } from "./acceptance.ts";
import {
  assertOwnedCodexRoots,
  type OwnedCodexRoots,
  PRIVATE_CREATE_FLAGS,
  PRIVATE_READ_FLAGS,
} from "./roots.ts";

// Beside the Codex folders, where no sandboxed Codex process can read or write.
const NAME = "acceptance.json";

// Anything but a private, well-formed record reads as no record: no stamp is assumed.
export function readLocalAcceptance(roots: OwnedCodexRoots): LocalAcceptance | undefined {
  let fd: number | undefined;
  try {
    assertOwnedCodexRoots(roots);
    fd = openSync(join(roots.root, NAME), PRIVATE_READ_FLAGS);
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600 ||
      info.nlink !== 1 ||
      info.size > 4096
    )
      return undefined;
    const parsed = LocalAcceptance.safeParse(JSON.parse(readFileSync(fd, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export async function writeLocalAcceptance(
  roots: OwnedCodexRoots,
  record: LocalAcceptance,
): Promise<void> {
  const value = LocalAcceptance.parse(record);
  assertOwnedCodexRoots(roots);
  const temporary = join(roots.root, `.acceptance-${randomBytes(16).toString("hex")}.tmp`);
  const file = await open(temporary, PRIVATE_CREATE_FLAGS, 0o600);
  try {
    try {
      await file.writeFile(`${JSON.stringify(value)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    assertOwnedCodexRoots(roots);
    await rename(temporary, join(roots.root, NAME));
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  const directory = await open(
    roots.root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
