import { describe, expect, it } from "vitest";
import { imageVerdict } from "./doctor-image.ts";

const digest = `sha256:${"a".repeat(64)}`;
const other = `sha256:${"b".repeat(64)}`;
const image = `ghcr.io/localdot/desktop@${digest}`;
const engine = { Os: "linux", Arch: "arm64" };
const inspect = { Os: "linux", Architecture: "arm64", Id: other, RepoDigests: [image] };

describe("doctor image identity", () => {
  it("accepts a matching arm64 image whose repository digest was inspected", () => {
    expect(imageVerdict(image, engine, inspect)).toMatchObject({ ok: true });
  });
  it("rejects an amd64 image on an arm64 engine even when its pinned digest matches", () => {
    expect(imageVerdict(image, engine, { ...inspect, Architecture: "amd64" })).toMatchObject({
      ok: false,
      detail: expect.stringContaining("linux/amd64"),
    });
  });
  it("rejects an arm64 image on an amd64 engine and accepts the matching amd64 variant", () => {
    const amd = { ...engine, Arch: "amd64" };
    expect(imageVerdict(image, amd, inspect).ok).toBe(false);
    expect(imageVerdict(image, amd, { ...inspect, Architecture: "amd64" }).ok).toBe(true);
  });
  it("rejects a Windows image even if its architecture matches", () => {
    expect(imageVerdict(image, engine, { ...inspect, Os: "windows" }).ok).toBe(false);
  });
  it.each([
    undefined,
    null,
    {},
    [],
    { Os: "linux" },
    { Architecture: "arm64" },
    { Os: "linux", Architecture: ["arm64"] },
    { Os: "linux", Architecture: "arm" },
  ])("does not infer an image platform from incomplete or malformed metadata %#", (value) => {
    expect(imageVerdict(image, engine, value).ok).toBe(false);
  });
  it.each([
    { Os: "linux", Arch: "" },
    { Os: "linux", Arch: "s390x" },
    { Os: "windows", Arch: "arm64" },
  ])("does not claim a supported engine for unknown or unsupported platform %#", (value) => {
    expect(imageVerdict(image, value, inspect).ok).toBe(false);
  });
  it.each([
    undefined,
    [],
    [`ghcr.io/localdot/desktop@${other}`],
    [`ghcr.io/another/desktop@${digest}`],
    image,
  ])("requires the exact requested repository and manifest digest %#", (RepoDigests) => {
    expect(imageVerdict(image, engine, { ...inspect, Id: digest, RepoDigests }).ok).toBe(false);
  });
  it("accepts an explicitly requested image ID only when the inspected ID matches", () => {
    expect(imageVerdict(other, engine, inspect).ok).toBe(true);
    expect(imageVerdict(digest, engine, inspect).ok).toBe(false);
  });
  it("allows a development tag but labels it unpinned", () => {
    expect(imageVerdict("localdot/desktop:dev", engine, inspect)).toMatchObject({
      ok: true,
      detail: expect.stringContaining("unpinned"),
    });
  });
  it.each([
    "ghcr.io/localdot/desktop@sha256:abc",
    `ghcr.io/localdot/desktop@sha512:${"a".repeat(64)}`,
    "sha256:abc",
    `ghcr.io/localdot/desktop@${digest.toUpperCase()}`,
  ])("does not downgrade a malformed digest reference into an unpinned tag %#", (value) => {
    expect(imageVerdict(value, engine, inspect).ok).toBe(false);
  });
});
