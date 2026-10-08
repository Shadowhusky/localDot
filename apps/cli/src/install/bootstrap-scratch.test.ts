import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { recoverBootstrapScratch, withBootstrapScratch } from "./bootstrap-scratch.ts";
import { type InstallLockLifetime, keydLockAcquirer, withInstallLock } from "./install-lock.ts";
import { buildTestKeyd } from "./testing/keyd-fixture.ts";

const roots: string[] = [],
  children: Array<{ stop(): Promise<void> }> = [];
let helper: Awaited<ReturnType<typeof buildTestKeyd>>;
const signal = () => new AbortController().signal;
beforeAll(async () => {
  helper = await buildTestKeyd();
}, 65000);
afterAll(() => helper?.dispose());
afterEach(async () => {
  for (const child of children.splice(0)) await child.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const state = await realpath(await mkdtemp(join(tmpdir(), "localdot-bootstrap-recovery-")));
  roots.push(state);
  return state;
}
async function childAt(state: string) {
  const code = `
    import {writeFile} from 'node:fs/promises';
    import {withBootstrapScratch} from ${JSON.stringify(new URL("./bootstrap-scratch.ts", import.meta.url).href)};
    const guard=setTimeout(()=>process.exit(91),15000);
    await withBootstrapScratch(process.argv[1],new AbortController().signal,async directory=>{
      await writeFile(directory+'/payload','downloaded fixture bytes',{mode:0o600});
      console.log(directory);
      await new Promise(()=>{});
    });
    clearTimeout(guard);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, state], {
    cwd: state,
    env: { PATH: process.env.PATH, PERL5OPT: "-MNonexistentLocaldotInjection" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let text = "",
    errors = "";
  child.stdout.on("data", (bytes: Buffer) => {
    text = (text + bytes.toString()).slice(-8192);
  });
  child.stderr.on("data", (bytes: Buffer) => {
    errors = (errors + bytes.toString()).slice(-8192);
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  };
  children.push({ stop });
  await vi.waitFor(
    () => {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(errors || "bootstrap exited");
      expect(text).toContain("\n");
    },
    { timeout: 5000 },
  );
  const directory = text.trim(),
    nonce = basename(directory).slice(".bootstrap-".length);
  expect(nonce).toMatch(/^[a-f0-9]{32}$/);
  const entry = join(state, "bootstrap-leases", nonce);
  return { directory, nonce, entry, stop, child };
}
async function recover(state: string) {
  await withInstallLock(state, signal(), keydLockAcquirer(helper.path), (lifetime) =>
    recoverBootstrapScratch(state, helper.path, signal(), lifetime),
  );
}

it("preserves two live pre-lock writers, then recovers each exact payload after actual process death", async () => {
  const state = await fixture();
  await writeFile(join(state, "user-data"), "preserve");
  await mkdir(join(state, ".bootstrap-unrecorded"), { mode: 0o700 });
  const a = await childAt(state),
    b = await childAt(state);
  await recover(state);
  expect(await readFile(join(a.directory, "payload"), "utf8")).toBe("downloaded fixture bytes");
  expect(await readFile(join(b.directory, "payload"), "utf8")).toBe("downloaded fixture bytes");
  await a.stop();
  await recover(state);
  await expect(lstat(a.directory)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(a.entry)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await lstat(b.directory)).isDirectory()).toBe(true);
  await b.stop();
  await recover(state);
  expect(await readdir(join(state, "bootstrap-leases"))).toEqual([]);
  expect(await readFile(join(state, "user-data"), "utf8")).toBe("preserve");
  expect((await lstat(join(state, ".bootstrap-unrecorded"))).isDirectory()).toBe(true);
}, 15000);

it.each([
  "replaced-payload",
  "linked-payload",
  "replaced-lock",
  "missing-lock",
  "malformed-record",
  "linked-record",
  "replaced-records",
])("refuses %s without deleting its payload", async (kind) => {
  const state = await fixture(),
    c = await childAt(state);
  await c.stop();
  if (kind === "replaced-payload" || kind === "linked-payload") {
    await rename(c.directory, `${c.directory}-keep`);
    if (kind === "linked-payload") await symlink(`${c.directory}-keep`, c.directory);
    else {
      await mkdir(c.directory, { mode: 0o700 });
      await writeFile(join(c.directory, "payload"), "replacement");
    }
  }
  if (kind === "replaced-lock" || kind === "missing-lock") {
    await rename(join(c.entry, "install.lock"), join(c.entry, "original.lock"));
    if (kind === "replaced-lock")
      await writeFile(join(c.entry, "install.lock"), "", { mode: 0o600 });
  }
  if (kind === "malformed-record") await writeFile(join(c.entry, "ownership.json"), "{}");
  if (kind === "linked-record") {
    await rename(join(c.entry, "ownership.json"), join(c.entry, "original.json"));
    await symlink(join(c.entry, "original.json"), join(c.entry, "ownership.json"));
  }
  if (kind === "replaced-records") {
    const records = join(state, "bootstrap-leases");
    await rename(records, `${records}-old`);
    await mkdir(records, { mode: 0o700 });
    await rename(join(`${records}-old`, c.nonce), c.entry);
  }
  await expect(recover(state)).rejects.toThrow();
  expect(await readFile(join(c.directory, "payload"), "utf8")).toBe(
    kind === "replaced-payload" ? "replacement" : "downloaded fixture bytes",
  );
});

it.each(["partial-payload", "absent-payload"])(
  "finishes interrupted %s removal while retaining the external lease and receipt",
  async (kind) => {
    const state = await fixture(),
      c = await childAt(state);
    await c.stop();
    if (kind === "partial-payload") await rm(join(c.directory, "payload"));
    else await rm(c.directory, { recursive: true });
    await recover(state);
    await expect(lstat(c.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(state, "bootstrap-leases"))).toEqual([]);
  },
);

it("keeps its lease during cancellation until the callback drains and removes only its recorded resources", async () => {
  const state = await fixture(),
    controller = new AbortController();
  let directory = "",
    release!: () => void;
  const drain = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = withBootstrapScratch(state, controller.signal, async (path) => {
    directory = path;
    await writeFile(join(path, "payload"), "preserve until drained");
    await drain;
  }).catch((error) => error);
  try {
    await vi.waitFor(() => expect(directory).not.toBe(""));
    controller.abort(new Error("cancelled fixture"));
    await recover(state);
    expect((await lstat(directory)).isDirectory()).toBe(true);
  } finally {
    release();
  }
  expect(await run).toEqual(new Error("cancelled fixture"));
  expect(await readdir(join(state, "bootstrap-leases"))).toEqual([]);
  await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not adopt an unrecorded allocation or accept an expired global lock", async () => {
  const state = await fixture(),
    nonce = "a".repeat(32);
  await mkdir(join(state, "bootstrap-leases"), { mode: 0o700 });
  await mkdir(join(state, "bootstrap-leases", nonce), { mode: 0o700 });
  await mkdir(join(state, `.bootstrap-${nonce}`), { mode: 0o700 });
  let expired!: InstallLockLifetime;
  await withInstallLock(state, signal(), keydLockAcquirer(helper.path), async (lifetime) => {
    expired = lifetime;
    await recoverBootstrapScratch(state, helper.path, signal(), lifetime);
  });
  expect(await readdir(join(state, "bootstrap-leases"))).toEqual([nonce]);
  await expect(recoverBootstrapScratch(state, helper.path, signal(), expired)).rejects.toThrow();
  expect((await lstat(join(state, `.bootstrap-${nonce}`))).isDirectory()).toBe(true);
});

it("pre-cancellation allocates nothing", async () => {
  const state = await fixture(),
    work = vi.fn();
  await expect(withBootstrapScratch(state, AbortSignal.abort(), work)).rejects.toThrow();
  expect(work).not.toHaveBeenCalled();
  expect(await readdir(state)).toEqual([]);
});
