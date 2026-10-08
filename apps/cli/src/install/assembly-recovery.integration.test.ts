import { spawn } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { recoverAssemblyScratch } from "./assembly-scratch.ts";
import { keydLockAcquirer, withInstallLock } from "./install-lock.ts";
import { buildTestKeyd } from "./testing/keyd-fixture.ts";

it("recovers the recorded assembly after installer death only once its native child retires", async () => {
  const helper = await buildTestKeyd();
  const state = await realpath(await mkdtemp(join(tmpdir(), "localdot-assembly-crash-")));
  await writeFile(join(state, "user-keep"), "preserve", { mode: 0o600 });
  const moduleSource = `
    const fs=require('node:fs'),root=require('node:path').join(__dirname,'../..');
    fs.writeFileSync(root+'/started',String(process.pid));
    const api={png(){return this},ensureAlpha(){return this},raw(){return this},async toBuffer(options){
      while(!fs.existsSync(root+'/release'))await new Promise(resolve=>setTimeout(resolve,25));
      return options?{data:Buffer.from(Array(4).fill([17,34,51,255]).flat()),info:{width:2,height:2,channels:4}}:Buffer.from('fixture');
    }};
    function sharp(){return Object.create(api)};sharp.versions={sharp:'1.2.3',vips:'8.0.0'};module.exports=sharp;
  `;
  const program = `
    import {mkdir,writeFile} from 'node:fs/promises';
    import {withInstallLock,keydLockAcquirer} from ${JSON.stringify(new URL("./install-lock.ts", import.meta.url).href)};
    import {createAssemblyScratch} from ${JSON.stringify(new URL("./assembly-scratch.ts", import.meta.url).href)};
    import {probeNativeDependencies} from ${JSON.stringify(new URL("./native-probe.ts", import.meta.url).href)};
    const [state,helper]=process.argv.slice(1),signal=new AbortController().signal;
    await withInstallLock(state,signal,keydLockAcquirer(helper),async lifetime=>{
      const scratch=await createAssemblyScratch(state,signal,lifetime);
      const modules=scratch.directory+'/node_modules';
      await mkdir(modules+'/sharp',{recursive:true,mode:0o700});
      await writeFile(modules+'/sharp/index.js',${JSON.stringify(moduleSource)},{mode:0o600});
      await probeNativeDependencies(modules,'1.2.3',signal,lifetime);
    });
  `;
  const parent = spawn(
    process.execPath,
    ["--input-type=module", "-e", program, state, helper.path],
    {
      cwd: state,
      env: { PATH: process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const closed = new Promise<void>((resolve) => parent.once("close", () => resolve()));
  let diagnostics = "";
  const collect = (bytes: Buffer) => {
    diagnostics = (diagnostics + bytes.toString()).slice(-8192);
  };
  parent.stdout.on("data", collect);
  parent.stderr.on("data", collect);
  let directory: string | undefined, pid: number | undefined;
  try {
    await vi.waitFor(
      async () => {
        if (parent.exitCode !== null) throw new Error(`installer exited: ${diagnostics}`);
        const record = JSON.parse(await readFile(join(state, "assembly-scratch.json"), "utf8"));
        expect(record.name).toMatch(/^\.assembly-[a-f0-9]{32}$/);
        directory = join(state, record.name);
        pid = Number(await readFile(join(directory, "started"), "utf8"));
        expect(pid).toBeGreaterThan(1);
      },
      { timeout: 5000 },
    );
    const scratch = directory;
    if (!scratch) throw new Error("missing assembly");
    parent.kill("SIGKILL");
    await closed;
    let entered = false;
    await expect(
      withInstallLock(
        state,
        new AbortController().signal,
        keydLockAcquirer(helper.path),
        async (lifetime) => {
          entered = true;
          await recoverAssemblyScratch(state, new AbortController().signal, lifetime);
        },
      ),
    ).rejects.toThrow("Another installation operation");
    expect(entered).toBe(false);
    expect((await lstat(scratch)).isDirectory()).toBe(true);
    await writeFile(join(scratch, "release"), "release", { mode: 0o600 });
    await vi.waitFor(
      async () => {
        await withInstallLock(
          state,
          new AbortController().signal,
          keydLockAcquirer(helper.path),
          async (lifetime) => {
            await recoverAssemblyScratch(state, new AbortController().signal, lifetime);
          },
        );
      },
      { timeout: 5000 },
    );
    await expect(lstat(scratch)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(state, "assembly-scratch.json"), "utf8")).toBe("null\n");
    expect(await readFile(join(state, "user-keep"), "utf8")).toBe("preserve");
    expect((await readdir(state)).sort()).toEqual([
      "assembly-scratch.json",
      "install.lock",
      "user-keep",
    ]);
  } finally {
    if (directory)
      await writeFile(join(directory, "release"), "release").catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    await closed;
    const remaining = pid;
    if (remaining)
      await vi.waitFor(
        () => {
          expect(() => process.kill(remaining, 0)).toThrow();
        },
        { timeout: 20000 },
      );
    await rm(state, { recursive: true, force: true });
    await helper.dispose();
  }
}, 65000);
