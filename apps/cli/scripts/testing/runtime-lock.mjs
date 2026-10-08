import { createHash } from "node:crypto";

export function sampleRuntimeLock() {
  const packages = {},
    snapshots = {};
  const add = (name, version, meta = {}, snapshot = {}) => {
    packages[`${name}@${version}`] = {
      resolution: {
        integrity: `sha512-${createHash("sha512").update(`${name}@${version}`).digest("base64")}`,
      },
      ...meta,
    };
    snapshots[`${name}@${version}`] = snapshot;
  };
  add("codec", "2.0.0", {}, { dependencies: { transitive: "3.0.0" } });
  add("transitive", "3.0.0");
  for (const arch of ["arm64", "x64"]) {
    add(
      `@img/sharp-darwin-${arch}`,
      "1.0.0",
      { os: ["darwin"], cpu: [arch] },
      {
        optionalDependencies: { [`@img/sharp-libvips-darwin-${arch}`]: "1.2.3" },
      },
    );
    add(`@img/sharp-libvips-darwin-${arch}`, "1.2.3", { os: ["darwin"], cpu: [arch] });
  }
  add(
    "sharp",
    "1.0.0",
    {
      peerDependencies: { "@types/node": "*" },
      peerDependenciesMeta: { "@types/node": { optional: true } },
    },
    {
      dependencies: { codec: "2.0.0" },
      optionalDependencies: {
        "@img/sharp-darwin-arm64": "1.0.0",
        "@img/sharp-libvips-darwin-arm64": "1.2.3",
        "@img/sharp-darwin-x64": "1.0.0",
        "@img/sharp-libvips-darwin-x64": "1.2.3",
        "@types/node": "24.0.0",
      },
    },
  );
  return {
    lockfileVersion: "9.0",
    importers: {
      "apps/daemon": { dependencies: { sharp: { specifier: "1.0.0", version: "1.0.0" } } },
    },
    packages,
    snapshots,
  };
}
