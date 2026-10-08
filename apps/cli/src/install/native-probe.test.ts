import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { probeNativeDependencies } from "./native-probe.ts";

const roots: string[] = [];
const signal = () => new AbortController().signal;
async function fixture(source: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-native-probe-")));
  roots.push(root);
  const modules = join(root, "node_modules"),
    pkg = join(modules, "sharp");
  await mkdir(pkg, { recursive: true, mode: 0o700 });
  await writeFile(join(pkg, "index.js"), source);
  return { root, modules };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("runs the fixed pixel probe with a minimal environment", async () => {
  vi.stubEnv("LOCALDOT_PROBE_SECRET", "must-not-inherit");
  try {
    // Synthetic JS API fixture tests process plumbing only, not real native image behavior.
    const f =
      await fixture(`if(process.env.LOCALDOT_PROBE_SECRET || process.env.NODE_OPTIONS) throw Error('environment leaked');
    const api={png(){return this},ensureAlpha(){return this},raw(){return this},async toBuffer(options){return options ? {data:Buffer.from(Array(4).fill([17,34,51,255]).flat()),info:{width:2,height:2,channels:4}} : Buffer.from('fixture')}};
    function sharp(){return Object.create(api)};sharp.versions={sharp:'1.2.3',vips:'8.0.0'};module.exports=sharp;`);
    await expect(probeNativeDependencies(f.modules, "1.2.3", signal())).resolves.toEqual({
      sharp: "1.2.3",
      vips: "8.0.0",
    });
  } finally {
    vi.unstubAllEnvs();
  }
});
it("refuses an expired installation scope before starting a process", async () => {
  const f = await fixture("throw Error('must not execute');");
  const inheritDescriptor = vi.fn(() => {
    throw new Error("expired lock scope");
  });
  expect(() =>
    probeNativeDependencies(f.modules, "1.2.3", signal(), {
      directory: f.root,
      inheritDescriptor,
    }),
  ).toThrow("expired lock scope");
  expect(inheritDescriptor).toHaveBeenCalledOnce();
});
it.each([
  "throw Error('private diagnostic');",
  "process.stdout.write('x'.repeat(20000)); throw Error('overflow');",
])("sanitizes failed or excessive child output", async (source) => {
  const f = await fixture(source);
  await expect(probeNativeDependencies(f.modules, "1.2.3", signal())).rejects.toThrow(
    /^The verified native image runtime did not pass its health check\.$/,
  );
});
it("cancels a running native-check process and waits until it is reaped", async () => {
  const f = await fixture(
    `require('node:fs').writeFileSync(require('node:path').join(__dirname,'../../started'),String(process.pid));while(true){}`,
  );
  const controller = new AbortController(),
    reason = new Error("stop");
  const result = probeNativeDependencies(f.modules, "1.2.3", controller.signal).catch(
    (error) => error,
  );
  let pid = 0;
  await vi.waitFor(
    async () => {
      pid = Number(await readFile(join(f.root, "started"), "utf8"));
      expect(pid).toBeGreaterThan(0);
    },
    { timeout: 3000 },
  );
  controller.abort(reason);
  expect(await result).toBe(reason);
  expect(() => process.kill(pid, 0)).toThrow();
});
