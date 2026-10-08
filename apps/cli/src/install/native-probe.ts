import { spawn } from "node:child_process";
import { dirname } from "node:path";
import type { InstallLockLifetime } from "./install-lock.ts";

const PROGRAM = `const {Worker}=require('node:worker_threads');
// Arm a separate thread before loading native code: a blocked main thread or dead installer
// must not disable the child deadline and retain the shared installation lock indefinitely.
const watchdog=new Worker(\`const {parentPort}=require('node:worker_threads');
 setTimeout(()=>process.kill(process.pid,'SIGKILL'),15000);
 parentPort.postMessage('armed');\`,{eval:true,env:{},execArgv:[]});
watchdog.on('error',()=>process.exit(1));
(async () => {
 await new Promise(resolve=>watchdog.once('message',resolve));
 const sharp = require(process.argv[1] + '/sharp');
 const png = await sharp({create:{width:2,height:2,channels:4,background:{r:17,g:34,b:51,alpha:1}}}).png().toBuffer();
 const {data,info} = await sharp(png).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const expected = Buffer.from(Array(4).fill([17,34,51,255]).flat());
 if(info.width!==2 || info.height!==2 || info.channels!==4 || !data.equals(expected)) throw new Error('pixel mismatch');
 process.stdout.write(JSON.stringify({sharp:sharp.versions.sharp,vips:sharp.versions.vips,width:2,height:2,channels:4})+'\\n');
})().catch(() => {process.exitCode=1;}).finally(()=>watchdog.terminate());`;

/** Call only after locked archive/file verification. Loading this native module executes trusted
 * dependency code. It never reads a user image; cancellation waits for actual child closure.
 */
export function probeNativeDependencies(
  root: string,
  version: string,
  signal: AbortSignal,
  lifetime?: InstallLockLifetime,
): Promise<{ sharp: string; vips: string }> {
  signal.throwIfAborted();
  // Resolve the live descriptor immediately before synchronous spawn. Never retain this number
  // for a later launch: it may be reused once the parent leaves its install-lock callback.
  const descriptor = lifetime?.inheritDescriptor();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", PROGRAM, root], {
      cwd: dirname(root),
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: dirname(root),
        TMPDIR: dirname(root),
        SHARP_IGNORE_GLOBAL_LIBVIPS: "1",
      },
      stdio:
        descriptor === undefined
          ? ["ignore", "pipe", "pipe"]
          : ["ignore", "pipe", "pipe", descriptor],
    });
    let failed = false,
      bytes = 0;
    const chunks: Buffer[] = [];
    const stop = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, 15000);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const collect = (chunk: Buffer, stdout: boolean) => {
      bytes += chunk.length;
      if (bytes > 16384) {
        stop();
        return;
      }
      if (stdout) chunks.push(chunk);
    };
    child.stdout?.on("data", (chunk) => collect(chunk, true));
    child.stderr?.on("data", (chunk) => collect(chunk, false));
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      try {
        if (failed || code !== 0) throw new Error();
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (
          result.sharp !== version ||
          typeof result.vips !== "string" ||
          !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(result.vips) ||
          result.width !== 2 ||
          result.height !== 2 ||
          result.channels !== 4
        )
          throw new Error();
        resolve({ sharp: result.sharp, vips: result.vips });
      } catch {
        reject(new Error("The verified native image runtime did not pass its health check."));
      }
    });
  });
}
