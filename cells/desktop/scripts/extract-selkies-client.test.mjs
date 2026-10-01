import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./extract-selkies-client.sh", import.meta.url));

// A docker stand-in that writes what the selkies-client stage would, so the guard runs without Docker.
const FAKE_DOCKER = `#!/usr/bin/env bash
set -eu
echo "$*" >> "$FAKE_DOCKER_LOG"
for arg in "$@"; do
  case "$arg" in type=local,dest=*) dest="\${arg#type=local,dest=}" ;; esac
done
mkdir -p "$dest/assets"
printf '<head><link rel="manifest" href="manifest.json" crossorigin="use-credentials"></head>' > "$dest/index.html"
echo "// core" > "$dest/assets/core.js"
touch "$dest/icon.png" "$dest/icon-512.png" "$dest/LICENSE"
`;

// A copy of the script inside a scratch tree laid out like the repository, so `root` is the tree.
function scratchRepo({ dockerfile = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "local dot's extract-")));
  mkdirSync(join(root, "cells", "desktop", "scripts"), { recursive: true });
  const script = join(root, "cells", "desktop", "scripts", "extract-selkies-client.sh");
  copyFileSync(SCRIPT, script);
  chmodSync(script, 0o755);
  if (dockerfile) writeFileSync(join(root, "cells", "desktop", "Dockerfile"), "FROM scratch\n");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), FAKE_DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
  const log = join(root, "docker.log");
  const run = (dest) =>
    spawnSync(script, [dest], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_LOG: log },
    });
  const dockerRuns = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return { root, run, dockerRuns };
}

describe("extract-selkies-client.sh", () => {
  it("extracts into a missing destination inside the repository, creating its parents", () => {
    const repo = scratchRepo();
    const dest = join(repo.root, "apps", "web", "vendor", "selkies");
    const r = repo.run(dest);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(dest, "index.html"), "utf8")).not.toContain('rel="manifest"');
    expect(existsSync(join(dest, "index.html.orig"))).toBe(false);
    expect(repo.dockerRuns()).toHaveLength(1);
  });

  it("replaces a previous extraction", () => {
    const repo = scratchRepo();
    const dest = join(repo.root, "vendor");
    mkdirSync(join(dest, "assets"), { recursive: true });
    writeFileSync(join(dest, "index.html"), "old");
    writeFileSync(join(dest, "assets", "old.js"), "// old");
    const r = repo.run(dest);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(dest, "assets", "old.js"))).toBe(false);
    expect(existsSync(join(dest, "assets", "core.js"))).toBe(true);
  });

  it("refuses a tree without cells/desktop/Dockerfile, before touching anything", () => {
    const repo = scratchRepo({ dockerfile: false });
    const dest = join(repo.root, "vendor");
    mkdirSync(join(dest, "assets"), { recursive: true });
    writeFileSync(join(dest, "index.html"), "old");
    const r = repo.run(dest);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cells/desktop/Dockerfile");
    expect(readFileSync(join(dest, "index.html"), "utf8")).toBe("old");
    expect(repo.dockerRuns()).toEqual([]);
  });

  it("refuses an existing destination that is not a previous extraction", () => {
    const repo = scratchRepo();
    const notes = join(repo.root, "notes");
    mkdirSync(notes);
    writeFileSync(join(notes, "index.html"), "mine");
    const file = join(repo.root, "notes.txt");
    writeFileSync(file, "mine");
    for (const dest of [notes, file]) {
      const r = repo.run(dest);
      expect(r.status, dest).toBe(1);
      expect(r.stderr).toContain("not a previous extraction");
    }
    expect(readFileSync(join(notes, "index.html"), "utf8")).toBe("mine");
    expect(readFileSync(file, "utf8")).toBe("mine");
    expect(repo.dockerRuns()).toEqual([]);
  });

  it("refuses the repository itself and anything outside it", () => {
    const repo = scratchRepo();
    const outside = mkdtempSync(join(tmpdir(), "local dot's outside-"));
    for (const dest of [repo.root, outside, `${repo.root}/missing/../x`]) {
      const r = repo.run(dest);
      expect(r.status, dest).toBe(1);
      expect(r.stderr).toContain("must be inside");
    }
    expect(repo.dockerRuns()).toEqual([]);
  });
});
