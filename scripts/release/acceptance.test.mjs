import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  ACCEPTANCE_CHECKS,
  DistributionManifest,
} from "../../packages/protocol/src/distribution.ts";
import { verifyAcceptance } from "./acceptance.mjs";

function fixture() {
  const version = "0.1.0-rc.1",
    commit = "a".repeat(40);
  const bundle = (platform) => ({
    app: {
      file: `localdot-app-${version}-${platform}.tgz`,
      sha256: "a".repeat(64),
      downloadBytes: 10,
      installedBytes: 20,
    },
    helper: {
      file: `localdot-helper-${version}-${platform}.tgz`,
      sha256: "b".repeat(64),
      downloadBytes: 10,
      installedBytes: 20,
    },
    nodeVersion: "24.21.0",
    installPeakBytes: 100,
    dockerPeakBytes: 200,
  });
  const images = Object.fromEntries(
    ["desktop", "gate", "brain", "browser"].map((role) => [
      role,
      {
        repository: `ghcr.io/shadowhusky/localdot-${role}`,
        digest: `sha256:${"c".repeat(64)}`,
        platforms: ["linux/arm64", "linux/amd64"],
      },
    ]),
  );
  const manifest = {
    v: 2,
    version,
    commit,
    bundles: { "darwin-arm64": bundle("darwin-arm64"), "linux-x64": bundle("linux-x64") },
    images,
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const records = [
    ["darwin-arm64", "macos"],
    ["linux-x64", "linux"],
    ["linux-x64", "windows-wsl2"],
  ].map(([platform, host]) => ({
    v: 1,
    version,
    commit,
    manifestSha256: createHash("sha256").update(bytes).digest("hex"),
    platform,
    host,
    osVersion: "fixture",
    engineVersion: "29.2.0",
    hardware: "fixture",
    testedAt: "2026-10-10T00:00:00Z",
    checks: Object.fromEntries(ACCEPTANCE_CHECKS.map((check) => [check, true])),
    rebootContinuation: true,
    evidenceSha256: "d".repeat(64),
    images: Object.fromEntries(Object.entries(images).map(([role, pin]) => [role, pin.digest])),
  }));
  return { manifest, bytes, records };
}
it("requires every advertised platform including Windows independently of native Linux", () => {
  const f = fixture();
  expect(verifyAcceptance(f.bytes, f.records).tested).toHaveLength(3);
  expect(() => verifyAcceptance(f.bytes, f.records.slice(0, 2))).toThrow("windows-wsl2");
});
it.each(["hash", "commit", "image", "failed-check", "reboot", "duplicate"])(
  "refuses %s evidence",
  (failure) => {
    const f = fixture(),
      r = f.records[2];
    if (failure === "hash") r.manifestSha256 = "e".repeat(64);
    if (failure === "commit") r.commit = "e".repeat(40);
    if (failure === "image") r.images.desktop = `sha256:${"e".repeat(64)}`;
    if (failure === "failed-check") r.checks.stream = false;
    if (failure === "reboot") r.rebootContinuation = false;
    if (failure === "duplicate") f.records.push(r);
    expect(() => verifyAcceptance(f.bytes, f.records)).toThrow();
  },
);
it("rejects package-name substitution, incomplete image platforms and fictional disk requirements", () => {
  const f = fixture();
  f.manifest.bundles["linux-x64"].app.file = "localdot-app-other.tgz";
  expect(DistributionManifest.safeParse(f.manifest).success).toBe(false);
  const g = fixture();
  g.manifest.images.gate.platforms = ["linux/arm64"];
  expect(DistributionManifest.safeParse(g.manifest).success).toBe(false);
  const h = fixture();
  h.manifest.bundles["linux-x64"].installPeakBytes = 1;
  expect(DistributionManifest.safeParse(h.manifest).success).toBe(false);
});
