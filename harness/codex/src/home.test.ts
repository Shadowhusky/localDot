import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODEX_CONFIG_TOML, prepareCodexHome } from "./home.ts";
import { prepareOwnedCodexRoots } from "./roots.ts";

const owned: string[] = [];
function fixture() {
  const top = realpathSync(mkdtempSync("/tmp/localdot-codex-private-home-"));
  owned.push(top);
  const realHome = join(top, "user");
  mkdirSync(realHome, { mode: 0o700 });
  const roots = prepareOwnedCodexRoots(join(top, "app"), realHome);
  const config = join(roots.home, "config.toml"),
    auth = join(roots.home, "auth.json");
  writeFileSync(config, 'notify = ["/tmp/evil"]\n', { mode: 0o600 });
  return { top, realHome, roots, config, auth };
}
afterEach(() => {
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("private Codex home preparation", () => {
  it("preserves an exact private login while atomically replacing config and removing instructions/extensions", () => {
    const f = fixture();
    writeFileSync(f.auth, '{"auth_mode":"chatgpt","fake":"never-real"}', { mode: 0o600 });
    const before = statSync(f.auth);
    for (const name of [
      "AGENTS.md",
      "AGENTS.override.md",
      "hooks.json",
      "managed_config.toml",
      "requirements.toml",
    ])
      writeFileSync(join(f.roots.home, name), "fixture", { mode: 0o600 });
    for (const name of ["skills", "rules", "prompts", "plugins", ".agents"]) {
      mkdirSync(join(f.roots.home, name), { mode: 0o700 });
      writeFileSync(join(f.roots.home, name, "child"), "fixture", { mode: 0o600 });
    }
    prepareCodexHome(f.roots);
    expect(readFileSync(f.config, "utf8")).toBe(CODEX_CONFIG_TOML);
    expect(statSync(f.config).mode & 0o777).toBe(0o600);
    expect(readFileSync(f.auth, "utf8")).toContain("never-real");
    expect(statSync(f.auth).ino).toBe(before.ino);
    expect(statSync(f.auth).mtimeMs).toBe(before.mtimeMs);
    expect(readdirSync(f.roots.home).sort()).toEqual(["auth.json", "config.toml"]);
    prepareCodexHome(f.roots);
    expect(readFileSync(f.config, "utf8")).toBe(CODEX_CONFIG_TOML);
  });
  it.each(["mode", "link", "hardlink", "directory"])(
    "refuses an invalid auth %s before any mutation",
    (which) => {
      const f = fixture(),
        foreign = join(f.top, "outside-auth");
      writeFileSync(foreign, "outside", { mode: 0o600 });
      if (which === "mode") writeFileSync(f.auth, "fake", { mode: 0o644 });
      if (which === "link") symlinkSync(foreign, f.auth);
      if (which === "hardlink") linkSync(foreign, f.auth);
      if (which === "directory") mkdirSync(f.auth, { mode: 0o700 });
      const instruction = join(f.roots.home, "AGENTS.md");
      writeFileSync(instruction, "retain", { mode: 0o600 });
      expect(() => prepareCodexHome(f.roots)).toThrow();
      expect(readFileSync(f.config, "utf8")).toContain("evil");
      expect(readFileSync(instruction, "utf8")).toBe("retain");
      expect(readFileSync(foreign, "utf8")).toBe("outside");
    },
  );
  it.each(["config-link", "config-dir", "instruction-link", "nested-link", "nested-mode"])(
    "preflights every managed entry before changing anything: %s",
    (which) => {
      const f = fixture(),
        foreign = join(f.top, "outside");
      mkdirSync(foreign, { mode: 0o700 });
      writeFileSync(join(foreign, "sentinel"), "outside", { mode: 0o600 });
      const retained = join(f.roots.home, "AGENTS.md");
      writeFileSync(retained, "retain", { mode: 0o600 });
      if (which === "config-link" || which === "config-dir") {
        rmSync(f.config);
        if (which === "config-link") symlinkSync(join(foreign, "sentinel"), f.config);
        else mkdirSync(f.config, { mode: 0o700 });
      }
      if (which === "instruction-link") symlinkSync(foreign, join(f.roots.home, "skills"));
      if (which.startsWith("nested")) {
        mkdirSync(join(f.roots.home, "skills"), { mode: 0o700 });
        if (which === "nested-link") symlinkSync(foreign, join(f.roots.home, "skills/child"));
        else chmodSync(join(f.roots.home, "skills"), 0o777);
      }
      expect(() => prepareCodexHome(f.roots)).toThrow();
      expect(readFileSync(retained, "utf8")).toBe("retain");
      expect(readFileSync(join(foreign, "sentinel"), "utf8")).toBe("outside");
    },
  );
  it("never follows or reuses a fixed config.toml.tmp link", () => {
    const f = fixture(),
      outside = join(f.top, "outside");
    writeFileSync(outside, "outside", { mode: 0o600 });
    symlinkSync(outside, `${f.config}.tmp`);
    prepareCodexHome(f.roots);
    expect(readFileSync(outside, "utf8")).toBe("outside");
    expect(readFileSync(f.config, "utf8")).toBe(CODEX_CONFIG_TOML);
    expect(
      readdirSync(f.roots.home).filter((name) => name.startsWith(".localdot-config-")),
    ).toEqual([]);
  });
  it("refuses forged roots and a swapped home without touching the outside target", () => {
    const f = fixture(),
      outside = join(f.top, "outside");
    mkdirSync(outside, { mode: 0o700 });
    writeFileSync(join(outside, "config.toml"), "outside", { mode: 0o600 });
    expect(() => prepareCodexHome({ ...f.roots, home: outside })).toThrow();
    rmSync(f.roots.home, { recursive: true });
    symlinkSync(outside, f.roots.home);
    expect(() => prepareCodexHome(f.roots)).toThrow();
    expect(readFileSync(join(outside, "config.toml"), "utf8")).toBe("outside");
  });
  it("supports a missing auth file without fabricating a login", () => {
    const f = fixture();
    prepareCodexHome(f.roots);
    expect(existsSync(f.auth)).toBe(false);
    expect(readFileSync(f.config, "utf8")).toBe(CODEX_CONFIG_TOML);
  });
});
