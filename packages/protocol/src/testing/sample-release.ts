const hex = (c: string) => c.repeat(64);

export interface SampleImage {
  repository: string;
  digest: string;
  platforms: string[];
}

export interface SampleManifest {
  v: number;
  name: string;
  version: string;
  commit: string;
  files: Record<string, string>;
  keyd: {
    package: string;
    path: string;
    sha256: string;
    identifier: string;
    teamId: string;
    native: { path: string; sha256: string; identifier: string };
  };
  images: Record<"desktop" | "gate" | "brain" | "browser", SampleImage>;
}

const pin = (role: string): SampleImage => ({
  repository: `ghcr.io/shadowhusky/localdot-${role}`,
  digest: `sha256:${hex("a")}`,
  platforms: ["linux/arm64", "linux/amd64"],
});

// A manifest that parses; tests mutate a fresh copy, loosely typed so they can break any field.
export const sampleManifest = (): SampleManifest => ({
  v: 1,
  name: "localdot",
  version: "1.0.0",
  commit: "0".repeat(40),
  files: { "dist/cli.mjs": hex("b"), "web/index.html": hex("c") },
  keyd: {
    package: "@localdot/keyd-darwin-arm64",
    path: "bin/keyd",
    sha256: hex("d"),
    identifier: "dev.localdot.keyd",
    teamId: "TESTTEAM01",
    native: { path: "bin/keyd-native", sha256: hex("e"), identifier: "dev.localdot.keyd.native" },
  },
  images: {
    desktop: pin("desktop"),
    gate: pin("gate"),
    brain: pin("brain"),
    browser: pin("browser"),
  },
});
