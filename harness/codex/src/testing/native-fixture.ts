import assert from "node:assert/strict";
import {
  createReadStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { codexArgs } from "../args.ts";
import { codexEnv } from "../env.ts";
import { prepareCodexHome } from "../home.ts";
import { type InstalledCodex, VerifiedCodexInstaller } from "../install.ts";
import { type CodexProcess, spawnCodex } from "../process.ts";
import { type SandboxPurpose, sandboxSettings } from "../profile.ts";
import {
  createOwnedCodexDirectory,
  type OwnedCodexDirectory,
  type OwnedCodexRoots,
  prepareOwnedCodexRoots,
} from "../roots.ts";
import { codexRelease } from "../version.ts";

// Internal native acceptance only. No application export, real account or ambient executable.
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
let active = false;
function withoutAmbientProxy<T>(work: () => T): T {
  // The real srt CLI starts under codexEnv. Its in-process test equivalent must not resolve
  // an upstream proxy from the Vitest host environment. Srt captures these synchronously.
  const names = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ];
  const previous = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) delete process.env[name];
  try {
    return work();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
export interface NativeProbeResult {
  readonly ok: boolean;
  readonly errno: number;
}
export interface NativeFixture {
  readonly root: string;
  readonly roots: OwnedCodexRoots;
  readonly work: OwnedCodexDirectory;
  readonly mcp: OwnedCodexDirectory;
  readonly installed: InstalledCodex;
  readonly signal: AbortSignal;
  readonly processes: readonly CodexProcess[];
  readonly proxyPorts: readonly number[];
  probe(
    purpose: SandboxPurpose,
    args: readonly string[],
    sandboxed?: boolean,
  ): Promise<NativeProbeResult>;
  authCertificate(): Promise<{ readonly certificate: string; readonly privateKey: string }>;
  proxyRefusal(): Promise<{ readonly unauthenticated: number; readonly forbiddenHost: number }>;
  // Internal fake-TLS test seam: fixed account command/refresh host/CA path only. The caller
  // owns both selected proxy listeners; this does not expose a production launch override.
  account(proxyPorts: readonly [number, number]): Promise<CodexProcess>;
  close(options?: { readonly retain?: boolean }): Promise<void>;
}
async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Owned native fixture deadline.")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function assertListenerRetired(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Owned proxy retirement was not confirmed."));
    }, 1_000);
    socket.once("connect", () => {
      socket.destroy();
      clearTimeout(timer);
      reject(new Error("Owned proxy still accepts connections after retirement."));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve();
      else reject(new Error("Owned proxy retirement was not confirmed."));
    });
  });
}
export async function prepareNativeFixture(archive: string): Promise<NativeFixture> {
  assert.equal(process.platform, "darwin");
  assert.equal(process.arch, "arm64");
  assert.equal(active, false, "Native fixtures cannot share a proxy manager.");
  const root = realpathSync(mkdtempSync("/tmp/ld14-"));
  const original = lstatSync(root);
  active = true;
  const abort = new AbortController();
  const deadline = setTimeout(
    () => abort.abort(new Error("Owned native fixture deadline.")),
    120_000,
  );
  deadline.unref();
  const processes: CodexProcess[] = [];
  let initialized = false,
    initialization: Promise<void> | undefined,
    closePromise: Promise<void> | undefined;
  let proxyPorts: number[] = [];
  const ownedProxyPorts = new Set<number>();
  let retain = false;
  const close = (options: { readonly retain?: boolean } = {}) => {
    // Outer listeners belong to the test suite. Their uncertainty must become sticky before
    // any in-flight retirement can delete private evidence. Still attempt every inner owner.
    retain ||= options.retain === true;
    if (closePromise) return closePromise;
    closePromise = (async () => {
      clearTimeout(deadline);
      abort.abort();
      const errors: unknown[] = [];
      try {
        const retired = await bounded(
          Promise.allSettled(
            processes.map(async (owner) => {
              await owner.stop();
              await owner.closed;
            }),
          ),
          8_000,
        );
        errors.push(
          ...retired.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        );
      } catch (error) {
        errors.push(error);
      }
      if (initialization) {
        try {
          // An initialization timeout cannot race a reset into false cleanup success.
          await bounded(initialization, 5_000);
        } catch (error) {
          errors.push(error);
          void initialization
            .then(
              () => SandboxManager.reset(),
              () => SandboxManager.reset(),
            )
            .catch(() => {});
        }
      }
      if (initialized) {
        try {
          await bounded(SandboxManager.reset(), 5_000);
        } catch (error) {
          errors.push(error);
        }
      }
      for (const port of ownedProxyPorts) {
        try {
          await assertListenerRetired(port);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(errors, "Native fixture ownership was not retired.");
      const current = lstatSync(root);
      assert.ok(current.isDirectory() && !current.isSymbolicLink());
      assert.equal(current.dev, original.dev);
      assert.equal(current.ino, original.ino);
      assert.equal(current.uid, process.getuid?.());
      assert.equal(current.mode & 0o777, 0o700);
      assert.equal(realpathSync(root), root);
      if (!retain) rmSync(root, { recursive: true });
      active = false;
    })();
    void closePromise.catch(() => {});
    return closePromise;
  };
  try {
    const realHome = realpathSync(homedir());
    const roots = prepareOwnedCodexRoots(join(root, "localdot"), realHome);
    const release = codexRelease();
    assert.ok(release);
    const installer = new VerifiedCodexInstaller(roots, release, async (url, signal) => {
      assert.equal(url, release.archive.url);
      return {
        status: 200,
        contentLength: release.archive.compressedBytes,
        body: createReadStream(archive, { signal }),
      };
    });
    const installed = await installer.ensureInstalled(abort.signal);
    assert.deepEqual(await installer.verifiedInstallation(abort.signal), installed);
    prepareCodexHome(roots);
    const work = createOwnedCodexDirectory(roots, "workRoot"),
      mcp = createOwnedCodexDirectory(roots, "runRoot"),
      env = codexEnv({ roots, work, signal: abort.signal });
    const execute = async (command: string, args: readonly string[]) => {
      abort.signal.throwIfAborted();
      let stdout = "",
        stderr = "";
      const owner = spawnCodex({
        command,
        args,
        cwd: work.path,
        env,
        signal: abort.signal,
        register: (process) => {
          processes.push(process);
        },
      });
      const capture = (which: "stdout" | "stderr", chunk: Buffer) => {
        if (which === "stdout") stdout += chunk.toString("utf8");
        else stderr += chunk.toString("utf8");
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 65_536)
          abort.abort(new Error("Native fixture output limit."));
      };
      owner.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
      owner.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));
      owner.stdin?.end();
      await bounded(owner.started, 10_000);
      await bounded(owner.closed, 10_000);
      const outcome = await owner.exited;
      assert.deepEqual(outcome, { code: 0, signal: null }, "The native fixture executable failed.");
      return { stdout, stderr };
    };
    const c = join(work.path, "native-probe.c"),
      binary = join(work.path, "native-probe");
    writeFileSync(c, readFileSync(new URL("./native-probe.c", import.meta.url)), { mode: 0o600 });
    await execute("/usr/bin/cc", ["-Wall", "-Wextra", "-Werror", "-O2", c, "-o", binary]);
    const input = (purpose: SandboxPurpose) => ({
      purpose,
      roots,
      installed,
      work,
      ...(purpose === "task" ? { mcp } : {}),
    });
    initialized = true;
    initialization = withoutAmbientProxy(() =>
      SandboxManager.initialize(sandboxSettings(input("account"))),
    );
    void initialization.catch(() => {});
    await bounded(initialization, 10_000);
    const ports = [...new Set([SandboxManager.getProxyPort(), SandboxManager.getSocksProxyPort()])];
    assert.ok(ports.every((port) => Number.isInteger(port) && (port as number) > 0));
    proxyPorts = ports as number[];
    for (const port of proxyPorts) ownedProxyPorts.add(port);
    const ca = join(work.path, "auth-fixture-ca.pem");
    return {
      root,
      roots,
      work,
      mcp,
      installed,
      signal: abort.signal,
      processes,
      proxyPorts,
      async probe(purpose, args, sandboxed = true) {
        assert.ok(
          args.length > 0 &&
            args.length <= 4 &&
            args.every((arg) => typeof arg === "string" && !arg.includes("\0")),
        );
        const command = [binary, ...args].map(quote).join(" ");
        // The real CLI initializes the full profile for each process. The manager's Unix
        // socket getter uses its current config, rather than the per-command overrides.
        const settings = sandboxSettings(input(purpose));
        if (sandboxed) withoutAmbientProxy(() => SandboxManager.updateConfig(settings));
        const wrapped = sandboxed
          ? await SandboxManager.wrapWithSandboxArgv(
              command,
              "/bin/bash",
              settings,
              abort.signal,
              work.path,
            )
          : { argv: [binary, ...args] };
        // On Mac, proxy env is baked into argv. Never inherit the manager's host environment.
        const output = await execute(wrapped.argv[0] as string, wrapped.argv.slice(1));
        const result: unknown = JSON.parse(output.stdout);
        assert.ok(result && typeof result === "object" && !Array.isArray(result));
        const value = result as Record<string, unknown>;
        assert.deepEqual(Object.keys(value).sort(), ["errno", "ok"]);
        assert.equal(typeof value.ok, "boolean");
        assert.ok(Number.isInteger(value.errno) && (value.errno as number) >= 0);
        return value as unknown as NativeProbeResult;
      },
      async authCertificate() {
        const authority = join(root, "authority");
        mkdirSync(authority, { mode: 0o700 });
        const caKey = join(authority, "ca-key.pem");
        const privateKey = join(authority, "server-key.pem");
        const config = join(authority, "openssl.cnf");
        const csr = join(authority, "server.csr");
        const certificate = join(authority, "server.pem");
        // Acquire both private key targets exclusively; LibreSSL otherwise inherits umask.
        for (const key of [caKey, privateKey]) writeFileSync(key, "", { flag: "wx", mode: 0o600 });
        writeFileSync(
          config,
          [
            "[req]",
            "prompt=no",
            "distinguished_name=dn",
            "[dn]",
            "CN=auth.openai.com",
            "[root_cert]",
            "basicConstraints=critical,CA:TRUE",
            "keyUsage=critical,keyCertSign,cRLSign",
            "[server_cert]",
            "subjectAltName=DNS:auth.openai.com,DNS:chatgpt.com",
            "basicConstraints=critical,CA:FALSE",
            "keyUsage=critical,digitalSignature,keyEncipherment",
            "extendedKeyUsage=serverAuth",
            "",
          ].join("\n"),
          { mode: 0o600 },
        );
        await execute("/usr/bin/openssl", [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-sha256",
          "-days",
          "1",
          "-config",
          config,
          "-extensions",
          "root_cert",
          "-keyout",
          caKey,
          "-out",
          ca,
        ]);
        await execute("/usr/bin/openssl", [
          "req",
          "-new",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-sha256",
          "-config",
          config,
          "-keyout",
          privateKey,
          "-out",
          csr,
        ]);
        await execute("/usr/bin/openssl", [
          "x509",
          "-req",
          "-in",
          csr,
          "-CA",
          ca,
          "-CAkey",
          caKey,
          "-set_serial",
          "1",
          "-days",
          "1",
          "-sha256",
          "-extfile",
          config,
          "-extensions",
          "server_cert",
          "-out",
          certificate,
        ]);
        for (const key of [caKey, privateKey]) assert.equal(lstatSync(key).mode & 0o777, 0o600);
        assert.ok(readFileSync(ca).byteLength <= 8192);
        return { certificate, privateKey };
      },
      async proxyRefusal() {
        const token = SandboxManager.getProxyAuthToken(),
          port = SandboxManager.getProxyPort();
        assert.ok(token && port && ownedProxyPorts.has(port));
        const connect = (authenticated: boolean) =>
          bounded(
            new Promise<number>((resolve, reject) => {
              const req = request({
                host: "127.0.0.1",
                port,
                method: "CONNECT",
                path: "127.0.0.1:1",
                headers: authenticated
                  ? {
                      "proxy-authorization": `Basic ${Buffer.from(`srt:${token}`).toString("base64")}`,
                    }
                  : {},
                signal: abort.signal,
              });
              req.once("connect", (response, socket) => {
                socket.destroy();
                resolve(response.statusCode ?? 0);
              });
              req.once("response", (response) => {
                response.resume();
                resolve(response.statusCode ?? 0);
              });
              req.once("error", () => reject(new Error("Owned proxy request failed.")));
              req.end();
            }),
            5_000,
          );
        return { unauthenticated: await connect(false), forbiddenHost: await connect(true) };
      },
      async account(ports) {
        assert.ok(
          ports.length === 2 &&
            ports.every((port) => Number.isInteger(port) && port > 0 && port <= 65535),
        );
        abort.signal.throwIfAborted();
        await bounded(SandboxManager.reset(), 5_000);
        for (const port of ownedProxyPorts) await assertListenerRetired(port);
        const settings = sandboxSettings(input("account"));
        const fixtureSettings = {
          ...settings,
          network: { ...settings.network, httpProxyPort: ports[0], socksProxyPort: ports[1] },
        };
        initialization = withoutAmbientProxy(() => SandboxManager.initialize(fixtureSettings));
        void initialization.catch(() => {});
        await bounded(initialization, 10_000);
        assert.equal(SandboxManager.getProxyPort(), ports[0]);
        assert.equal(SandboxManager.getSocksProxyPort(), ports[1]);
        assert.deepEqual(await installer.verifiedInstallation(abort.signal), installed);
        const certificate = lstatSync(ca);
        assert.ok(certificate.isFile() && !certificate.isSymbolicLink() && certificate.nlink === 1);
        assert.equal(certificate.uid, process.getuid?.());
        assert.equal(realpathSync(ca), ca);
        const command = [
          installed.codexBin,
          "app-server",
          "--listen",
          "stdio://",
          ...codexArgs(input("account")),
        ]
          .map(quote)
          .join(" ");
        const wrapped = await SandboxManager.wrapWithSandboxArgv(
          command,
          "/bin/bash",
          fixtureSettings,
          abort.signal,
          work.path,
        );
        return spawnCodex({
          command: wrapped.argv[0] as string,
          args: wrapped.argv.slice(1),
          cwd: work.path,
          env: {
            ...codexEnv({ roots, work, signal: abort.signal }),
            CODEX_CA_CERTIFICATE: ca,
            CODEX_REFRESH_TOKEN_URL_OVERRIDE: "https://auth.openai.com/oauth/token",
          },
          signal: abort.signal,
          register: (owner) => {
            processes.push(owner);
          },
        });
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Native fixture preparation failed.");
    }
    throw error;
  }
}
