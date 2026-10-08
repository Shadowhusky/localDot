import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { runtimeBuildOptions, WORKSPACE } from "./build-options.mjs";
import { buildRuntime } from "./build-runtime.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "localdot-package-layout-"));
  roots.push(root);
  const payload = join(root, "built payload");
  for (const path of ["dist", "web/dist/assets/licenses", "skills/office-files"])
    await mkdir(join(payload, path), { recursive: true });
  const policy = await readFile(join(WORKSPACE, "apps/daemon/src/cells/browser-seccomp.json"));
  await writeFile(join(payload, "dist/browser-seccomp.json"), policy);
  await copyFile(
    join(WORKSPACE, "skills/office-files/SKILL.md"),
    join(payload, "skills/office-files/SKILL.md"),
  );
  await writeFile(
    join(payload, "web/dist/index.html"),
    "<!doctype html><title>Relocated localDot</title>",
  );
  await writeFile(
    join(payload, "web/dist/assets/licenses/mediabunny-1.61.0.txt"),
    "fixture license",
  );
  const requireDaemon = createRequire(join(WORKSPACE, "apps/daemon/package.json"));
  const src = (relative) => JSON.stringify(join(WORKSPACE, relative));
  const contents = `
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {runtimeLayout} from ${src("apps/daemon/src/runtime-layout.ts")};
import {serveUi, webDir} from ${src("apps/daemon/src/static-ui.ts")};
import {browserSpec} from ${src("apps/daemon/src/cells/browser-spec.ts")};
import {sampleBrowserRecord} from ${src("apps/daemon/src/cells/testing/sample-browser-record.ts")};
import {Hono} from ${JSON.stringify(requireDaemon.resolve("hono"))};
const app = new Hono(); serveUi(app, webDir('dist'));
const page = await app.request('http://127.0.0.1/');
const notice = await app.request('http://127.0.0.1/assets/licenses/mediabunny-1.61.0.txt');
const spec = browserSpec(sampleBrowserRecord(), 'local-fixture-image');
const policy = spec.HostConfig.SecurityOpt.find(value => value.startsWith('seccomp=')).slice(8);
console.log(JSON.stringify({layout:runtimeLayout,html:await page.text(),pageStatus:page.status,noticeStatus:notice.status,notice:await notice.text(),skill:readFileSync(join(runtimeLayout.skills,'office-files/SKILL.md'),'utf8'),policySHA256:createHash('sha256').update(policy).digest('hex')}));
`;
  const result = await build({
    ...runtimeBuildOptions("0.0.0-rc.0"),
    stdin: { contents, resolveDir: WORKSPACE, loader: "js" },
    outfile: join(payload, "dist/probe.mjs"),
  });
  // The workspace sources must belong to this candidate, not a shared dependency link's checkout.
  expect(Object.keys(result.metafile.inputs)).toContain("packages/protocol/src/ids.ts");
  const destination = join(root, "installed app's #directory%value");
  await rename(payload, destination);
  const relocated = await realpath(destination);
  return {
    root,
    relocated,
    policy,
    run: () =>
      spawnSync(process.execPath, [join(relocated, "dist/probe.mjs")], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        env: { PATH: process.env.PATH, HOME: root },
      }),
  };
}

it("serves relocated UI/notices in-process and loads the exact installed skill and browser policy", async () => {
  const f = await fixture();
  const result = f.run();
  expect(result.status, result.stderr).toBe(0);
  const value = JSON.parse(result.stdout);
  expect(value.layout).toEqual({
    web: join(f.relocated, "web"),
    skills: join(f.relocated, "skills"),
    browserSeccomp: join(f.relocated, "dist/browser-seccomp.json"),
  });
  expect(value.html).toContain("Relocated localDot");
  expect(value.pageStatus).toBe(200);
  expect(value.noticeStatus).toBe(200);
  expect(value.notice).toBe("fixture license");
  expect(value.skill).toBe(await readFile(join(WORKSPACE, "skills/office-files/SKILL.md"), "utf8"));
  expect(value.policySHA256).toBe(createHash("sha256").update(f.policy).digest("hex"));
});
it("fails to load the browser specification when the installed security policy is missing", async () => {
  const f = await fixture();
  await rm(join(f.relocated, "dist/browser-seccomp.json"));
  const result = f.run();
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe("");
});
it("does not overwrite an existing payload directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "localdot-existing-payload-"));
  roots.push(root);
  const path = join(root, "preserve.txt");
  await writeFile(path, "keep existing data");
  await expect(buildRuntime({ output: root, version: "0.0.0-rc.0" })).rejects.toMatchObject({
    code: "EEXIST",
  });
  expect(await readFile(path, "utf8")).toBe("keep existing data");
});
