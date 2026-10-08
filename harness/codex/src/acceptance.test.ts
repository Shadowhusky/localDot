import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_MANIFEST_SHA256, canonicalDigest, codexAccepted } from "./acceptance.ts";
import { CODEX_RELEASE_BUNDLE, CODEX_VERSION } from "./version.ts";

const complete = () => ({
  format: 1,
  codexVersion: CODEX_VERSION,
  platform: "darwin-arm64",
  manifestSha256: CODEX_MANIFEST_SHA256,
  nativeSandbox: { passed: true, inputSha256: "a".repeat(64), reportSha256: "b".repeat(64) },
  realAccount: { passed: true, reportSha256: "c".repeat(64) },
});
const accepted = (record: unknown) => codexAccepted(record, "darwin", "arm64");
afterEach(() => {
  vi.unstubAllEnvs();
});
describe("ChatGPT plan acceptance gate", () => {
  it("opens only for a complete record of this pin on this platform", () => {
    expect(accepted(complete())).toBe(true);
    expect(codexAccepted(complete(), "linux", "x64")).toBe(false);
    expect(codexAccepted(complete(), "darwin", "x64")).toBe(false);
  });
  it("binds the record to the canonical digest of the bundled release manifest", () => {
    expect(CODEX_MANIFEST_SHA256).toBe(canonicalDigest(CODEX_RELEASE_BUNDLE));
    expect(CODEX_MANIFEST_SHA256).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([
    ["a missing record", undefined],
    ["an empty record", {}],
    ["a list", [complete()]],
    ["no native stamp", { ...complete(), nativeSandbox: undefined }],
    ["a failed native stamp", { ...complete(), nativeSandbox: { passed: false } }],
    ["a truthy but not true native stamp", { ...complete(), nativeSandbox: { passed: "true" } }],
    ["no real-account stamp", { ...complete(), realAccount: undefined }],
    ["a failed real-account stamp", { ...complete(), realAccount: { passed: false } }],
    ["a truthy but not true real-account stamp", { ...complete(), realAccount: { passed: 1 } }],
    ["another Codex version", { ...complete(), codexVersion: "0.155.0" }],
    ["another manifest", { ...complete(), manifestSha256: "0".repeat(64) }],
    ["another platform", { ...complete(), platform: "linux-x64" }],
    ["another record format", { ...complete(), format: 2 }],
  ])("stays pending with %s", (_name, record) => {
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
    expect(accepted({ ...complete(), realAccount: { passed: false } })).toBe(false);
    expect(accepted(undefined)).toBe(false);
  });
});
