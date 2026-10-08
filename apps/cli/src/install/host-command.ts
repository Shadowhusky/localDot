import { spawn } from "node:child_process";

type HostCommand =
  | Readonly<{ kind: "macos" }>
  | Readonly<{ kind: "docker-context"; env: NodeJS.ProcessEnv }>;

const failed = () => new Error("Host prerequisite command failed.");

/** Fixed read-only prerequisite commands, never a shell or caller-provided executable/argv.
 * A timeout or cancellation kills only this child and remains pending until actual close.
 * No output, environment or subprocess error text is exposed through failures.
 */
export async function readHostCommand(input: HostCommand, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (input.kind !== "macos" && input.kind !== "docker-context") throw failed();
  const docker = input.kind === "docker-context";
  const env: NodeJS.ProcessEnv = docker ? { ...input.env } : { PATH: "/usr/bin:/bin", LC_ALL: "C" };
  const context = docker ? env.DOCKER_CONTEXT : undefined;
  if (
    context !== undefined &&
    (context.length > 256 ||
      [...context].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ))
  )
    throw failed();
  const limit = docker ? 64 * 1024 : 4096;
  const command = docker ? "docker" : "/usr/bin/sw_vers";
  const args = docker ? ["context", "inspect", ...(context ? [context] : [])] : ["-productVersion"];
  const child = (() => {
    try {
      return spawn(command, args, {
        env,
        cwd: "/",
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
    } catch {
      throw failed();
    }
  })();
  return new Promise<string>((resolve, reject) => {
    let failure: Error | undefined;
    let stopping = false;
    let spawned = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const stop = (error: Error) => {
      failure ??= error;
      if (stopping) return;
      stopping = true;
      // The fixed commands do not launch owned task trees. Do not signal a remembered PID or
      // unrelated group, and never treat kill's return value as evidence of process retirement.
      try {
        child.kill("SIGKILL");
      } catch {
        failure = failed();
      }
    };
    const abort = () => stop(failed());
    const timer = setTimeout(() => stop(failed()), 2500);
    child.once("spawn", () => {
      spawned = true;
    });
    child.once("error", (error) => {
      const unavailable =
        docker && !spawned && child.pid === undefined && "code" in error && error.code === "ENOENT";
      const safe = failed();
      if (unavailable) Object.assign(safe, { code: "ENOENT" });
      stop(safe);
    });
    const collect = (chunk: Buffer, stdout: boolean) => {
      if (failure) return;
      if (!Buffer.isBuffer(chunk)) {
        stop(failed());
        return;
      }
      bytes += chunk.length;
      if (bytes > limit) {
        stop(failed());
        return;
      }
      if (stdout && chunk.length) chunks.push(Buffer.from(chunk));
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
    child.stdout.once("error", () => stop(failed()));
    child.stderr.once("error", () => stop(failed()));
    // exit/EOF/abort/error can precede descriptor closure. Only close permits settlement.
    child.once("close", (code, terminationSignal) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (failure || signal.aborted || code !== 0 || terminationSignal) {
        reject(failure ?? failed());
        return;
      }
      try {
        resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      } catch {
        reject(failed());
      }
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
