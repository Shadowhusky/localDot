import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
  assertOwnedCodexDirectory,
  type OwnedCodexDirectory,
  type OwnedCodexRoots,
  ownedCodexRealHome,
} from "./roots.ts";

// The narrow Mac profile blocks trustd; Codex must use the fixed system PEM bundle.
export const CA_BUNDLE = "/etc/ssl/cert.pem";
export interface CodexEnvInput {
  readonly roots: OwnedCodexRoots;
  readonly work: OwnedCodexDirectory;
  readonly signal?: AbortSignal;
}
export class CodexEnvError extends Error {
  constructor() {
    super("The localDot Codex environment could not be verified.");
    this.name = "CodexEnvError";
  }
}
export function codexEnv(input: CodexEnvInput): Readonly<Record<string, string>> {
  try {
    if (input.signal?.aborted) throw new CodexEnvError();
    assertOwnedCodexDirectory(input.roots, input.work, "workRoot");
    const home = ownedCodexRealHome(input.roots),
      tmp = join(input.work.path, "tmp");
    try {
      lstatSync(tmp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (input.signal?.aborted) throw new CodexEnvError();
      mkdirSync(tmp, { mode: 0o700 });
    }
    assertOwnedCodexDirectory(input.roots, input.work, "workRoot");
    const info = lstatSync(tmp);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o700 ||
      realpathSync(tmp) !== tmp ||
      input.signal?.aborted
    )
      throw new CodexEnvError();
    const user = userInfo().username;
    if (!user || /[\0\r\n]/.test(user)) throw new CodexEnvError();
    // Construct from nothing. Neither daemon credentials nor runtime/proxy injection enter it.
    return Object.freeze({
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: home,
      USER: user,
      LOGNAME: user,
      LANG: "en_US.UTF-8",
      TMPDIR: tmp,
      CLAUDE_CODE_TMPDIR: tmp,
      CODEX_HOME: input.roots.home,
      CODEX_CA_CERTIFICATE: CA_BUNDLE,
      RUST_LOG: "warn",
      NO_COLOR: "1",
    });
  } catch {
    throw new CodexEnvError();
  }
}
