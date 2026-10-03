import { describe, expect, it } from "vitest";
import { CodexInstallState } from "./subscription.ts";

describe("Codex installation status protocol", () => {
  it("keeps not installed, progress, verification, verified pin and safe failures distinct", () => {
    for (const state of [
      { state: "not_installed" },
      { state: "downloading", receivedBytes: 0 },
      { state: "downloading", receivedBytes: 9, totalBytes: 10 },
      { state: "verifying" },
      { state: "ready", version: "0.154.0" },
      { state: "failed", code: "integrity_failed" },
      { state: "failed", code: "cancelled" },
    ])
      expect(CodexInstallState.parse(state)).toEqual(state);
  });
  it("refuses an unverified version, impossible progress and unbounded/raw diagnostics", () => {
    for (const state of [
      { state: "ready" },
      { state: "ready", version: "latest" },
      { state: "downloading", receivedBytes: 11, totalBytes: 10 },
      { state: "downloading", receivedBytes: -1 },
      { state: "downloading", receivedBytes: 1.5 },
      { state: "downloading", receivedBytes: 257 * 1024 * 1024 },
      { state: "failed", code: "raw internal exception" },
      { state: "failed", code: "download_failed", error: "fixture-secret" },
    ])
      expect(() => CodexInstallState.parse(state)).toThrow();
  });
});
