import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { runVerificationWorker } from "../src/install/verification-worker-host.ts";
import { buildCli } from "./build.mjs";
import { assertRuntimeImports, runtimeBuildOptions, WORKSPACE } from "./build-options.mjs";
import { writeDependencyNotices } from "./licenses.mjs";

it("ships a self-contained verification worker beside the CLI and loads it without ambient dependencies", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-trust-worker-build-")));
  try {
    const out = await buildCli({
      output: join(root, "installed path's #value"),
      version: "0.0.0-rc.1",
    });
    const entry = join(out, "dist/release-verification-worker.mjs");
    const bytes = await readFile(entry, "utf8");
    expect(bytes).not.toMatch(/\/Users\/|\/private\/tmp\/|\/Volumes\//);
    // Empty-storage validation fails before any network request. A real worker still imports the
    // compiled TUF/crypto graph, parses the pinned seed, reports failure and exits cleanly.
    const occupied = join(root, "occupied");
    await writeFile(occupied, "not a directory");
    await expect(
      runVerificationWorker(
        pathToFileURL(entry),
        { directory: occupied, previous: null },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Release trust verification failed");
    const compiled = await build({
      ...runtimeBuildOptions("0.0.0-rc.1"),
      entryPoints: [join(WORKSPACE, "apps/cli/src/install/release-verification-worker.ts")],
      outfile: join(root, "worker.mjs"),
    });
    assertRuntimeImports(compiled.metafile);
    const notices = await writeDependencyNotices({
      inputs: Object.keys(compiled.metafile.inputs),
      workspace: WORKSPACE,
      outDir: join(root, "licenses"),
    });
    expect(notices.map((n) => n.name)).toContain("tuf-js");
    expect(notices.map((n) => n.name)).toContain("@tufjs/models");
    expect(notices.map((n) => n.name)).toContain("@sigstore/verify");
    expect(await readdir(join(root, "licenses"))).toHaveLength(notices.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
