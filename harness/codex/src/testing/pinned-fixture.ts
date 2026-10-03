import assert from "node:assert/strict";
import {
  createReadStream,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { codexArgs } from "../args.ts";
import { codexEnv } from "../env.ts";
import { prepareCodexHome } from "../home.ts";
import { type InstalledCodex, sha256File, VerifiedCodexInstaller } from "../install.ts";
import { type CodexProcess, spawnCodex } from "../process.ts";
import {
  assertOwnedCodexDirectory,
  createOwnedCodexDirectory,
  type OwnedCodexDirectory,
  type OwnedCodexRoots,
  prepareOwnedCodexRoots,
} from "../roots.ts";
import { codexRelease } from "../version.ts";

// Internal offline acceptance helper. No application export or arbitrary command/env seam.
// Tests supply a local archive, which the production streaming installer fully re-verifies.
export interface PinnedFixture {
  readonly root: string;
  readonly fakeHome: string;
  readonly roots: OwnedCodexRoots;
  readonly work: OwnedCodexDirectory;
  readonly installed: InstalledCodex;
  readonly signal: AbortSignal;
  readonly processes: readonly CodexProcess[];
  verify(signal?: AbortSignal): Promise<void>;
  schema(): { process: CodexProcess; directory: string };
  appServer(input: {
    readonly purpose: "account" | "task";
    readonly base: string;
    readonly mcp?: OwnedCodexDirectory;
    readonly signal?: AbortSignal;
    readonly register?: (process: CodexProcess) => void;
  }): CodexProcess;
  close(options?: { readonly retain?: boolean }): Promise<void>;
}

function policy(fakeHome: string, port?: number, socket?: string): string {
  const actualHome = realpathSync(homedir());
  const deny = [fakeHome, actualHome, `/System/Volumes/Data${actualHome}`];
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    ...(port ? [`(allow network-outbound (remote ip "localhost:${port}"))`] : []),
    ...(socket
      ? [`(allow network-outbound (remote unix-socket (subpath ${JSON.stringify(socket)})))`]
      : []),
    `(deny file-read* file-write* ${deny.map((path) => `(subpath ${JSON.stringify(path)})`).join(" ")})`,
  ].join("\n");
}

export async function preparePinnedFixture(archive: string): Promise<PinnedFixture> {
  // This suite verifies pinned protocol behavior on this host. Other platforms must provide
  // their own real constrained runner; an unavailable runner cannot count as passing acceptance.
  assert.equal(process.platform, "darwin", "Offline confinement is unverified on this platform.");
  assert.equal(process.arch, "arm64");
  assert.ok(isAbsolute(archive), "The exact local release archive is required.");
  const root = realpathSync(mkdtempSync("/tmp/ld13-"));
  const abort = new AbortController();
  const deadline = setTimeout(
    () => abort.abort(new Error("Owned offline fixture deadline.")),
    60_000,
  );
  deadline.unref();
  const processes: CodexProcess[] = [];
  let retainRoot = false;
  let closePromise: Promise<void> | undefined;
  try {
    const fakeHome = join(root, "user");
    mkdirSync(join(fakeHome, ".codex"), { recursive: true, mode: 0o700 });
    writeFileSync(join(fakeHome, ".codex", "auth.json"), "Inert user-home sentinel", {
      mode: 0o600,
    });
    const roots = prepareOwnedCodexRoots(join(root, "localdot"), fakeHome);
    const release = codexRelease();
    assert.ok(release);
    const installer = new VerifiedCodexInstaller(roots, release, async (url, signal) => {
      assert.equal(url, release.archive.url);
      signal.throwIfAborted();
      return {
        status: 200,
        contentLength: release.archive.compressedBytes,
        body: createReadStream(archive, { signal }),
      };
    });
    const installed = await installer.ensureInstalled(abort.signal);
    assert.deepEqual(await installer.verifiedInstallation(abort.signal), installed);
    for (const binary of release.binaries)
      assert.equal(
        await sha256File(join(installed.binDir, binary.installedName), abort.signal),
        binary.sha256,
      );
    prepareCodexHome(roots);
    const work = createOwnedCodexDirectory(roots, "workRoot");
    const spawn = (
      args: readonly string[],
      opts: {
        port?: number;
        socket?: string;
        signal?: AbortSignal;
        register?: (process: CodexProcess) => void;
        base?: string;
      } = {},
    ) =>
      spawnCodex({
        command: "/usr/bin/sandbox-exec",
        args: ["-p", policy(fakeHome, opts.port, opts.socket), installed.codexBin, ...args],
        cwd: work.path,
        env: {
          ...codexEnv({ roots, work, signal: abort.signal }),
          ...(opts.base ? { CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${opts.base}/oauth/token` } : {}),
        },
        signal: AbortSignal.any([abort.signal, ...(opts.signal ? [opts.signal] : [])]),
        register: (owner) => {
          processes.push(owner);
          opts.register?.(owner);
        },
      });
    return {
      root,
      fakeHome,
      roots,
      work,
      installed,
      signal: abort.signal,
      processes,
      async verify(signal = abort.signal) {
        assert.deepEqual(await installer.verifiedInstallation(signal), installed);
      },
      schema() {
        const directory = join(work.path, "schema");
        mkdirSync(directory, { mode: 0o700 });
        const process = spawn(["app-server", "generate-json-schema", "--out", directory]);
        process.stdin?.end();
        return { process, directory };
      },
      appServer(input) {
        const base = new URL(input.base);
        assert.equal(base.protocol, "http:");
        assert.equal(base.hostname, "127.0.0.1");
        assert.equal(base.pathname, "/");
        assert.equal(base.username + base.password + base.search + base.hash, "");
        const port = Number(base.port);
        assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
        if (input.mcp) assertOwnedCodexDirectory(roots, input.mcp, "runRoot");
        return spawn(
          [
            "app-server",
            "--listen",
            "stdio://",
            ...codexArgs({
              purpose: input.purpose,
              roots,
              installed,
              work,
              ...(input.mcp ? { mcp: input.mcp } : {}),
            }),
            "-c",
            `chatgpt_base_url="${base.origin}/backend-api/"`,
            "-c",
            `openai_base_url="${base.origin}/backend-api/codex"`,
          ],
          {
            port,
            base: base.origin,
            signal: input.signal,
            register: input.register,
            ...(input.mcp ? { socket: join(input.mcp.path, "m.sock") } : {}),
          },
        );
      },
      close(options) {
        retainRoot ||= options?.retain === true;
        closePromise ??= (async () => {
          clearTimeout(deadline);
          abort.abort(new Error("Owned offline fixture closed."));
          const errors: unknown[] = [];
          for (const owner of [...processes].reverse()) {
            try {
              await owner.stop();
              await owner.closed;
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length)
            throw new AggregateError(
              errors,
              "Offline process ownership is unconfirmed; private fixture retained.",
            );
          if (!retainRoot) rmSync(root, { recursive: true });
        })();
        return closePromise;
      },
    };
  } catch (error) {
    clearTimeout(deadline);
    assert.equal(processes.length, 0);
    rmSync(root, { recursive: true });
    throw error;
  }
}
