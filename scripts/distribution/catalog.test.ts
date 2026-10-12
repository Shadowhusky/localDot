import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authenticatedCatalog, validateCatalog } from "./catalog.ts";

const keys = generateKeyPairSync("ed25519");
const pub = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
function fixture() {
  const pins = Object.fromEntries(
    ["desktop", "gate", "brain", "browser"].map((role) => [
      role,
      `ghcr.io/shadowhusky/localdot-${role}@sha256:${"a".repeat(64)}`,
    ]),
  );
  const files = Object.fromEntries(
    [
      "dist/daemon.mjs",
      "dist/cli.mjs",
      "web/dist/index.html",
      "keyd",
      "install.sh",
      "node_modules/sharp/package.json",
    ].map((path) => [path, { sha256: "a".repeat(64), bytes: 1, mode: 0o600 }]),
  );
  return {
    v: 1,
    version: "0.1.0-rc.1",
    commit: "b".repeat(40),
    images: { arm64: pins, x64: pins },
    platforms: {
      "darwin-arm64": {
        url: "https://github.com/Shadowhusky/localdot/releases/download/v0.1.0-rc.1/localdot-0.1.0-rc.1-darwin-arm64.tgz",
        sha512: "c".repeat(128),
        bytes: 100,
        files,
      },
    },
  };
}
const envelope = (value: unknown) => {
  const payload = Buffer.from(JSON.stringify(value));
  return JSON.stringify({
    payload: payload.toString("base64"),
    signature: sign(null, payload, keys.privateKey).toString("base64"),
  });
};
describe("public distribution trust", () => {
  it("accepts only the pinned signing key", () => {
    expect(authenticatedCatalog(envelope(fixture()), pub)).toEqual(fixture());
    const other = generateKeyPairSync("ed25519")
      .publicKey.export({ format: "pem", type: "spki" })
      .toString();
    expect(() => authenticatedCatalog(envelope(fixture()), other)).toThrow("signature");
  });
  it("accepts the signed legacy bridge without trusting other repositories", () => {
    const legacy = fixture();
    legacy.platforms["darwin-arm64"].url = legacy.platforms["darwin-arm64"].url.replace(
      "/localdot/",
      "/localdot-downloads/",
    );
    expect(authenticatedCatalog(envelope(legacy), pub)).toEqual(legacy);
    legacy.platforms["darwin-arm64"].url = legacy.platforms["darwin-arm64"].url.replace(
      "/localdot-downloads/",
      "/another-repo/",
    );
    expect(() => authenticatedCatalog(envelope(legacy), pub)).toThrow("download");
  });
  it("rejects tampered metadata before using download URLs", () => {
    const signed = JSON.parse(envelope(fixture()));
    const altered = fixture();
    altered.version = "9.0.0";
    signed.payload = Buffer.from(JSON.stringify(altered)).toString("base64");
    expect(() => authenticatedCatalog(JSON.stringify(signed), pub)).toThrow("signature");
  });
  it.each([
    "https://github.com/Shadowhusky/localdot/archive/main.tgz",
    "http://github.com/Shadowhusky/localdot-downloads/releases/download/v1/localdot-a.tgz",
    "https://attacker.test/localdot.tgz",
  ])("refuses source archives and unsupported origins: %s", (url) => {
    const value = fixture();
    value.platforms["darwin-arm64"].url = url;
    expect(() => validateCatalog(value)).toThrow("download");
  });
  it.each(["../outside", "dist/../../outside", "/etc/profile", "dist/./cli.mjs"])(
    "refuses unsafe package path %s",
    (path) => {
      const value = fixture();
      value.platforms["darwin-arm64"].files[path] = {
        sha256: "a".repeat(64),
        bytes: 1,
        mode: 0o600,
      };
      expect(() => validateCatalog(value)).toThrow("file");
    },
  );
  it("rejects a download for a different platform or release", () => {
    const value = fixture();
    value.platforms["darwin-arm64"].url = value.platforms["darwin-arm64"].url.replace(
      "darwin-arm64.tgz",
      "linux-x64.tgz",
    );
    expect(() => validateCatalog(value)).toThrow("download");
  });
  it("rejects mutable container tags", () => {
    const value = fixture();
    value.images.arm64.desktop = "ghcr.io/shadowhusky/localdot-desktop:latest";
    expect(() => validateCatalog(value)).toThrow("immutable");
  });
  it("rejects incomplete app downloads", () => {
    const value = fixture();
    delete value.platforms["darwin-arm64"].files.keyd;
    expect(() => validateCatalog(value)).toThrow("incomplete");
  });
});
