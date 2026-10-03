import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CA_BUNDLE, codexEnv } from "./env.ts";
import { createOwnedCodexDirectory, prepareOwnedCodexRoots } from "./roots.ts";

const owned: string[] = [];
function fixture() {
  const top = realpathSync(mkdtempSync("/tmp/ld-codex-env-"));
  owned.push(top);
  const user = join(top, "user");
  mkdirSync(user, { mode: 0o700 });
  const roots = prepareOwnedCodexRoots(join(user, ".localdot"), user);
  return { top, user, roots, work: createOwnedCodexDirectory(roots, "workRoot") };
}
afterEach(() => {
  for (const p of owned.splice(0)) rmSync(p, { recursive: true, force: true });
});
describe("scrubbed owned Codex environment", () => {
  it("builds exactly eleven variables independently of daemon secrets and launch hooks", () => {
    const f = fixture(),
      original = { ...process.env };
    const sentinel = {
      OPENAI_API_KEY: "FAKE-OPENAI-ENV",
      ANTHROPIC_API_KEY: "FAKE-ANTHROPIC-ENV",
      CODEX_API_KEY: "FAKE-CODEX-ENV",
      LOCALDOT_KEYD_TOKEN: "FAKE-KEYD-ENV",
      HTTPS_PROXY: "FAKE-PROXY-ENV",
      NODE_OPTIONS: "FAKE-NODE-ENV",
      DYLD_INSERT_LIBRARIES: "FAKE-DYLD-ENV",
      SSH_AUTH_SOCK: "FAKE-SSH-ENV",
      USER: "FAKE-USER-ENV",
      HOME: "FAKE-HOME-ENV",
    };
    Object.assign(process.env, sentinel);
    try {
      const env = codexEnv(f);
      expect(env).toEqual({
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: f.user,
        USER: userInfo().username,
        LOGNAME: userInfo().username,
        LANG: "en_US.UTF-8",
        TMPDIR: join(f.work.path, "tmp"),
        CLAUDE_CODE_TMPDIR: join(f.work.path, "tmp"),
        CODEX_HOME: f.roots.home,
        CODEX_CA_CERTIFICATE: CA_BUNDLE,
        RUST_LOG: "warn",
        NO_COLOR: "1",
      });
      for (const value of Object.values(sentinel)) expect(JSON.stringify(env)).not.toContain(value);
      expect(statSync(env.TMPDIR as string).mode & 0o777).toBe(0o700);
      expect(Object.isFrozen(env)).toBe(true);
      expect(codexEnv(f)).toEqual(env);
    } finally {
      process.env = original;
    }
  });
  it.each(["roots-clone", "work-clone", "other-work", "link", "file", "mode"])(
    "refuses %s before creating or changing a temporary path",
    (which) => {
      const f = fixture(),
        tmp = join(f.work.path, "tmp"),
        input = { roots: f.roots, work: f.work };
      if (which === "roots-clone") input.roots = { ...f.roots };
      if (which === "work-clone") input.work = { ...f.work };
      if (which === "other-work") input.work = createOwnedCodexDirectory(f.roots, "runRoot");
      if (which === "link") symlinkSync(f.user, tmp);
      if (which === "file") writeFileSync(tmp, "inert-marker", { mode: 0o600 });
      if (which === "mode") {
        mkdirSync(tmp, { mode: 0o700 });
        chmodSync(tmp, 0o777);
      }
      expect(() => codexEnv(input)).toThrow(
        "The localDot Codex environment could not be verified.",
      );
      if (["roots-clone", "work-clone", "other-work"].includes(which))
        expect(existsSync(tmp)).toBe(false);
    },
  );
  it("rechecks the work receipt after its directory was replaced", () => {
    const f = fixture();
    rmSync(f.work.path, { recursive: true });
    mkdirSync(f.work.path, { mode: 0o700 });
    expect(() => codexEnv(f)).toThrow();
    expect(existsSync(join(f.work.path, "tmp"))).toBe(false);
  });
});
