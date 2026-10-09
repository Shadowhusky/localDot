import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accountStamped,
  CODEX_MANIFEST_SHA256,
  canonicalDigest,
  codexAccepted,
  codexReleased,
  nativeStamped,
  stampAccount,
  stampNative,
} from "./acceptance.ts";
import { CODEX_RELEASE_BUNDLE, CODEX_VERSION } from "./version.ts";

// A committed record that names another manifest must not move the digest the gate expects.
const m = vi.hoisted(() => ({
  record: {
    format: 1,
    codexVersion: "0.154.0",
    platform: "darwin-arm64",
    manifestSha256: "0".repeat(64),
    nativeSandbox: { passed: true },
    realAccount: { passed: false },
  },
}));
vi.mock("../acceptance/record.json", () => ({ default: m.record }));

const release = () => ({
  format: 1,
  codexVersion: CODEX_VERSION,
  platform: "darwin-arm64",
  manifestSha256: CODEX_MANIFEST_SHA256,
  nativeSandbox: { passed: true, inputSha256: "a".repeat(64), reportSha256: "b".repeat(64) },
  realAccount: { passed: false },
});
const host = { system: "25G83", runtime: "0.0.78" };
const released = (record: unknown) => codexReleased(record, "darwin", "arm64");
const native = () => stampNative(undefined, host, "c".repeat(64), 1, "darwin", "arm64");
const both = () => stampAccount(native(), host, 2, "darwin", "arm64");
const accepted = (record: unknown, at = host, evidence: unknown = release()) =>
  codexAccepted(record, at, evidence, "darwin", "arm64");
afterEach(() => {
  vi.unstubAllEnvs();
});
describe("ChatGPT plan release evidence", () => {
  it("opens only for a committed native stamp of this pin on this platform", () => {
    expect(released(release())).toBe(true);
    expect(codexReleased(release(), "linux", "x64")).toBe(false);
    expect(codexReleased(release(), "darwin", "x64")).toBe(false);
  });
  it("binds the record to the canonical digest of the bundled release manifest", () => {
    expect(CODEX_MANIFEST_SHA256).toBe(canonicalDigest(CODEX_RELEASE_BUNDLE));
    expect(CODEX_MANIFEST_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(codexReleased(undefined, "darwin", "arm64")).toBe(false);
    expect(released({ ...m.record, manifestSha256: CODEX_MANIFEST_SHA256 })).toBe(true);
  });
  it.each([
    ["a missing record", undefined],
    ["an empty record", {}],
    ["a list", [release()]],
    ["no native stamp", { ...release(), nativeSandbox: undefined }],
    ["a failed native stamp", { ...release(), nativeSandbox: { passed: false } }],
    ["a truthy but not true native stamp", { ...release(), nativeSandbox: { passed: "true" } }],
    ["another Codex version", { ...release(), codexVersion: "0.155.0" }],
    ["another manifest", { ...release(), manifestSha256: "0".repeat(64) }],
    ["another platform", { ...release(), platform: "linux-x64" }],
    ["another record format", { ...release(), format: 2 }],
  ])("stays closed with %s", (_name, record) => {
    expect(released(record)).toBe(false);
  });
});
describe("this Mac's own acceptance", () => {
  it("opens with the release evidence, this Mac's sandbox stamp and the account stamp", () => {
    expect(accepted(both())).toBe(true);
    expect(accepted(native())).toBe(false);
    expect(accepted(both(), host, { ...release(), nativeSandbox: { passed: false } })).toBe(false);
    expect(accepted(undefined)).toBe(false);
  });
  it("checks again after a macOS or sandbox runtime update, keeping the account stamp", () => {
    const updated = { system: "25H12", runtime: host.runtime };
    expect(nativeStamped(both(), updated, "darwin", "arm64")).toBe(false);
    expect(nativeStamped(both(), { ...host, runtime: "0.0.79" }, "darwin", "arm64")).toBe(false);
    expect(accepted(both(), updated)).toBe(false);
    const again = stampNative(both(), updated, "d".repeat(64), 3, "darwin", "arm64");
    expect(accountStamped(again, "darwin", "arm64")).toBe(true);
    expect(accepted(again, updated)).toBe(true);
  });
  it("starts both stamps again for another pin", () => {
    const old = { ...both(), codexVersion: "0.153.0" };
    expect(accountStamped(old, "darwin", "arm64")).toBe(false);
    expect(nativeStamped(old, host, "darwin", "arm64")).toBe(false);
    const fresh = stampNative(old, host, "c".repeat(64), 3, "darwin", "arm64");
    expect(fresh.codexVersion).toBe(CODEX_VERSION);
    expect(fresh.realAccount).toEqual({ passed: false });
    expect(accepted(fresh)).toBe(false);
  });
  it("never records a sign-in before this Mac's sandbox check", () => {
    expect(() => stampAccount(undefined, host, 1, "darwin", "arm64")).toThrow();
    expect(() =>
      stampAccount(native(), { ...host, system: "25H12" }, 1, "darwin", "arm64"),
    ).toThrow();
  });
  it.each([
    ["a list", [both()]],
    ["a truthy but not true stamp", { ...both(), realAccount: { passed: 1, checkedAt: 2 } }],
    ["an unknown field", { ...both(), extra: true }],
    ["another platform", { ...both(), platform: "linux-x64" }],
    [
      "a malformed report digest",
      { ...both(), nativeSandbox: { ...native().nativeSandbox, reportSha256: "x" } },
    ],
  ])("refuses %s", (_name, record) => {
    expect(accepted(record)).toBe(false);
  });
  it("is not opened by any environment flag", () => {
    for (const name of [
      "LOCALDOT_CODEX_TESTS",
      "LOCALDOT_CODEX_SIGNIN",
      "LOCALDOT_CODEX_ACCEPTED",
      "LOCALDOT_CHATGPT",
    ])
      vi.stubEnv(name, "1");
    vi.stubEnv("LOCALDOT_CODEX_ARCHIVE", "/tmp/codex.tgz");
    expect(accepted(native())).toBe(false);
    expect(accepted(undefined)).toBe(false);
  });
  it("never reads the environment", () => {
    const source = readFileSync(new URL("./acceptance.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\benv\b|getenv/i);
  });
});
