export const fixtureNames = [
  "sharp",
  "@img/colour",
  "detect-libc",
  "semver",
  "@img/sharp-darwin-arm64",
  "@img/sharp-libvips-darwin-arm64",
];
export function nativeFixture() {
  const dependencies = {
    sharp: "1.0.0",
    "@img/sharp-darwin-arm64": "1.0.0",
    "@img/sharp-libvips-darwin-arm64": "1.0.0",
  };
  const pkg = { name: "localdot", version: "1.0.0", dependencies, os: ["darwin"], cpu: ["arm64"] };
  const packages: Record<string, Record<string, unknown>> = { "": { ...pkg } };
  for (const name of fixtureNames)
    packages[`node_modules/${name}`] = {
      version: "1.0.0",
      resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-1.0.0.tgz`,
      integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
    };
  Object.assign(packages["node_modules/sharp"] ?? {}, {
    dependencies: { "@img/colour": "1.0.0", "detect-libc": "1.0.0", semver: "1.0.0" },
    optionalDependencies: {
      "@img/sharp-darwin-arm64": "1.0.0",
      "@img/sharp-libvips-darwin-arm64": "1.0.0",
    },
  });
  for (const name of ["@img/sharp-darwin-arm64", "@img/sharp-libvips-darwin-arm64"])
    Object.assign(packages[`node_modules/${name}`] ?? {}, { os: ["darwin"], cpu: ["arm64"] });
  return {
    pkg,
    lock: { name: "localdot", version: "1.0.0", lockfileVersion: 3, requires: true, packages },
  };
}
