import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runVerificationWorker } from "./verification-worker-host.ts";

const dirs: string[] = [];
const versions = Object.fromEntries(
  ["root", "timestamp", "snapshot", "targets"].map((role) => [
    role,
    { version: 1, sha256: "a".repeat(64) },
  ]),
);
async function worker(code: string) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "localdot-trust-worker-test-")));
  dirs.push(dir);
  const file = join(dir, "fixture.mjs");
  await writeFile(file, `import {parentPort,workerData} from 'node:worker_threads';\n${code}`);
  return { dir, entry: pathToFileURL(file) };
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("returns only after a real worker posts one valid result and exits with a clean environment", async () => {
  const { entry } = await worker(
    `if(Object.keys(process.env).length) throw Error('ambient env'); parentPort.postMessage({ok:true,versions:workerData});`,
  );
  await expect(
    runVerificationWorker(entry, versions, new AbortController().signal),
  ).resolves.toEqual(versions);
});
for (const code of [
  "process.exit(0)",
  "throw Error('candidate-secret')",
  "parentPort.postMessage({ok:false})",
  "parentPort.postMessage({ok:true,versions:{}})",
  "parentPort.postMessage({ok:true,versions:workerData});parentPort.postMessage({ok:true,versions:workerData})",
  "process.stdout.write('x'.repeat(5000));parentPort.postMessage({ok:true,versions:workerData})",
]) {
  it(`refuses a failed, malformed or noisy worker: ${code.slice(0, 35)}`, async () => {
    const { entry } = await worker(code);
    await expect(
      runVerificationWorker(entry, versions, new AbortController().signal),
    ).rejects.toThrow(/^Release trust verification failed or timed out\.$/);
  });
}
it("terminates a CPU-stuck worker after its deadline even if it already posted success", async () => {
  const { entry } = await worker(
    "parentPort.postMessage({ok:true,versions:workerData});while(true){}",
  );
  await expect(
    runVerificationWorker(entry, versions, new AbortController().signal, 100),
  ).rejects.toThrow("timed out");
});
it("drains a cancelled worker before returning and preserves the caller's reason", async () => {
  const { entry, dir } = await worker(
    "import{writeFileSync}from'node:fs';writeFileSync(workerData,'started');setTimeout(()=>writeFileSync(workerData,'late-write'),5000);setInterval(()=>{},1000);",
  );
  const path = join(dir, "witness");
  const controller = new AbortController();
  const reason = new Error("cancel verification");
  const running = runVerificationWorker(entry, path, controller.signal);
  const observed = running.catch((error) => error);
  // Wait for a concrete worker witness, bounded independently from the cancellation under test.
  const until = Date.now() + 2000;
  while (true) {
    try {
      await readFile(path);
      break;
    } catch {
      if (Date.now() > until) throw new Error("worker never started");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  controller.abort(reason);
  expect(await observed).toBe(reason);
  expect(await readFile(path, "utf8")).toBe("started");
  // The host settled on the actual exit event; removing owned storage is now safe.
  await rm(dir, { recursive: true, force: true });
});
