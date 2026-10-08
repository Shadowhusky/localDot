import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { assertRuntimeImports, runtimeBuildOptions, WORKSPACE } from "./build-options.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("round-trips masked multilingual WebSocket frames and rejects invalid UTF-8 without native addons or sockets", async () => {
  const root = await mkdtemp(join(tmpdir(), "localdot-bundled-ws-"));
  roots.push(root);
  const requireDaemon = createRequire(join(WORKSPACE, "apps/daemon/package.json"));
  const result = await build({
    ...runtimeBuildOptions("0.0.0-rc.0"),
    stdin: {
      contents: `
import {Receiver, Sender} from ${JSON.stringify(requireDaemon.resolve("ws"))};
const text = '你好，Hello 🌍 '.repeat(100);
async function decode(data) {
 const receiver = new Receiver({isServer:true});
 const result = new Promise(resolve => {receiver.once('message', value => resolve({text:value.toString()}));receiver.once('error', error => resolve({error:error.code}));});
 const frames = Sender.frame(data,{mask:true,fin:true,rsv1:false,opcode:1,readOnly:true});
 receiver.write(Buffer.concat(frames));
 const value = await result; receiver.destroy(); return value;
}
console.log(JSON.stringify({valid:await decode(Buffer.from(text)),invalid:await decode(Buffer.from([0xff])),expected:text}));`,
      resolveDir: WORKSPACE,
    },
    outfile: join(root, "probe.mjs"),
  });
  assertRuntimeImports(result.metafile);
  const child = spawnSync(process.execPath, [join(root, "probe.mjs")], {
    cwd: root,
    env: { HOME: root, PATH: "/usr/bin:/bin" },
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(child.status, child.stderr).toBe(0);
  const value = JSON.parse(child.stdout);
  expect(value.valid.text).toBe(value.expected);
  expect(value.invalid.error).toBe("WS_ERR_INVALID_UTF8");
});

it("refuses an unresolved runtime dependency while recognizing prefix-only Node builtins", () => {
  const imports = (path) => ({ outputs: { bundle: { imports: [{ path, external: true }] } } });
  expect(() => assertRuntimeImports(imports("node:sqlite"))).not.toThrow();
  expect(() => assertRuntimeImports(imports("bufferutil"))).toThrow("external runtime dependency");
  expect(() => assertRuntimeImports(imports("sharp"), ["sharp"])).not.toThrow();
});
