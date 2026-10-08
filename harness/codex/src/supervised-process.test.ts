import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { CodexProcess, SpawnCodexInput } from "./process.ts";
import { spawnSupervisedCodex } from "./supervised-process.ts";

const binary = process.env.LOCALDOT_NATIVE_SUPERVISOR_TEST_BIN;
const live = it.skipIf(process.platform !== "darwin" || !binary);
live("does not inherit helper control descriptors into the native task", async () => {
  const p = spawnSupervisedCodex(
    {
      command: "/usr/bin/python3",
      args: [
        "-c",
        `
import os,json
fds=[]
for fd in range(3,64):
 try: os.fstat(fd); fds.append(fd)
 except OSError: pass
print(json.dumps(fds))
`,
      ],
      cwd: "/private/tmp",
      env: {},
      signal: new AbortController().signal,
      register: () => {},
    },
    binary as string,
  );
  let output = "";
  p.stdout?.on("data", (b) => {
    output += b;
  });
  await p.started;
  await p.closed;
  expect(JSON.parse(output)).toEqual([]);
});
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
const until = async (work: () => boolean | Promise<boolean>, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (!(await work())) {
    if (Date.now() > deadline) throw new Error("fixture condition did not complete");
    await new Promise((yes) => setTimeout(yes, 10));
  }
};
async function fixture(code: string) {
  const cwd = await mkdtemp(join(tmpdir(), "localdot-native-transport-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  let registered: CodexProcess | undefined;
  const input: SpawnCodexInput = {
    command: process.execPath,
    args: ["-e", code],
    cwd,
    env: {},
    signal: new AbortController().signal,
    register: (p) => {
      registered = p;
    },
  };
  const p = spawnSupervisedCodex(input, binary ?? "/missing-supervisor");
  cleanups.push(() => p.stop().catch(() => {}));
  expect(registered).toBe(p);
  return { p, cwd };
}

live("passes real Node stdio through the helper and preserves natural exit status", async () => {
  const { p } = await fixture(
    "let b='';process.stdin.on('data',s=>b+=s);process.stdin.on('end',()=>{process.stdout.write(b);process.exitCode=7})",
  );
  let output = "";
  p.stdout?.on("data", (b) => {
    output += b;
  });
  await p.started;
  expect(p.pid).toBeGreaterThan(1);
  p.stdin?.end("private fixture text\n");
  await expect(p.exited).resolves.toEqual({ code: 7, signal: null });
  await p.closed;
  expect(output).toBe("private fixture text\n");
});

live("Stop retires a TERM-ignoring child and drains the real pipe handles", async () => {
  const { p } = await fixture(
    "process.on('SIGTERM',()=>{});console.log('ready');setTimeout(()=>{console.log('watchdog');process.exit(90)},10000)",
  );
  let output = "";
  p.stdout?.on("data", (b) => {
    output += b;
  });
  await p.started;
  await until(() => output.includes("ready\n"));
  const stop = p.stop();
  expect(p.stop()).toBe(stop);
  await stop;
  await expect(p.exited).resolves.toEqual({ code: null, signal: "SIGKILL" });
  await p.closed;
  expect(output).toBe("ready\n");
});

live(
  "refuses a bad command before starting a task and can release its empty transport",
  async () => {
    const { p } = await fixture("");
    // A separate request with a relative command is rejected by the native side, not a mock.
    await p.started;
    await p.stop();
    const other = spawnSupervisedCodex(
      {
        command: "relative",
        args: [],
        cwd: process.cwd(),
        env: {},
        signal: new AbortController().signal,
        register: () => {},
      },
      binary as string,
    );
    await expect(other.started).rejects.toMatchObject({ code: "process_startup_failed" });
    await other.closed;
    await other.stop();
  },
);

it("registers before spawn and cancellation in registration prevents allocation", async () => {
  let spawned = false;
  const p = spawnSupervisedCodex(
    {
      command: "/unused",
      args: [],
      cwd: "/tmp",
      env: {},
      signal: new AbortController().signal,
      register: (p) => {
        void p.stop();
      },
      spawnImpl: (() => {
        spawned = true;
        throw new Error();
      }) as SpawnCodexInput["spawnImpl"],
    },
    "/unused-helper",
  );
  await expect(p.started).rejects.toMatchObject({ code: "cancelled" });
  await p.closed;
  expect(spawned).toBe(false);
});

live("does not accept helper exit without a native retirement record", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "localdot-false-helper-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const helper = join(cwd, "helper");
  await writeFile(helper, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const p = spawnSupervisedCodex(
    {
      command: process.execPath,
      args: [],
      cwd,
      env: {},
      signal: new AbortController().signal,
      register: () => {},
    },
    helper,
  );
  let closed = false;
  void p.closed.then(() => {
    closed = true;
  });
  await expect(p.started).rejects.toMatchObject({ code: "process_startup_failed" });
  await expect(p.failure).resolves.toMatchObject({ code: "process_shutdown_failed" });
  await expect(p.stop()).rejects.toMatchObject({ code: "process_shutdown_failed" });
  expect(closed).toBe(false);
});

live(
  "a real daemon SIGKILL leaves the independent supervisor to retire its task",
  async () => {
    const { spawn } = await import("node:child_process");
    const cwd = await mkdtemp(join(tmpdir(), "localdot-supervisor-crash-"));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));
    const proof = join(cwd, "proof.json"),
      childCode =
        "process.on('SIGTERM',()=>{});console.log('ready');setTimeout(()=>{console.log('watchdog');process.exit(90)},10000)";
    const fixture = join(cwd, "parent.mjs");
    // Parent imports the production TS adapter using Node's built-in type stripping. It alone owns
    // the lifetime writer. After killing it, observe the exact child until it has been reaped.
    await writeFile(
      fixture,
      `
import {writeFileSync} from 'node:fs';
import {spawnSupervisedCodex} from ${JSON.stringify(new URL("./supervised-process.ts", import.meta.url).href)};
const p=spawnSupervisedCodex({command:process.execPath,args:['-e',${JSON.stringify(childCode)}],cwd:${JSON.stringify(cwd)},env:{},signal:new AbortController().signal,register:()=>{}},${JSON.stringify(binary)});
p.stdout.pipe(process.stdout);p.stderr.resume();
await p.started;writeFileSync(${JSON.stringify(proof)},JSON.stringify({pid:p.pid}));
`,
    );
    const parent = spawn(process.execPath, ["--experimental-transform-types", fixture], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {},
    });
    cleanups.push(async () => {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    });
    let output = "",
      errors = "";
    parent.stdout.on("data", (b) => {
      output += b;
    });
    parent.stderr.on("data", (b) => {
      errors += b;
    });
    await until(() => output.includes("ready\n") || parent.exitCode !== null);
    expect(output).toBe("ready\n");
    const { pid } = JSON.parse(await readFile(proof, "utf8"));
    const exit = new Promise((resolve) => parent.once("exit", resolve));
    parent.kill("SIGKILL");
    await exit;
    // An independent OS observation checks the exact task born in this test becomes absent.
    // It never signals that PID. A ten-second fixture watchdog would fail this five-second check.
    const gone = () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ESRCH";
      }
    };
    try {
      await until(gone);
    } finally {
      // Drain even a mutation failure: its fixture watchdog must finish before removing the home.
      await until(gone, 12000);
    }
    expect(output).not.toContain("watchdog");
    expect(errors).not.toContain("Error:");
  },
  20000,
);
