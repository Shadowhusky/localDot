import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { assertRuntimeImports, runtimeBuildOptions, WORKSPACE } from "./build-options.mjs";
import { writeDependencyNotices } from "./licenses.mjs";

it("bundles real verification without ambient dependencies, preserves licenses, and runs offline", async () => {
  const output = await mkdtemp(join(tmpdir(), "localdot-sigstore-bundle-"));
  try {
    const result = await build({
      ...runtimeBuildOptions("0.0.0-rc.1"),
      entryPoints: {
        verifier: join(WORKSPACE, "apps/cli/src/install/sigstore-verifier.ts"),
        release: join(WORKSPACE, "apps/cli/src/install/release-provenance.ts"),
      },
      outdir: output,
      outExtension: { ".js": ".mjs" },
    });
    assertRuntimeImports(result.metafile);
    const notices = await writeDependencyNotices({
      inputs: Object.keys(result.metafile.inputs),
      workspace: WORKSPACE,
      outDir: join(output, "licenses"),
    });
    expect(notices.map(({ name, version }) => `${name}@${version}`).sort()).toEqual([
      "@sigstore/bundle@5.0.0",
      "@sigstore/core@4.0.1",
      "@sigstore/protobuf-specs@0.5.0",
      "@sigstore/verify@4.0.0",
      "zod@4.6.5",
    ]);
    for (const name of ["verifier", "release"]) {
      const text = await readFile(join(output, `${name}.mjs`), "utf8");
      expect(text).not.toMatch(/\/Users\/|\/private\/tmp\/|\/Volumes\//);
      expect(text).not.toContain("sigstore-fixture-inputs");
    }
    const fixture = join(WORKSPACE, "apps/cli/src/install/testing/sigstore");
    const code = `
      import { readFileSync } from 'node:fs';
      import { pathToFileURL } from 'node:url';
      import { join } from 'node:path';
      const [output, fixture] = process.argv.slice(1);
      const { createSigstoreVerifier } = await import(pathToFileURL(join(output, 'verifier.mjs')));
      const { createReleaseProvenanceVerifier } = await import(pathToFileURL(join(output, 'release.mjs')));
      const root = readFileSync(join(fixture, 'trusted-root.json'), 'utf8');
      const bundle = JSON.parse(readFileSync(join(fixture, 'bundle.json'), 'utf8'));
      const uri = 'https://github.com/sigstore/sigstore-js/.github/workflows/release.yml@refs/heads/main';
      const policy = {certificateIdentityURI:'^'+uri.replaceAll('.', String.fromCharCode(92)+'.')+'$', certificateIssuer:'https://token.actions.githubusercontent.com',ctLogThreshold:1,tlogThreshold:1};
      const verify = createSigstoreVerifier(root);
      await verify(bundle, policy, new AbortController().signal);
      const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload,'base64').toString());
      const doc = JSON.stringify({attestations:[{predicateType:statement.predicateType,bundle}]});
      let refused = false;
      try { await createReleaseProvenanceVerifier(root)(doc,{name:'localdot',version:'5.0.0',sha512:statement.subject[0].digest.sha512,commit:statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit},new AbortController().signal); }
      catch { refused = true; }
      if (!refused) throw new Error('Foreign release accepted');
      console.log('verified-offline-and-refused-foreign-release');
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", code, output, fixture],
      { cwd: output, env: {}, timeout: 10_000, maxBuffer: 4096 },
    );
    expect(stdout.trim()).toBe("verified-offline-and-refused-foreign-release");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
