// Abrupt daemon loss, with a native child that outlives its parent. Uses disposable homes only.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../apps/cli/node_modules/esbuild/lib/main.js";

const helper = process.argv[2];
if (!helper) throw new Error("Usage: node scripts/check-native-recovery.mjs /path/to/new/keyd");
const work = realpathSync(mkdtempSync(join(tmpdir(), "dot-native-crash-")));
try {
  mkdirSync(join(work, "dist"));
  copyFileSync(resolve(helper), join(work, "keyd"));
  chmodSync(join(work, "keyd"), 0o700);
  await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
      import assert from 'node:assert/strict';
      import { spawn } from 'node:child_process';
      import { once } from 'node:events';
      import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { ulid } from './packages/protocol/src/ids.ts';
      import { NativeTasks } from './apps/daemon/src/agent/safety/native-tasks.ts';
      import { ComputerFences } from './apps/daemon/src/agent/safety/fences.ts';
      import { readNativeBoot } from './apps/daemon/src/agent/safety/native-boot.ts';
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const boot = readNativeBoot();
      assert.ok(boot, 'Test requires an OS boot and host identity');
      if (process.argv[2] === 'worker') {
        const [home, cell, session, capture] = process.argv.slice(3);
        const tasks = new NativeTasks(home);
        tasks.spawn(cell, session, () => spawn('/bin/sh', ['-c', 'sleep 6 & exec sleep 1'], {
          detached: true, stdio: ['pipe', 'pipe', 'ignore'],
        }));
        assert.equal(tasks.state(cell, session), 'alive');
        if (capture === 'yes') new ComputerFences(home, () => false, boot).capture(cell, session, 'native');
        console.log('ready');
        setInterval(() => {}, 1000);
      } else {
        for (const capture of ['yes', 'no']) {
          const home = mkdtempSync(join(process.argv[2], 'home-'));
          const cell = ulid(), session = ulid();
          writeFileSync(join(home, 'saved-user-file'), 'preserve this');
          const worker = spawn(process.execPath, [process.argv[1], 'worker', home, cell, session, capture], {
            stdio: ['ignore', 'pipe', 'inherit'],
          });
          const closed = once(worker, 'close');
          await Promise.race([
            once(worker.stdout, 'data').then(([data]) => assert.match(String(data), /ready/)),
            closed.then(() => { throw new Error('Fixture exited before recording its task'); }),
          ]);
          worker.kill('SIGKILL'); // Only the ChildProcess created by this test, never a PID from disk.
          await closed;
          await sleep(1500); // Leader has exited; its child is still alive.
          assert.equal(new NativeTasks(home).state(cell, session), 'alive');
          assert.equal(new ComputerFences(home, () => false, boot).record(cell)?.nativeRetired, false);
          await sleep(5000);
          assert.deepEqual(readNativeBoot(), boot, 'Recovery must work without rebooting');
          const recovered = new ComputerFences(home, () => false, boot);
          assert.equal(recovered.record(cell)?.nativeRetired, true);
          assert.equal(recovered.isFenced(cell), true, 'Replacement must still verify saved computer resources');
          assert.equal(readFileSync(join(home, 'saved-user-file'), 'utf8'), 'preserve this');
          console.log('Passed daemon crash recovery, preexisting fence: ' + capture);
        }
      }
    `,
    },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    define: { __LOCALDOT_PACKAGED__: "true" },
    outfile: join(work, "dist", "check.mjs"),
  });
  execFileSync(process.execPath, [join(work, "dist", "check.mjs"), work], {
    timeout: 25000,
    stdio: "inherit",
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}
