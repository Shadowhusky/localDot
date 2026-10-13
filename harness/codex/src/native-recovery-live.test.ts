import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  keydNativeLeaseAcquirer,
  NativeLeaseBusy,
} from "../../../apps/cli/src/install/install-lock.ts";
import { recoverNativeRetiredWithLease } from "../../../apps/cli/src/install/native-recovery.ts";
import { assertNativeRetired } from "../../../apps/cli/src/install/native-retirement.ts";
import { prepareNativeRetirement } from "./retirement-record.ts";
import {
  createOwnedCodexDirectory,
  prepareOwnedCodexRoots,
  removeOwnedCodexDirectory,
} from "./roots.ts";
import { spawnSupervisedCodex } from "./supervised-process.ts";

const binary = process.env.LOCALDOT_NATIVE_SUPERVISOR_TEST_BIN;
const live = it.skipIf(process.platform !== "darwin" || !binary);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
  // The supervisor-death fixture deliberately leaves a 10 s child alive; cleanup
  // allows 14 s for its exit and reaping, so the hook must outlast that bound.
}, 20000);
const signal = () => new AbortController().signal;
async function until(check: () => Promise<boolean> | boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("fixture condition did not complete");
    await new Promise((r) => setTimeout(r, 10));
  }
}
const exists = async (path: string) => {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
};
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
};
async function temp() {
  const path = await realpath(await mkdtemp("/private/tmp/ld-native-recovery-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function fixture() {
  const top = await temp(),
    user = join(top, "user");
  await mkdir(user, { mode: 0o700 });
  const roots = prepareOwnedCodexRoots(join(top, "app"), user),
    resources = {
      profile: createOwnedCodexDirectory(roots, "profilesRoot"),
      work: createOwnedCodexDirectory(roots, "workRoot"),
      bridge: createOwnedCodexDirectory(roots, "runRoot"),
    };
  for (const item of Object.values(resources))
    await writeFile(join(item.path, "marker"), "owned fixture");
  const prepared = await prepareNativeRetirement(roots, resources, true);
  return { top, roots, resources, prepared };
}

live(
  "normal retirement adopts the helper's receipt and releases the lease only after resource cleanup",
  async () => {
    const f = await fixture(),
      superv = f.prepared.supervision;
    expect(superv).toBeDefined();
    const p = spawnSupervisedCodex(
      {
        command: process.execPath,
        args: ["-e", "process.stdout.write('complete')"],
        cwd: f.resources.work.path,
        env: {},
        signal: signal(),
        register: () => {},
        supervision: superv,
      },
      binary as string,
    );
    p.stdout?.resume();
    await p.started;
    await p.closed;
    const pending = join(f.roots.profilesRoot, `.active-${superv?.record.nonce}.json`),
      retired = join(f.roots.profilesRoot, `.retired-${superv?.record.nonce}.json`);
    expect(await exists(pending)).toBe(false);
    expect(await exists(retired)).toBe(true);
    const handle = await open(f.roots.profilesRoot, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await expect(
        keydNativeLeaseAcquirer(binary as string)(
          handle.fd,
          f.roots.profilesRoot,
          "a".repeat(64),
          signal(),
        ),
      ).rejects.toBeInstanceOf(NativeLeaseBusy);
    } finally {
      await handle.close();
    }
    await expect(
      recoverNativeRetiredWithLease(join(f.top, "app"), AbortSignal.timeout(150), binary as string),
    ).rejects.toThrow("Native task recovery");
    for (const item of Object.values(f.resources))
      expect(await readFile(join(item.path, "marker"), "utf8")).toBe("owned fixture");
    const receipt = await f.prepared.persist(p.closed);
    for (const d of Object.values(f.resources)) await removeOwnedCodexDirectory(d);
    await receipt.finish();
    expect(() => superv?.descriptor).toThrow();
    await recoverNativeRetiredWithLease(join(f.top, "app"), signal(), binary as string);
    await assertNativeRetired(join(f.top, "app"), signal());
  },
);

async function crashedParent() {
  const top = await temp(),
    proof = join(top, "proof.json"),
    parentFile = join(top, "parent.mjs");
  const python = `import os,json,signal,time\nfds=[]\nfor fd in range(3,64):\n try: os.fstat(fd);fds.append(fd)\n except OSError: pass\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nprint('fds:'+json.dumps(fds),flush=True)\nprint('ready',flush=True)\ntime.sleep(10)\nos._exit(90)\n`;
  const imports = (name: string) => JSON.stringify(new URL(name, import.meta.url).href);
  await writeFile(
    parentFile,
    `
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {prepareOwnedCodexRoots,createOwnedCodexDirectory} from ${imports("./roots.ts")};
import {prepareNativeRetirement} from ${imports("./retirement-record.ts")};
import {spawnSupervisedCodex} from ${imports("./supervised-process.ts")};
const top=${JSON.stringify(top)},user=join(top,'user');mkdirSync(user,{mode:0o700});
const roots=prepareOwnedCodexRoots(join(top,'app'),user),resources={profile:createOwnedCodexDirectory(roots,'profilesRoot'),work:createOwnedCodexDirectory(roots,'workRoot'),bridge:createOwnedCodexDirectory(roots,'runRoot')};
for(const d of Object.values(resources))writeFileSync(join(d.path,'marker'),'owned fixture');
writeFileSync(join(roots.home,'credential-fixture'),'keep this fixture',{mode:0o600});
const ownership=await prepareNativeRetirement(roots,resources,true);globalThis.fixtureOwnership=ownership;
let helper;
const p=spawnSupervisedCodex({command:'/usr/bin/python3',args:['-c',${JSON.stringify(python)}],cwd:resources.work.path,env:{},signal:new AbortController().signal,register:()=>{},supervision:ownership.supervision,spawnImpl:(...args)=>{helper=spawn(...args);return helper}},${JSON.stringify(binary)});
p.stdout.pipe(process.stdout);p.stderr.resume();
await p.started;writeFileSync(${JSON.stringify(proof)},JSON.stringify({pid:p.pid,helper:helper.pid,roots,resources,record:ownership.supervision.record}));
process.stdin.on('data',()=>{helper.kill('SIGKILL');console.log('helper-killed')});
`,
  );
  const parent = spawn(process.execPath, ["--experimental-transform-types", parentFile], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {},
  });
  let output = "",
    errors = "";
  parent.stdout.on("data", (b) => {
    output += b;
  });
  parent.stderr.on("data", (b) => {
    errors += b;
  });
  cleanups.push(async () => {
    if (parent.exitCode === null && parent.signalCode === null) {
      const exit = new Promise((r) => parent.once("exit", r));
      parent.kill("SIGKILL");
      await exit;
    }
  });
  await until(async () => output.includes("ready\n") && (await exists(proof)));
  expect(output).toBe("fds:[]\nready\n");
  expect(errors).not.toContain("Error:");
  const data = JSON.parse(await readFile(proof, "utf8")) as {
    pid: number;
    helper: number;
    roots: { root: string; profilesRoot: string; home: string };
    resources: Record<"profile" | "work" | "bridge", { path: string }>;
    record: { nonce: string };
  };
  cleanups.push(() => until(() => gone(data.pid), 14000));
  const active = join(data.roots.profilesRoot, `.active-${data.record.nonce}.json`),
    retired = join(data.roots.profilesRoot, `.retired-${data.record.nonce}.json`);
  expect(await exists(active)).toBe(true);
  expect(await exists(retired)).toBe(false);
  const killParent = async () => {
    const exited = new Promise((r) => parent.once("exit", r));
    parent.kill("SIGKILL");
    await exited;
  };
  return { top, parent, data, active, retired, killParent, output: () => output };
}

live(
  "daemon SIGKILL publishes a durable receipt and recovery removes only its exact resources",
  async () => {
    const f = await crashedParent(),
      root = f.data.roots.profilesRoot;
    const fd = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await expect(
        keydNativeLeaseAcquirer(binary as string)(fd.fd, root, "b".repeat(64), signal()),
      ).rejects.toBeInstanceOf(NativeLeaseBusy);
    } finally {
      await fd.close();
    }
    await f.killParent();
    await recoverNativeRetiredWithLease(join(f.top, "app"), signal(), binary as string);
    await assertNativeRetired(join(f.top, "app"), signal());
    expect(await readFile(join(f.data.roots.home, "credential-fixture"), "utf8")).toBe(
      "keep this fixture",
    );
    expect(await readdir(root)).toEqual([]);
    expect(gone(f.data.pid)).toBe(true);
  },
);

live(
  "a resource identity replacement prevents publication and deletion after daemon death",
  async () => {
    const f = await crashedParent(),
      path = f.data.resources.work.path;
    await rename(path, `${path}-retained`);
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "replacement"), "untouched");
    await f.killParent();
    await expect(
      recoverNativeRetiredWithLease(join(f.top, "app"), signal(), binary as string),
    ).rejects.toThrow("Native task recovery");
    expect(await exists(f.active)).toBe(true);
    expect(await exists(f.retired)).toBe(false);
    expect(await readFile(join(path, "replacement"), "utf8")).toBe("untouched");
    expect(await readFile(join(`${path}-retained`, "marker"), "utf8")).toBe("owned fixture");
  },
);

live(
  "supervisor death releases its lock but its active record never authorizes cleanup",
  async () => {
    const f = await crashedParent();
    f.parent.stdin.end("kill");
    await until(() => f.output().includes("helper-killed"));
    await f.killParent();
    await expect(
      recoverNativeRetiredWithLease(join(f.top, "app"), signal(), binary as string),
    ).rejects.toThrow("Native task recovery");
    expect(gone(f.data.pid)).toBe(false);
    expect(await exists(f.active)).toBe(true);
    expect(await exists(f.retired)).toBe(false);
    for (const item of Object.values(f.data.resources))
      expect(await readFile(join(item.path, "marker"), "utf8")).toBe("owned fixture");
  },
  20000,
);
