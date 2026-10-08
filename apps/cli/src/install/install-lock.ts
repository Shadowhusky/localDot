import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

export type KernelLockAcquirer = (
  descriptor: number,
  directory: string,
  nonce: string,
  signal: AbortSignal,
) => Promise<void>;

/** Valid only during the awaited install callback. A trusted preparation child inherits the
 * same kernel lock so installer death cannot admit recovery while that child is still alive. */
export interface InstallLockLifetime {
  readonly directory: string;
  inheritDescriptor(): number;
}
const unsafe = () => new Error("Installation lock is unavailable or unsafe.");
function safe(stat: BigIntStats, directory: boolean) {
  return (
    stat.uid === BigInt(process.getuid?.() ?? -1) &&
    (stat.mode & 0o7777n) === (directory ? 0o700n : 0o600n) &&
    (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n && stat.size === 0n)
  );
}

/** The caller must supply a previously verified, code-signed keyd executable from the trusted
 * release. This helper performs no provenance or signature verification itself. It runs only the
 * install-lock subcommand, which applies flock to fd3 without starting keyd or opening its vault.
 * The parent retains the shared open file description after helper exit, including on macOS.
 */
export function keydLockAcquirer(verifiedKeydPath: string): KernelLockAcquirer {
  return helperLockAcquirer(
    verifiedKeydPath,
    (directory, nonce) => ["install-lock", directory, nonce],
    () => new Error("Another installation operation is running."),
  );
}

export class BootstrapLeaseBusy extends Error {
  constructor() {
    super("Another bootstrap still owns this preparation directory.");
  }
}

/** Recovery has an authenticated helper available. This lease is separate from install.lock in
 * the installation state; each concurrent pre-lock acquisition owns its own record directory. */
export function keydBootstrapLeaseAcquirer(verifiedKeydPath: string): KernelLockAcquirer {
  return helperLockAcquirer(
    verifiedKeydPath,
    (directory, nonce) => ["install-lock", directory, nonce],
    () => new BootstrapLeaseBusy(),
  );
}

// Fixed code in the OS interpreter, never code from a downloaded package. The child receives only
// the already-validated empty lock fd and a random receipt nonce, with no Perl environment options.
const BOOTSTRAP_FLOCK = `use strict; use warnings; use Fcntl qw(:flock);
@ARGV == 1 && $ARGV[0] =~ /\\A[0-9a-f]{64}\\z/ or exit 2;
open(my $lock, '+<&=3') or exit 2;
flock($lock, LOCK_EX | LOCK_NB) or exit(($!{EWOULDBLOCK} || $!{EAGAIN}) ? 73 : 2);
print "locked:$ARGV[0]\\n" or exit 2;
`;

/** macOS's protected system Perl supplies flock before a release helper has been acquired.
 * No package executable runs here. The parent retains the shared open file description after
 * interpreter exit. Missing or altered OS tooling refuses acquisition before payload writes. */
export const systemBootstrapLeaseAcquirer: KernelLockAcquirer = async (
  descriptor,
  directory,
  nonce,
  signal,
) => {
  signal.throwIfAborted();
  const path = "/usr/bin/perl";
  const stat = await lstat(path, { bigint: true });
  if (
    process.platform !== "darwin" ||
    !stat.isFile() ||
    stat.uid !== 0n ||
    (stat.mode & 0o022n) !== 0n ||
    (stat.mode & 0o111n) === 0n ||
    (await realpath(path)) !== path
  )
    throw new Error("The protected macOS bootstrap lock utility is unavailable.");
  await helperLockAcquirer(
    path,
    (_directory, receipt) => ["-T", "-e", BOOTSTRAP_FLOCK, receipt],
    () => new BootstrapLeaseBusy(),
  )(descriptor, directory, nonce, signal);
};

/** Acquire the operation directory itself: a lock file would make new canary state nonempty.
 * A surviving canary child retains this shared lease until its actual process exit. */
export function keydCanaryLeaseAcquirer(verifiedKeydPath: string): KernelLockAcquirer {
  return helperLockAcquirer(
    verifiedKeydPath,
    (directory, nonce) => ["canary-lock", directory, nonce],
    () => new Error("A diagnostic gateway still holds its lifetime lease."),
  );
}

export class NativeLeaseBusy extends Error {
  constructor() {
    super("A native supervisor still owns its task resources.");
  }
}
export function keydNativeLeaseAcquirer(verifiedKeydPath: string): KernelLockAcquirer {
  return helperLockAcquirer(
    verifiedKeydPath,
    (directory, nonce) => ["native-lock", directory, nonce],
    () => new NativeLeaseBusy(),
  );
}

export class ServiceLeaseBusy extends Error {
  constructor() {
    super("The managed service still holds its lifetime lease.");
  }
}
export interface ServiceLeaseScope {
  state: string;
  home: string;
  ownerId: string;
  role: "keyd" | "daemon";
}
function serviceLeaseName(scope: ServiceLeaseScope) {
  if (
    !/^[a-f0-9]{32}$/.test(scope.ownerId) ||
    (scope.role !== "keyd" && scope.role !== "daemon") ||
    !isAbsolute(scope.home) ||
    normalize(scope.home) !== scope.home ||
    scope.home === "/"
  )
    throw unsafe();
  return `service-${scope.ownerId}-${scope.role}.lock`;
}

/** Uses an independently verified helper so a damaged installed release cannot prevent cleanup.
 * The caller holds the installation mutex and persists stopping before attempting retirement.
 */
export function keydServiceLeaseAcquirer(
  verifiedKeydPath: string,
  scopeInput: ServiceLeaseScope,
): KernelLockAcquirer {
  const scope = { ...scopeInput };
  serviceLeaseName(scope);
  return helperLockAcquirer(
    verifiedKeydPath,
    (directory, nonce) => {
      if (directory !== scope.state) throw unsafe();
      return ["service-lock", directory, scope.home, scope.ownerId, scope.role, nonce];
    },
    () => new ServiceLeaseBusy(),
  );
}

function helperLockAcquirer(
  verifiedKeydPath: string,
  args: (directory: string, nonce: string) => string[],
  busy: () => Error,
): KernelLockAcquirer {
  if (!isAbsolute(verifiedKeydPath) || normalize(verifiedKeydPath) !== verifiedKeydPath)
    throw unsafe();
  return async (descriptor, directory, nonce, signal) => {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      let output = "",
        received = 0,
        settled = false,
        failure: Error | undefined;
      const child = spawn(verifiedKeydPath, args(directory, nonce), {
        stdio: ["ignore", "pipe", "ignore", descriptor],
        env: { PATH: "/usr/bin:/bin" },
        cwd: "/",
      });
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const stop = (error: Error) => {
        failure = error;
        child.kill("SIGKILL");
      };
      const abort = () => stop(new Error("Installation cancelled."));
      const timeout = setTimeout(() => stop(new Error("Installation lock timed out.")), 5_000);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.stdout?.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > 128) {
          stop(unsafe());
          return;
        }
        output += chunk.toString("utf8");
      });
      child.stdout?.once("error", () => stop(unsafe()));
      // Even an error event must drain through close before the parent's descriptor can close.
      child.once("error", () => {
        failure = unsafe();
      });
      child.once("close", (code, terminationSignal) => {
        if (failure) {
          finish(failure);
          return;
        }
        if (!terminationSignal && code === 73) {
          finish(busy());
          return;
        }
        finish(
          !terminationSignal && code === 0 && output === `locked:${nonce}\n` ? undefined : unsafe(),
        );
      });
    });
    signal.throwIfAborted();
  };
}

/** The lock survives helper exit and is released only after work settles, even on cancellation.
 * Work must await all of its effects before returning. No lock deletion or stale-PID recovery.
 */
export async function withInstallLock<T>(
  directory: string,
  signal: AbortSignal,
  acquire: KernelLockAcquirer,
  work: (lifetime: InstallLockLifetime) => Promise<T>,
): Promise<T> {
  return withNamedLock(directory, "install.lock", signal, acquire, async (descriptor) => {
    let active = true;
    const lifetime = Object.freeze({
      directory,
      inheritDescriptor() {
        if (!active) throw unsafe();
        return descriptor;
      },
    });
    try {
      return await work(lifetime);
    } finally {
      active = false;
    }
  });
}

export async function withServiceLease<T>(
  scopeInput: ServiceLeaseScope,
  signal: AbortSignal,
  acquire: KernelLockAcquirer,
  work: () => Promise<T>,
): Promise<T> {
  const scope = { ...scopeInput };
  return withNamedLock(scope.state, serviceLeaseName(scope), signal, acquire, () => work());
}

async function withNamedLock<T>(
  directory: string,
  name: string,
  signal: AbortSignal,
  acquire: KernelLockAcquirer,
  work: (descriptor: number) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  if (
    !isAbsolute(directory) ||
    normalize(directory) !== directory ||
    directory === "/" ||
    (await realpath(directory)) !== directory
  )
    throw unsafe();
  const parent = await lstat(directory, { bigint: true });
  if (!safe(parent, true)) throw unsafe();
  const file = join(directory, name);
  const handle = await open(
    file,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!safe(before, false)) throw unsafe();
    await acquire(handle.fd, directory, randomBytes(32).toString("hex"), signal);
    signal.throwIfAborted();
    const named = await lstat(file, { bigint: true }),
      after = await lstat(directory, { bigint: true });
    if (
      !safe(named, false) ||
      !safe(after, true) ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      after.dev !== parent.dev ||
      after.ino !== parent.ino
    )
      throw unsafe();
    return await work(handle.fd);
  } finally {
    await handle.close();
  }
}
