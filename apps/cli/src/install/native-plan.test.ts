import { expect, it } from "vitest";
import { nativeDependencyPlan } from "./native-plan.ts";
import { fixtureNames, nativeFixture } from "./testing/native-fixture.ts";

const plan = (f: ReturnType<typeof nativeFixture>) =>
  nativeDependencyPlan(JSON.stringify(f.pkg), JSON.stringify(f.lock), "1.0.0");
it("selects the exact reachable Darwin arm64 graph", () => {
  const f = nativeFixture();
  f.lock.packages["node_modules/foreign"] = {
    version: "1.0.0",
    resolved: "https://registry.npmjs.org/foreign/-/foreign-1.0.0.tgz",
    integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    optional: true,
    os: ["linux"],
  };
  const result = plan(f);
  expect(result.map((p) => p.name).sort()).toEqual([...fixtureNames].sort());
  expect(Object.isFrozen(result)).toBe(true);
});
it.each([
  "root-version",
  "range",
  "foreign-url",
  "bad-sri",
  "link",
  "nested",
  "missing-edge",
  "wrong-edge",
  "required-platform",
  "invalid-platform",
  "missing-root",
  "root-scripts",
  "unreachable-mandatory",
  "peer",
  "noncanonical-sri",
])("refuses invalid lock %s", (kind) => {
  const f = nativeFixture(),
    sharp = f.lock.packages["node_modules/sharp"],
    native = f.lock.packages["node_modules/@img/sharp-darwin-arm64"];
  if (!sharp || !native) throw new Error("fixture");
  if (kind === "root-version") f.lock.version = "2.0.0";
  if (kind === "range") sharp.version = "^1.0.0";
  if (kind === "foreign-url") sharp.resolved = "https://evil.invalid/archive.tgz";
  if (kind === "bad-sri") sharp.integrity = "sha256-xxxx";
  if (kind === "link") sharp.link = true;
  if (kind === "nested") f.lock.packages["node_modules/x/node_modules/y"] = { ...sharp };
  if (kind === "missing-edge") delete f.lock.packages["node_modules/semver"];
  if (kind === "wrong-edge") sharp.dependencies = { semver: "2.0.0" };
  if (kind === "required-platform") native.cpu = ["x64"];
  if (kind === "invalid-platform") native.os = ["darwin", "bad value"];
  if (kind === "missing-root")
    delete f.lock.packages["node_modules/@img/sharp-libvips-darwin-arm64"];
  if (kind === "root-scripts") Object.assign(f.pkg, { scripts: { postinstall: "execute" } });
  if (kind === "unreachable-mandatory")
    f.lock.packages["node_modules/unused"] = {
      ...sharp,
      resolved: "https://registry.npmjs.org/unused/-/unused-1.0.0.tgz",
      dependencies: {},
      optionalDependencies: {},
    };
  if (kind === "peer") sharp.peerDependencies = { unlocked: "*" };
  if (kind === "noncanonical-sri") sharp.integrity = `sha512-${"A".repeat(85)}B==`;
  expect(() => plan(f)).toThrow("lock is invalid");
});
it("permits only Sharp's optional type-only peer declaration", () => {
  const f = nativeFixture(),
    sharp = f.lock.packages["node_modules/sharp"];
  if (!sharp) throw new Error("fixture");
  sharp.peerDependencies = { "@types/node": "*" };
  sharp.peerDependenciesMeta = { "@types/node": { optional: true } };
  expect(plan(f)).toHaveLength(6);
  sharp.peerDependenciesMeta = { "@types/node": { optional: false } };
  expect(() => plan(f)).toThrow();
});
it("rejects oversized metadata and extra ambiguous lock fields", () => {
  const f = nativeFixture();
  expect(() =>
    nativeDependencyPlan(" ".repeat(1024 * 1024 + 1), JSON.stringify(f.lock), "1.0.0"),
  ).toThrow();
  Object.assign(f.lock, { dependencies: { other: "1.0.0" } });
  expect(() => plan(f)).toThrow();
});
