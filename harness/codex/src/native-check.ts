import { randomBytes } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { type AcceptanceHost, canonicalDigest } from "./acceptance.ts";
import { srtCli, verifiedSettingsPath } from "./args.ts";
import { codexEnv } from "./env.ts";
import { prepareCodexHome } from "./home.ts";
import type { InstalledCodex } from "./install.ts";
import { harnessAvailability } from "./launch.ts";
import { spawnCodex } from "./process.ts";
import {
  CODEX_HOME_DENY_WRITE,
  type SandboxInput,
  sandboxSettings,
  writeSettingsFile,
} from "./profile.ts";
import {
  createOwnedCodexDirectory,
  type OwnedCodexDirectory,
  type OwnedCodexRoots,
  ownedCodexRealHome,
  PRIVATE_CREATE_FLAGS,
  removeOwnedCodexDirectory,
} from "./roots.ts";

export class NativeCheckError extends Error {
  constructor(readonly probe?: string) {
    super("ChatGPT support didn't pass its safety check on this Mac.");
    this.name = "NativeCheckError";
  }
}
const PERL = "/usr/bin/perl";
const NESTED = "/usr/bin/sandbox-exec";
const SYSTEM_VERSION = "/System/Library/CoreServices/SystemVersion.plist";
const DATA = "/System/Volumes/Data";
const DENIED = [1, 13];
const OUTPUT_LIMIT = 64 * 1024;
const RUN_MS = 20_000;
export const PROBE_SECRETS = Object.freeze([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "LOCALDOT_INSTALL_TOKEN",
  "HTTP_PROXY_AUTH",
  "GITHUB_TOKEN",
]);
// Run with the system Perl inside the real sandbox. It reports outcomes and error numbers, never
// file contents or environment values. Plain runs only ask whether a write would be allowed.
export const PROBE_SCRIPT = String.raw`use strict;
use warnings;
use Socket qw(AF_INET AF_INET6 AF_UNIX SOCK_STREAM inet_aton inet_pton pack_sockaddr_in pack_sockaddr_in6 pack_sockaddr_un);
use MIME::Base64 qw(encode_base64);
use File::Basename qw(dirname);
open(STDERR, ">", "/dev/null");
$| = 1;
my $plain = shift(@ARGV) eq "plain";
my %arity = (read => 1, write => 1, directory => 1, unix => 1, connect => 2, bind => 2, environment => 2, nested => 0, proxy => 0);
sub result { my ($ok, $errno) = @_; print(($ok ? "ok" : "no") . " " . ($errno // 0) . "\n"); }
sub socket_for {
  my ($host, $port) = @_;
  my $v6 = index($host, ":") >= 0;
  socket(my $s, $v6 ? AF_INET6 : AF_INET, SOCK_STREAM, 0) or return (undef, $! + 0);
  my $address = $v6 ? pack_sockaddr_in6($port, inet_pton(AF_INET6, $host)) : pack_sockaddr_in($port, inet_aton($host));
  return ($s, 0, $address);
}
sub status_of {
  my ($port, $auth) = @_;
  my ($s, $e, $address) = socket_for("127.0.0.1", $port);
  return 0 unless $s && connect($s, $address);
  syswrite($s, "CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n" . ($auth ? "Proxy-Authorization: Basic $auth\r\n" : "") . "\r\n");
  my $line = "";
  local $SIG{ALRM} = sub { die "timeout\n" };
  alarm 5;
  eval { while ($line !~ /\n/) { my $n = sysread($s, my $chunk, 256); last unless $n; $line .= $chunk; } };
  alarm 0;
  close($s);
  return $line =~ m{^HTTP/1\.[01] (\d{3})} ? $1 + 0 : 0;
}
while (@ARGV) {
  my $op = shift(@ARGV);
  die "unknown probe\n" unless exists $arity{$op};
  my @a = splice(@ARGV, 0, $arity{$op});
  if ($op eq "read") {
    if (open(my $f, "<", $a[0])) { my $n = sysread($f, my $b, 1); result(defined $n, defined $n ? 0 : $! + 0); close($f); }
    else { result(0, $! + 0); }
  } elsif ($op eq "write") {
    if ($plain) { result(-e $a[0] ? -w $a[0] : -w dirname($a[0]), 0); }
    elsif (sysopen(my $f, $a[0], 0x0001 | 0x0008 | 0x0200, 0600)) { my $n = syswrite($f, ""); result(defined $n, defined $n ? 0 : $! + 0); close($f); }
    else { result(0, $! + 0); }
  } elsif ($op eq "directory") {
    if (opendir(my $d, $a[0])) { $! = 0; my @entries = readdir($d); result($! + 0 == 0, $! + 0); closedir($d); }
    else { result(0, $! + 0); }
  } elsif ($op eq "unix") {
    socket(my $s, AF_UNIX, SOCK_STREAM, 0) or do { result(0, $! + 0); next; };
    if (connect($s, pack_sockaddr_un($a[0]))) { result(1, 0); } else { result(0, $! + 0); }
    close($s);
  } elsif ($op eq "connect" || $op eq "bind") {
    my ($s, $e, $address) = socket_for(@a);
    unless ($s) { result(0, $e); next; }
    my $ok = $op eq "connect" ? connect($s, $address) : (bind($s, $address) && listen($s, 1));
    result($ok, $ok ? 0 : $! + 0);
    close($s);
  } elsif ($op eq "environment") {
    my $clean = !grep { exists $ENV{$_} } split(/,/, $a[1]);
    result($clean && defined $ENV{CODEX_HOME} && $ENV{CODEX_HOME} eq $a[0], 0);
  } elsif ($op eq "nested") {
    my $status = system("${NESTED}", "-p", "(version 1)(allow default)", "/usr/bin/true");
    result($status == 0, $status == 0 ? 0 : 1);
  } elsif ($op eq "proxy") {
    my ($user, $pass, $port) = ($ENV{HTTPS_PROXY} // "") =~ m{^http://([^:@/]+):([^@/]+)@(?:localhost|127\.0\.0\.1):(\d+)$};
    unless ($port) { result(0, 0); next; }
    my $open = status_of($port, "");
    my $foreign = status_of($port, encode_base64("$user:$pass", ""));
    result($open == 407 && $foreign == 403, $open * 1000 + $foreign);
  }
}
`;
export type ProbePurpose = "task" | "account";
export interface Probe {
  readonly purpose: ProbePurpose;
  readonly op:
    | "read"
    | "write"
    | "directory"
    | "unix"
    | "connect"
    | "bind"
    | "environment"
    | "nested"
    | "proxy";
  readonly args: readonly string[];
  // allow and deny also need the same operation to work outside the sandbox.
  readonly expect: "allow" | "deny" | "proxy";
}
export interface ProbeOutcome {
  readonly ok: boolean;
  readonly errno: number;
}
export interface ProbeContext {
  readonly home: string;
  readonly realHome: string;
  readonly userCodex?: string;
  readonly work: string;
  readonly canary: string;
  readonly marker: string;
  readonly ownSocket: string;
  readonly foreignSocket: string;
  readonly tcpPort: number;
  spellings(path: string): readonly string[];
}
// The native acceptance suite's properties, in the form this Mac can check by itself.
export function probePlan(c: ProbeContext): readonly Probe[] {
  const probe = (
    purpose: ProbePurpose,
    op: Probe["op"],
    args: readonly (string | number)[],
    expect: Probe["expect"],
  ): Probe => ({ purpose, op, args: args.map(String), expect });
  const secrets = PROBE_SECRETS.join(",");
  const task: Probe[] = [
    probe("task", "read", [join(c.home, "config.toml")], "allow"),
    probe("task", "write", [join(c.home, "config.toml")], "deny"),
    probe("task", "write", [join(c.home, `.localdot-check-${c.marker}`)], "allow"),
    probe("task", "write", [join(c.work, "tmp", `.localdot-check-${c.marker}`)], "allow"),
    ...c.spellings(c.realHome).map((path) => probe("task", "directory", [path], "deny")),
    ...(c.userCodex ? [probe("task", "directory", [c.userCodex], "deny")] : []),
    probe("task", "directory", ["/Volumes"], "deny"),
    ...c
      .spellings(c.canary)
      .flatMap((path) => [
        probe("task", "read", [path], "deny"),
        probe("task", "write", [path], "deny"),
      ]),
    probe("task", "unix", [c.ownSocket], "allow"),
    probe("task", "unix", [c.foreignSocket], "deny"),
    probe("task", "connect", ["127.0.0.1", c.tcpPort], "deny"),
    probe("task", "bind", ["127.0.0.1", 0], "deny"),
    probe("task", "bind", ["::1", 0], "deny"),
    probe("task", "environment", [c.home, secrets], "allow"),
    probe("task", "nested", [], "deny"),
    probe("task", "proxy", [], "proxy"),
  ];
  const account: Probe[] = [
    ...CODEX_HOME_DENY_WRITE.map((name) => probe("account", "write", [join(c.home, name)], "deny")),
    ...c.spellings(c.realHome).map((path) => probe("account", "directory", [path], "deny")),
    probe("account", "connect", ["127.0.0.1", c.tcpPort], "deny"),
    probe("account", "bind", ["127.0.0.1", 0], "deny"),
    probe("account", "environment", [c.home, secrets], "allow"),
    probe("account", "nested", [], "deny"),
    probe("account", "proxy", [], "proxy"),
  ];
  return [...task, ...account];
}
export function probeArgs(probes: readonly Probe[]): string[] {
  return probes.flatMap((probe) => [probe.op, ...probe.args]);
}
export function parseOutcomes(output: string, count: number): ProbeOutcome[] {
  const lines = output.split("\n");
  if (lines.pop() !== "" || lines.length !== count) throw new NativeCheckError("output");
  return lines.map((line) => {
    const match = /^(ok|no) (0|[1-9][0-9]{0,6})$/.exec(line);
    if (!match) throw new NativeCheckError("output");
    return { ok: match[1] === "ok", errno: Number(match[2]) };
  });
}
// Every allowed and denied probe also works outside the sandbox, so a denial is the sandbox's.
export function verifyProbes(
  probes: readonly Probe[],
  plain: readonly ProbeOutcome[],
  sandboxed: readonly ProbeOutcome[],
): { purpose: ProbePurpose; op: string; expect: string; errno: number }[] {
  const controls = probes.filter((probe) => probe.expect !== "proxy");
  if (plain.length !== controls.length || sandboxed.length !== probes.length)
    throw new NativeCheckError("output");
  controls.forEach((probe, index) => {
    if (!plain[index]?.ok) throw new NativeCheckError(`${probe.purpose} ${probe.op} control`);
  });
  return probes.map((probe, index) => {
    const outcome = sandboxed[index] as ProbeOutcome;
    const held =
      probe.expect === "deny"
        ? !outcome.ok && DENIED.includes(outcome.errno)
        : outcome.ok && (probe.expect === "proxy" ? outcome.errno === 407403 : outcome.errno === 0);
    if (!held) throw new NativeCheckError(`${probe.purpose} ${probe.op}`);
    return { purpose: probe.purpose, op: probe.op, expect: probe.expect, errno: outcome.errno };
  });
}

function systemTool(path: string): void {
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== 0 ||
    (info.mode & 0o022) !== 0 ||
    realpathSync(path) !== path
  )
    throw new NativeCheckError("tools");
  accessSync(path, constants.X_OK);
}
const LABEL = /^[A-Za-z0-9._-]{1,64}$/;
// The macOS build and sandbox runtime this check speaks for; either changing means checking again.
export function checkHost(): AcceptanceHost {
  try {
    const plist = readFileSync(SYSTEM_VERSION, "utf8");
    const system = /<key>ProductBuildVersion<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];
    const runtime: unknown = createRequire(srtCli())("../package.json").version;
    if (!system || !LABEL.test(system) || typeof runtime !== "string" || !LABEL.test(runtime))
      throw new Error();
    return Object.freeze({ system, runtime });
  } catch {
    throw new NativeCheckError("host");
  }
}
function spellings(path: string): readonly string[] {
  const alias = `${DATA}${path}`;
  try {
    const a = lstatSync(path),
      b = lstatSync(alias);
    return a.dev === b.dev && a.ino === b.ino ? [path, alias] : [path];
  } catch {
    return [path];
  }
}
function listen(target: string | number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      socket.on("error", () => {});
      socket.end();
    });
    server.once("error", reject);
    if (typeof target === "number") server.listen(target, "127.0.0.1", () => resolve(server));
    else server.listen(target, () => resolve(server));
  });
}
async function execute(
  command: string,
  args: readonly string[],
  work: OwnedCodexDirectory,
  env: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<string> {
  let output = "",
    size = 0;
  const owner = spawnCodex({ command, args, cwd: work.path, env, signal, register: () => {} });
  owner.stdout?.on("data", (chunk: Buffer) => {
    size += chunk.byteLength;
    if (size > OUTPUT_LIMIT) void owner.stop().catch(() => {});
    else output += chunk.toString("utf8");
  });
  owner.stderr?.resume();
  owner.stdin?.end();
  const timer = setTimeout(() => void owner.stop().catch(() => {}), RUN_MS);
  try {
    await owner.started;
    await owner.closed;
    const exit = await owner.exited;
    if (exit.code !== 0 || exit.signal !== null || size > OUTPUT_LIMIT)
      throw new NativeCheckError("run");
    return output;
  } catch (error) {
    if (error instanceof NativeCheckError) throw error;
    throw new NativeCheckError("run");
  } finally {
    clearTimeout(timer);
  }
}
function writePrivate(path: string, content: string): void {
  const fd = openSync(path, PRIVATE_CREATE_FLAGS, 0o600);
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
}
function removeOwnedFile(path: string): void {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.())
      throw new NativeCheckError("cleanup");
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
export interface NativeCheckInput {
  readonly roots: OwnedCodexRoots;
  readonly installed: InstalledCodex;
  readonly signal: AbortSignal;
}
// Runs the probes through the same sandbox runtime, settings and environment Codex runs under.
// No Codex process runs: callers keep every Codex launch closed until this has passed.
export async function checkNativeSandbox(
  input: NativeCheckInput,
): Promise<{ readonly host: AcceptanceHost; readonly reportSha256: string }> {
  const { roots, installed, signal } = input;
  if (!harnessAvailability().available || process.platform !== "darwin")
    throw new NativeCheckError("platform");
  for (const tool of [PERL, NESTED]) systemTool(tool);
  const host = checkHost();
  const marker = randomBytes(8).toString("hex"),
    canary = join(roots.root, `.localdot-check-${marker}`),
    servers: Server[] = [],
    directories: OwnedCodexDirectory[] = [];
  let failure: unknown;
  let report: ReturnType<typeof verifyProbes> | undefined;
  try {
    signal.throwIfAborted();
    prepareCodexHome(roots);
    const realHome = ownedCodexRealHome(roots);
    const work = createOwnedCodexDirectory(roots, "workRoot");
    directories.push(work);
    const mcp = createOwnedCodexDirectory(roots, "runRoot");
    directories.push(mcp);
    const foreign = createOwnedCodexDirectory(roots, "runRoot");
    directories.push(foreign);
    const env = codexEnv({ roots, work, signal });
    const script = join(work.path, "probe.pl");
    writePrivate(script, PROBE_SCRIPT);
    writePrivate(canary, "localdot-check");
    const ownSocket = join(mcp.path, "m.sock"),
      foreignSocket = join(foreign.path, "m.sock");
    servers.push(await listen(ownSocket), await listen(foreignSocket));
    const tcp = await listen(0);
    servers.push(tcp);
    const address = tcp.address();
    if (!address || typeof address === "string") throw new NativeCheckError("listener");
    const userCodex = join(realHome, ".codex");
    const probes = probePlan({
      home: roots.home,
      realHome,
      ...(exists(userCodex) ? { userCodex } : {}),
      work: work.path,
      canary,
      marker,
      ownSocket,
      foreignSocket,
      tcpPort: address.port,
      spellings,
    });
    if (probes.some((probe) => probe.args.some((arg) => arg.includes("\0"))))
      throw new NativeCheckError("plan");
    const controls = probes.filter((probe) => probe.expect !== "proxy");
    const plain = parseOutcomes(
      await execute(PERL, [script, "plain", ...probeArgs(controls)], work, env, signal),
      controls.length,
    );
    const sandboxed: ProbeOutcome[] = [];
    for (const purpose of ["task", "account"] as const) {
      const group = probes.filter((probe) => probe.purpose === purpose);
      const sandbox: SandboxInput = {
        purpose,
        roots,
        installed,
        work,
        ...(purpose === "task" ? { mcp } : {}),
      };
      const profile = await writeSettingsFile(roots, sandboxSettings(sandbox));
      directories.push(profile.directory);
      const settings = verifiedSettingsPath({ sandbox, profile });
      sandboxed.push(
        ...parseOutcomes(
          await execute(
            process.execPath,
            [
              srtCli(),
              "--settings",
              settings,
              "--",
              PERL,
              script,
              "sandboxed",
              ...probeArgs(group),
            ],
            work,
            env,
            signal,
          ),
          group.length,
        ),
      );
    }
    report = verifyProbes(probes, plain, sandboxed);
  } catch (error) {
    failure = error;
  }
  const cleanup: unknown[] = [];
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const directory of directories.reverse())
    await removeOwnedCodexDirectory(directory).catch((error: unknown) => cleanup.push(error));
  for (const path of [canary, join(roots.home, `.localdot-check-${marker}`)])
    try {
      removeOwnedFile(path);
    } catch (error) {
      cleanup.push(error);
    }
  try {
    prepareCodexHome(roots);
  } catch (error) {
    cleanup.push(error);
  }
  if (failure instanceof NativeCheckError) throw failure;
  if (failure || cleanup.length || !report)
    throw new NativeCheckError(signal.aborted ? "cancelled" : cleanup.length ? "cleanup" : "run");
  return { host, reportSha256: canonicalDigest({ host, report }) };
}
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
