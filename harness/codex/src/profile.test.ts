import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { loadConfigFromString } from "@anthropic-ai/sandbox-runtime/dist/utils/config-loader.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_HOME_DENY_WRITE,
  CODEX_HOSTS,
  type SandboxInput,
  sandboxSettings,
  writeSettingsFile,
} from "./profile.ts";
import {
  codexInstallDirectory,
  createOwnedCodexDirectory,
  prepareOwnedCodexRoots,
  removeOwnedCodexDirectory,
} from "./roots.ts";
import { codexRelease, releaseInstallKey } from "./version.ts";

const owned: string[] = [];
function fixture() {
  const top = realpathSync(mkdtempSync("/tmp/localdot-codex-profile-"));
  owned.push(top);
  const realHome = join(top, "user");
  mkdirSync(realHome, { mode: 0o700 });
  const roots = prepareOwnedCodexRoots(join(realHome, ".localdot"), realHome);
  const release = codexRelease("darwin", "arm64");
  if (!release) throw new Error("missing test pin");
  const binDir = codexInstallDirectory(roots, releaseInstallKey(release));
  mkdirSync(binDir, { mode: 0o700 });
  for (const name of ["codex", "codex-code-mode-host"])
    writeFileSync(join(binDir, name), "profile fixture only", { mode: 0o555 });
  const work = createOwnedCodexDirectory(roots, "workRoot");
  const mcp = createOwnedCodexDirectory(roots, "runRoot");
  const input: SandboxInput = {
    purpose: "task",
    roots,
    installed: {
      version: "0.154.0",
      platform: "darwin-arm64",
      binDir,
      codexBin: join(binDir, "codex"),
      codeModeHostBin: join(binDir, "codex-code-mode-host"),
    },
    work,
    mcp,
    platform: "darwin",
  };
  return { top, realHome, roots, input, binDir, work, mcp };
}
afterEach(() => {
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("strict owned Codex profiles", () => {
  it("denies the user/data/shared-temp roots and allows only exact private folders", () => {
    const f = fixture(),
      s = sandboxSettings(f.input);
    expect(s.filesystem.denyRead).toEqual(
      expect.arrayContaining([
        f.realHome,
        dirname(f.roots.root),
        "/Volumes",
        "/Network",
        "/tmp/claude",
        "/private/tmp/claude",
      ]),
    );
    const aliases = (path: string) => [
      path,
      ...(existsSync(`/System/Volumes/Data${path}`) ? [`/System/Volumes/Data${path}`] : []),
    ];
    expect(s.filesystem.allowRead).toEqual(
      [f.roots.home, f.binDir, f.work.path, f.mcp.path].flatMap(aliases),
    );
    expect(s.filesystem.allowWrite).toEqual([f.roots.home, f.work.path].flatMap(aliases));
    for (const name of CODEX_HOME_DENY_WRITE)
      expect(s.filesystem.denyWrite).toContain(join(f.roots.home, name));
    for (const path of ["/tmp/claude", "/private/tmp/claude"])
      expect(s.filesystem.denyWrite).toContain(path);
    expect(s.filesystem.denyWrite).not.toContain(join(f.roots.home, "auth.json"));
    expect(s.filesystem.allowRead).not.toContain(f.roots.root);
    expect(s.filesystem.allowRead).not.toContain(dirname(f.roots.root));
    expect(s.filesystem.allowRead).not.toContain(f.roots.profilesRoot);
    expect(s.network).toEqual({
      allowedDomains: [...CODEX_HOSTS],
      deniedDomains: [],
      strictAllowlist: true,
      allowLocalBinding: false,
      allowUnixSockets: [join(f.mcp.path, "m.sock")],
    });
    expect([
      s.enableWeakerNetworkIsolation,
      s.enableWeakerNestedSandbox,
      s.allowPty,
      s.allowAppleEvents,
    ]).toEqual([false, false, false, false]);
  });
  it("keeps account/device login isolated and reserves1455 only for the browser profile", () => {
    const f = fixture();
    for (const purpose of ["account", "login-browser"] as const) {
      const s = sandboxSettings({ ...f.input, purpose, mcp: undefined });
      expect(s.network.allowUnixSockets).toBeUndefined();
      expect(s.network.allowLocalBinding).toBe(false);
      expect(s.network.loopbackBindPorts).toEqual(purpose === "login-browser" ? [1455] : undefined);
    }
    expect(() => sandboxSettings({ ...f.input, purpose: "account" })).toThrow();
    expect(() => sandboxSettings({ ...f.input, mcp: undefined })).toThrow();
    expect(() =>
      sandboxSettings({ ...f.input, purpose: "login-browser", mcp: undefined, platform: "linux" }),
    ).toThrow();
  });
  it.each(["task", "account", "login-browser"] as const)(
    "round-trips every %s key through the patched pinned runtime loader",
    (purpose) => {
      const f = fixture(),
        s = sandboxSettings({ ...f.input, purpose, mcp: purpose === "task" ? f.mcp : undefined });
      expect(loadConfigFromString(JSON.stringify(s))).toEqual(s);
    },
  );
  it("supports extra literal data mounts and refuses patterns and relative aliases", () => {
    const f = fixture();
    expect(
      sandboxSettings({ ...f.input, platform: "linux", extraDenyRead: ["/mnt/data"] }).filesystem
        .denyRead,
    ).toContain("/mnt/data");
    for (const path of [
      "data",
      "/mnt/*",
      "/mnt/../data",
      "/mnt/data/",
      "/mnt/line\nfeed",
      "/mnt/nul\0",
      "/mnt/back\\slash",
    ])
      expect(() => sandboxSettings({ ...f.input, extraDenyRead: [path] })).toThrow();
  });
  it.each(["roots", "work", "mcp", "other-work", "bin", "binary", "platform"])(
    "refuses the unverified %s input",
    (which) => {
      const f = fixture();
      const input = { ...f.input };
      if (which === "roots") input.roots = { ...f.roots };
      if (which === "work") input.work = { ...f.work };
      if (which === "mcp") input.mcp = { ...f.mcp };
      if (which === "other-work") input.work = f.mcp;
      if (which === "bin") input.installed = { ...input.installed, binDir: f.realHome };
      if (which === "binary")
        input.installed = { ...input.installed, codexBin: join(f.realHome, ".codex/codex") };
      if (which === "platform") input.platform = "win32";
      expect(() => sandboxSettings(input)).toThrow();
    },
  );
  it("revalidates a swapped managed folder and linked binary", () => {
    const f = fixture();
    rmSync(join(f.binDir, "codex"));
    symlinkSync(join(f.realHome, "foreign"), join(f.binDir, "codex"));
    expect(() => sandboxSettings(f.input)).toThrow();
  });
  it("denies a resolved user Codex alias outside the real home without reading its files", () => {
    const f = fixture();
    const target = join(f.top, "relocated-codex");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(f.realHome, ".codex"));
    const settings = sandboxSettings(f.input);
    expect(settings.filesystem.denyRead).toContain(target);
    expect(settings.filesystem.denyRead).toContain(join(f.realHome, ".codex"));
  });
  it("denies absent user Codex and every protected descendant under all granted home spellings", () => {
    const f = fixture();
    const settings = sandboxSettings(f.input);
    expect(settings.filesystem.denyRead).toContain(join(f.realHome, ".codex"));
    for (const spelling of settings.filesystem.allowWrite.filter((p) => p.endsWith("/home"))) {
      expect(lstatSync(spelling).ino).toBe(lstatSync(f.roots.home).ino);
      for (const name of CODEX_HOME_DENY_WRITE) {
        expect(existsSync(join(f.roots.home, name))).toBe(false);
        expect(settings.filesystem.denyWrite).toContain(join(spelling, name));
      }
    }
  });
  it.runIf(process.platform === "darwin")(
    "denies the natural spelling of a user Codex target returned in Data-volume orientation",
    () => {
      const f = fixture(),
        target = join(f.top, "relocated-user-codex");
      mkdirSync(target, { mode: 0o700 });
      const alias = `/System/Volumes/Data${target}`;
      expect([lstatSync(alias).dev, lstatSync(alias).ino]).toEqual([
        lstatSync(target).dev,
        lstatSync(target).ino,
      ]);
      symlinkSync(alias, join(f.realHome, ".codex"));
      const settings = sandboxSettings(f.input);
      expect(settings.filesystem.denyRead).toContain(target);
      expect(settings.filesystem.denyRead).toContain(alias);
    },
  );
  it("refuses a newly dangling user Codex alias before publishing a profile", () => {
    const f = fixture();
    symlinkSync(join(f.top, "absent-user-codex"), join(f.realHome, ".codex"));
    expect(() => sandboxSettings(f.input)).toThrow();
  });
  it("writes an exclusive private profile outside sandbox read/write grants", async () => {
    const f = fixture(),
      settings = sandboxSettings(f.input);
    const profile = await writeSettingsFile(f.roots, settings);
    expect(statSync(profile.path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(profile.path)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(profile.path, "utf8"))).toEqual(settings);
    expect(settings.filesystem.allowRead).not.toContain(dirname(profile.path));
    expect(settings.filesystem.allowWrite).not.toContain(dirname(profile.path));
    await removeOwnedCodexDirectory(profile.directory);
    await expect(writeSettingsFile(f.roots, structuredClone(settings))).rejects.toThrow();
    expect(Object.isFrozen(settings.network)).toBe(true);
    expect(Object.isFrozen(settings.network.allowedDomains)).toBe(true);
  });
});
