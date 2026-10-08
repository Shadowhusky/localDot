import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { keydLockAcquirer, withInstallLock } from "./install-lock.ts";
import { buildTestKeyd } from "./testing/keyd-fixture.ts";

// Real kernel/process test. The helper is a local unsigned test build; the synthetic Sharp API
// waits for a private release file. No signing, Keychain, registry, services or user images.
let helper: Awaited<ReturnType<typeof buildTestKeyd>>;
beforeAll(async () => {
  helper = await buildTestKeyd();
}, 65_000);
afterAll(() => helper?.dispose());
const signal = () => new AbortController().signal;

it.each(["release", "deadline"])(
  "a native probe retains its crashed installer's lock until %s",
  async (ending) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-native-lifetime-")));
    const modules = join(root, "node_modules"),
      pkg = join(modules, "sharp");
    await mkdir(pkg, { recursive: true, mode: 0o700 });
    const released = join(root, "release-probe");
    await writeFile(
      join(pkg, "index.js"),
      `
    const fs=require('node:fs');
    const root=require('node:path').join(__dirname,'../..');
    fs.writeFileSync(root+'/probe.json',JSON.stringify({pid:process.pid}));
      ${
        ending === "deadline"
          ? `
        // Fixture-only backstop prevents an orphan even if the production watchdog regresses.
        new (require('node:worker_threads').Worker)(\`
          const {workerData}=require('node:worker_threads');
          setTimeout(()=>{require('node:fs').writeFileSync(workerData+'/fixture-backstop','fired');
            process.kill(process.pid,'SIGKILL');},25000);
        \`,{eval:true,workerData:root,env:{},execArgv:[]});
        while(true){}
      `
          : ""
      }
    const deadline=Date.now()+10000;
    const api={png(){return this},ensureAlpha(){return this},raw(){return this},async toBuffer(options){
      while(!fs.existsSync(root+'/release-probe')){
        if(Date.now()>deadline)process.exit(90);
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      return options?{data:Buffer.from(Array(4).fill([17,34,51,255]).flat()),info:{width:2,height:2,channels:4}}:Buffer.from('fixture');
    }};
    function sharp(){return Object.create(api)};
    sharp.versions={sharp:'1.2.3',vips:'8.0.0'};module.exports=sharp;
  `,
      { mode: 0o600 },
    );
    const parentProgram = `
    import {withInstallLock,keydLockAcquirer} from ${JSON.stringify(new URL("./install-lock.ts", import.meta.url).href)};
    import {probeNativeDependencies} from ${JSON.stringify(new URL("./native-probe.ts", import.meta.url).href)};
    const [root,helper]=process.argv.slice(1);
    await withInstallLock(root,new AbortController().signal,keydLockAcquirer(helper),async lifetime=>{
      await probeNativeDependencies(root+'/node_modules','1.2.3',new AbortController().signal,lifetime);
    });
  `;
    const parent = spawn(
      process.execPath,
      [
        "--experimental-transform-types",
        "--input-type=module",
        "-e",
        parentProgram,
        root,
        helper.path,
      ],
      {
        cwd: root,
        env: { PATH: process.env.PATH },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const closed = new Promise<void>((resolve) => parent.once("close", () => resolve()));
    // Drain bounded test diagnostics to avoid blocking the child on pipe capacity.
    let diagnostics = "";
    const collect = (b: Buffer) => {
      diagnostics = (diagnostics + b.toString()).slice(-8192);
    };
    parent.stdout.on("data", collect);
    parent.stderr.on("data", collect);
    let childPid: number | undefined;
    try {
      await vi.waitFor(
        async () => {
          if (parent.exitCode !== null) throw new Error(`installer exited: ${diagnostics}`);
          const observed = JSON.parse(await readFile(join(root, "probe.json"), "utf8"));
          childPid = observed.pid;
          expect(childPid).toBeGreaterThan(1);
        },
        { timeout: 5000 },
      );
      parent.kill("SIGKILL"); // Only this test's exact child handle, never a PID/prefix search.
      await closed;
      expect(parent.signalCode).toBe("SIGKILL");
      const runningPid = childPid;
      if (!runningPid) throw new Error("native child did not report its PID");
      expect(() => process.kill(runningPid, 0)).not.toThrow();
      await expect(
        withInstallLock(root, signal(), keydLockAcquirer(helper.path), async () => "overlap"),
      ).rejects.toThrow("Another installation operation");
      if (ending === "release") await writeFile(released, "release", { mode: 0o600 });
      await vi.waitFor(
        async () => {
          await expect(
            withInstallLock(root, signal(), keydLockAcquirer(helper.path), async () => "retired"),
          ).resolves.toBe("retired");
        },
        { timeout: ending === "deadline" ? 20000 : 5000 },
      );
      await expect(readFile(join(root, "fixture-backstop"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await writeFile(released, "release", { mode: 0o600 });
      if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
      await closed;
      // The orphan is self-bounded even on assertion failure. Confirm it exited before removal.
      const remainingPid = childPid;
      if (remainingPid)
        await vi.waitFor(
          () => {
            expect(() => process.kill(remainingPid, 0)).toThrow();
          },
          { timeout: 20000 },
        );
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
