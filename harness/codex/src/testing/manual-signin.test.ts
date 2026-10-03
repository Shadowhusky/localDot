import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  privateAuthRefresh,
  requireManualSignIn,
  userCredentialMetadata,
} from "./manual-signin.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});
function root() {
  const directory = mkdtempSync("/tmp/ld-manual-unit-");
  roots.push(directory);
  return directory;
}
it("requires both manual flags, the supported platform and a cached archive", () => {
  const enabled = {
    LOCALDOT_CODEX_TESTS: "1",
    LOCALDOT_CODEX_SIGNIN: "1",
    LOCALDOT_CODEX_ARCHIVE: "/tmp/inert-cached-archive.tgz",
  };
  expect(() => requireManualSignIn(enabled, "darwin", "arm64")).not.toThrow();
  for (const env of [
    {},
    { ...enabled, LOCALDOT_CODEX_TESTS: "0" },
    { ...enabled, LOCALDOT_CODEX_SIGNIN: "0" },
    { ...enabled, LOCALDOT_CODEX_ARCHIVE: "" },
  ])
    expect(() => requireManualSignIn(env, "darwin", "arm64")).toThrow();
  expect(() => requireManualSignIn(enabled, "linux", "arm64")).toThrow();
  expect(() => requireManualSignIn(enabled, "darwin", "x64")).toThrow();
});
it("observes user credential metadata without following or reading its content", () => {
  const directory = root();
  mkdirSync(join(directory, ".codex"), { mode: 0o700 });
  const outside = join(directory, "inert-outside");
  writeFileSync(outside, "inert unread credential target", { mode: 0o000 });
  symlinkSync(outside, join(directory, ".codex/auth.json"));
  const before = userCredentialMetadata(directory);
  expect(userCredentialMetadata(directory)).toEqual(before);
  writeFileSync(join(directory, ".codex/config.toml"), "changed inert setting");
  expect(userCredentialMetadata(directory)).not.toEqual(before);
});
it("returns only a refresh timestamp from a private owned ChatGPT file", () => {
  const directory = root();
  writeFileSync(
    join(directory, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { refresh_token: "inert-only" },
      last_refresh: "2026-10-03T00:00:00Z",
    }),
    { mode: 0o600 },
  );
  expect(privateAuthRefresh(directory)).toBe(Date.parse("2026-10-03T00:00:00Z"));
  chmodSync(join(directory, "auth.json"), 0o644);
  expect(() => privateAuthRefresh(directory)).toThrow("private and bounded");
});
it("rejects linked, oversized and non-ChatGPT auth without exposing values", () => {
  const directory = root(),
    target = join(directory, "target");
  writeFileSync(target, "inert sentinel", { mode: 0o600 });
  symlinkSync(target, join(directory, "auth.json"));
  expect(() => privateAuthRefresh(directory)).toThrow();
  rmSync(join(directory, "auth.json"));
  for (const bytes of [
    "x".repeat(65_537),
    JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "inert-only" }),
  ]) {
    writeFileSync(join(directory, "auth.json"), bytes, { mode: 0o600 });
    expect(() => privateAuthRefresh(directory)).toThrow();
  }
});
