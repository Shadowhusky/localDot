import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const installer = join(repo, "install.sh");

// Real tools the installer may use; everything else it calls is a stub that records its arguments.
const REAL = [
  "awk",
  "basename",
  "bash",
  "cat",
  "chmod",
  "cmp",
  "cp",
  "cut",
  "date",
  "dirname",
  "env",
  "find",
  "git",
  "grep",
  "gzip",
  "head",
  "id",
  "ln",
  "ls",
  "mkdir",
  "mktemp",
  "mv",
  "perl",
  "readlink",
  "rm",
  "rmdir",
  "sed",
  "sh",
  "shasum",
  "sha256sum",
  "sleep",
  "sort",
  "tail",
  "tar",
  "tee",
  "touch",
  "tr",
  "wc",
  "xargs",
];

const roots = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function which(tool) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, tool))) return join(dir, tool);
  }
  return undefined;
}

function script(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

const logged = (name) => `printf '%s\\n' "${name} $*" >> "$STUB_LOG"`;

function freePort() {
  return new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

// A source repository like localDot's, where every build step is a stub.
function makeOrigin(root) {
  const origin = join(root, "origin");
  mkdirSync(origin, { recursive: true });
  copyFileSync(installer, join(origin, "install.sh"));
  writeFileSync(join(origin, "package.json"), '{ "packageManager": "pnpm@10.29.3" }\n');
  mkdirSync(join(origin, "keyd"), { recursive: true });
  writeFileSync(join(origin, "keyd/go.mod"), "module example\n\ngo 1.27\n\ntoolchain go1.27.1\n");
  for (const role of ["gate", "brain", "desktop", "browser"])
    script(
      join(origin, `cells/${role}/build.sh`),
      `printf '%s\\n' "build ${role}" >> "$STUB_LOG"\ntouch "$STUB_STATE/image-${role}"`,
    );
  mkdirSync(join(origin, "apps/daemon"), { recursive: true });
  writeFileSync(join(origin, "apps/daemon/.keep"), "");
  git(origin, "init", "--quiet", "--initial-branch=main");
  git(origin, "add", ".");
  git(origin, "commit", "--quiet", "-m", "first");
  return origin;
}

async function makeHost({ os = "linux", machine, release, prefix: within } = {}) {
  const root = mkdtempSync(join(tmpdir(), "localdot-install-"));
  roots.push(root);
  const home = join(root, "home");
  const stubs = join(root, "stubs");
  const real = join(root, "real");
  const state = join(root, "state");
  const downloads = join(root, "downloads");
  const log = join(root, "calls.log");
  for (const dir of [home, stubs, real, state, downloads]) mkdirSync(dir, { recursive: true });
  writeFileSync(log, "");
  for (const tool of REAL) {
    const path = which(tool);
    if (path) symlinkSync(path, join(real, tool));
  }
  const prefix = join(home, within ?? ".local/share/localdot");
  const kernel = os === "macos" ? "Darwin" : "Linux";
  const arch = machine ?? (os === "macos" ? "arm64" : "x86_64");
  const nodePlatform = `${os === "macos" ? "darwin" : "linux"}-${arch === "x86_64" ? "x64" : "arm64"}`;
  const nodeBin = join(prefix, `runtime/node-v24.21.0-${nodePlatform}/bin`);

  script(
    join(stubs, "uname"),
    'case "$1" in -s) echo "$STUB_KERNEL" ;; -m) echo "$STUB_MACHINE" ;; -r) echo "$STUB_RELEASE" ;; esac',
  );
  script(join(stubs, "sysctl"), `echo "\${STUB_TRANSLATED:-0}"`);
  script(join(stubs, "ldd"), `echo "\${STUB_LDD:-ldd (GNU libc) 2.39}"`);
  script(
    join(stubs, "docker"),
    `${logged("docker")}
case "$1" in
info)
  case "$STUB_DOCKER" in
  ok) echo "\${STUB_DOCKER_VERSION:-29.2.0}" ;;
  denied) echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1 ;;
  *) echo "Cannot connect to the Docker daemon. Is the docker daemon running?" >&2; exit 1 ;;
  esac ;;
image) role=\${3#localdot/}; [ -f "$STUB_STATE/image-\${role%:dev}" ] ;;
pull) [ -n "\${STUB_PULL_OK:-}" ] ;;
tag) role=\${3#localdot/}; touch "$STUB_STATE/image-\${role%:dev}" ;;
esac`,
  );
  script(
    join(stubs, "systemctl"),
    `${logged("systemctl")}\n[ "$*" != "--user show-environment" ] || exit "\${STUB_SYSTEMD_RC:-0}"`,
  );
  script(
    join(stubs, "loginctl"),
    `${logged("loginctl")}\ncase "$1" in show-user) echo "\${STUB_LINGER:-no}" ;; esac`,
  );
  script(
    join(stubs, "launchctl"),
    `${logged("launchctl")}
case "$1" in
print) [ -f "$STUB_STATE/loaded-\${2##*/}" ] ;;
bootstrap) label=\${3##*/}; touch "$STUB_STATE/loaded-\${label%.plist}" ;;
bootout) rm -f "$STUB_STATE/loaded-\${2##*/}" ;;
esac`,
  );
  script(
    join(stubs, "curl"),
    `for arg; do url=$arg; done
previous=""
for arg; do [ "$previous" != -o ] || out=$arg; previous=$arg; done
case "$url" in http://127.0.0.1:*) exit 0 ;; esac
${logged("curl")}
[ -f "$STUB_DOWNLOADS/\${url##*/}" ] || exit 22
cp "$STUB_DOWNLOADS/\${url##*/}" "$out"`,
  );
  script(
    join(stubs, "tailscale"),
    `${logged("tailscale")}
case "$1" in
status) cat "$STUB_STATE/tailscale-status.json" ;;
serve) [ -z "\${STUB_SERVE_ERROR:-}" ] || { echo "$STUB_SERVE_ERROR" >&2; exit 1; } ;;
esac`,
  );
  for (const opener of ["open", "xdg-open", "explorer.exe", "apt-get"])
    script(join(stubs, opener), logged(opener));

  script(
    join(nodeBin, "node"),
    `[ "$1" != --version ] || { echo v24.21.0; exit 0; }
printf '%s\\n' "node $* | cwd=$PWD | home=$LOCALDOT_HOME | port=$LOCALDOT_PORT | origin=$LOCALDOT_PUBLIC_ORIGIN" >> "$STUB_LOG"
case "$*" in
*" open"*)
  echo "http://127.0.0.1:$LOCALDOT_PORT/#code=fakecode"
  [ -z "$LOCALDOT_PUBLIC_ORIGIN" ] || echo "From your other devices: $LOCALDOT_PUBLIC_ORIGIN/#code=fakecode"
  case "$*" in *--qr*) echo "[qr code]" ;; esac ;;
*" doctor"*) echo "ok   docker"; exit "\${STUB_DOCTOR_RC:-0}" ;;
esac`,
  );
  script(
    join(nodeBin, "corepack"),
    `${logged("corepack")}
script_dir=$3
mkdir -p "$script_dir"
cat > "$script_dir/pnpm" <<'PNPM'
#!/bin/bash
printf '%s\\n' "pnpm $*" >> "$STUB_LOG"
case "$*" in *"@localdot/web build"*) mkdir -p apps/web/dist && touch apps/web/dist/index.html ;; esac
PNPM
chmod 755 "$script_dir/pnpm"`,
  );
  script(
    join(prefix, "runtime/go1.27.1/bin/go"),
    `[ "$1" != version ] || { echo "go version go1.27.1 linux/amd64"; exit 0; }
${logged("go")}
previous=""
for arg; do [ "$previous" != -o ] || out=$arg; previous=$arg; done
# Like Go, stamp the checkout's commit into the binary unless told not to.
case " $* " in *" -buildvcs=false "*) stamp="" ;; *) stamp=$(git rev-parse HEAD) ;; esac
echo "keyd build \${STUB_KEYD_BUILD:-1} $stamp" > "$out"
chmod 755 "$out"`,
  );

  const origin = makeOrigin(root);
  const port = await freePort();
  const env = {
    HOME: home,
    PATH: `${stubs}:${real}`,
    LANG: "C",
    STUB_LOG: log,
    STUB_STATE: state,
    STUB_DOWNLOADS: downloads,
    STUB_KERNEL: kernel,
    STUB_MACHINE: arch,
    STUB_RELEASE:
      release ?? (os === "wsl" ? "5.15.167.4-microsoft-standard-WSL2" : "6.8.0-45-generic"),
    STUB_DOCKER: "ok",
  };

  const host = {
    root,
    home,
    prefix,
    origin,
    port,
    env,
    stubs,
    state,
    downloads,
    unit: (name) => join(home, ".config/systemd/user", name),
    plist: (label) => join(home, "Library/LaunchAgents", `${label}.plist`),
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    clearCalls: () => writeFileSync(log, ""),
    run(args = [], extra = {}) {
      return runBash([installer, "--repo", origin, "--port", String(port), ...args], {
        ...env,
        ...extra,
      });
    },
    command(args = [], extra = {}) {
      return runBash([join(prefix, "bin/localdot"), ...args], { ...env, ...extra }, "/bin/sh");
    },
    commit(message) {
      writeFileSync(join(origin, "CHANGES"), `${message}\n`);
      git(origin, "add", ".");
      git(origin, "commit", "--quiet", "-m", message);
    },
  };
  return host;
}

// Detached, so the installer has no controlling terminal, as under a service or in CI.
function runBash(args, env, shell = "/bin/bash") {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, args, {
      env,
      cwd: env.HOME,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe.concurrent("which machines it installs on", { timeout: 60_000 }, () => {
  it.each([
    [{ STUB_KERNEL: "MINGW64_NT-10.0-26100" }, "run install.ps1"],
    [{ STUB_RELEASE: "4.4.0-19041-Microsoft" }, "WSL 1"],
    [{ STUB_LDD: "musl libc (x86_64)" }, "musl"],
    [{ STUB_MACHINE: "i686" }, "64-bit"],
  ])("refuses %o with a way forward", async (extra, words) => {
    const host = await makeHost();
    const result = await host.run([], extra);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(words);
    expect(existsSync(`${host.prefix}/app`)).toBe(false);
  });

  it("refuses to install as root", async () => {
    const host = await makeHost();
    script(join(host.stubs, "id"), '[ "$1" = -u ] && echo 0 || echo root');
    const result = await host.run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not as root");
  });

  it("uses the Apple silicon runtime under Rosetta", async () => {
    const host = await makeHost({ os: "macos", machine: "x86_64" });
    rmSync(join(host.prefix, "runtime"), { recursive: true });
    const result = await host.run([], { STUB_TRANSLATED: "1" });
    expect(result.code).toBe(1);
    expect(host.calls()).toContain(
      "curl -fsSL --retry 3 -o " +
        join(host.prefix, "runtime/.download/archive.tar.gz") +
        " https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz",
    );
  });
});

describe.concurrent("prerequisites", { timeout: 60_000 }, () => {
  it("lists everything missing at once, with this machine's commands, before downloading", async () => {
    const host = await makeHost();
    rmSync(join(host.root, "real/git"));
    rmSync(join(host.stubs, "docker"));
    const result = await host.run([], { STUB_SYSTEMD_RC: "1" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("localDot needs a few things first:");
    expect(result.stderr).toContain("sudo apt-get update && sudo apt-get install -y git");
    expect(result.stderr).toContain("curl -fsSL https://get.docker.com | sudo sh");
    expect(result.stderr).toContain("sudo loginctl enable-linger");
    expect(host.calls().filter((call) => call.startsWith("curl"))).toEqual([]);
  });

  it.each([
    ["denied", {}, "sudo usermod -aG docker"],
    ["stopped", {}, "sudo systemctl enable --now docker"],
    ["ok", { STUB_DOCKER_VERSION: "27.5.1" }, "Docker Engine 28 or newer. This one is 27.5.1"],
  ])("explains Docker that is %s", async (docker, extra, words) => {
    const host = await makeHost();
    const result = await host.run([], { STUB_DOCKER: docker, ...extra });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(words);
  });

  it("asks a Mac to start Docker Desktop", async () => {
    const host = await makeHost({ os: "macos" });
    const result = await host.run([], { STUB_DOCKER: "stopped" });
    expect(result.stderr).toContain("Start Docker Desktop");
  });

  it("shows WSL how to turn on systemd", async () => {
    const host = await makeHost({ os: "wsl" });
    const result = await host.run([], { STUB_SYSTEMD_RC: "1" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("/etc/wsl.conf");
    expect(result.stderr).toContain("systemd=true");
    expect(result.stderr).toContain("wsl --shutdown");
  });

  it("refuses a port something else is using", async () => {
    const host = await makeHost();
    const server = createServer().listen(host.port, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const result = await host.run();
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`Something else is using port ${host.port}`);
    } finally {
      server.close();
    }
  });

  it("refuses a service it did not make, before building anything", async () => {
    const host = await makeHost();
    mkdirSync(dirname(host.unit("localdot-daemon.service")), { recursive: true });
    writeFileSync(host.unit("localdot-daemon.service"), "[Service]\nExecStart=/elsewhere\n");
    const result = await host.run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("was not made by this installer");
    expect(readFileSync(host.unit("localdot-daemon.service"), "utf8")).toContain("/elsewhere");
    expect(host.calls()).toEqual([]);
  });

  it("verifies downloads against the pinned checksum", async () => {
    const host = await makeHost();
    rmSync(join(host.prefix, "runtime"), { recursive: true });
    writeFileSync(join(host.downloads, "node-v24.21.0-linux-x64.tar.gz"), "not node");
    const result = await host.run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("doesn't match its pinned checksum");
    expect(existsSync(join(host.prefix, "runtime/node-v24.21.0-linux-x64"))).toBe(false);
    expect(existsSync(join(host.prefix, "runtime/.download"))).toBe(false);
  });
});

describe.concurrent("installing on Linux", { timeout: 60_000 }, () => {
  it("builds, starts user services, checks and prints a link with a way in from elsewhere", async () => {
    const host = await makeHost();
    const result = await host.run();
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const app = join(host.prefix, "app");
    const node = join(host.prefix, "runtime/node-v24.21.0-linux-x64/bin/node");
    const daemon = readFileSync(host.unit("localdot-daemon.service"), "utf8");
    expect(daemon).toContain("# Managed by localDot's install.sh");
    expect(daemon).toContain(`WorkingDirectory=${app}/apps/daemon`);
    expect(daemon).toContain(`ExecStart="${node}" "--import" "tsx" "src/main.ts"`);
    // The daemon exits 128 + SIGTERM when systemd stops it.
    expect(daemon).toContain("SuccessExitStatus=143\n");
    expect(daemon).toContain(`Environment="LOCALDOT_HOME=${host.home}/.localdot"`);
    expect(daemon).toContain(`Environment="LOCALDOT_PORT=${host.port}"`);
    expect(daemon).not.toContain("LOCALDOT_PUBLIC_ORIGIN");
    expect(daemon).toContain(`StandardOutput=append:${host.home}/.localdot/logs/daemon.log`);
    const keyd = readFileSync(host.unit("localdot-keyd.service"), "utf8");
    expect(keyd).toContain(
      `ExecStart="${host.prefix}/bin/keyd" "-home" "${host.home}/.localdot"\n`,
    );
    const calls = host.calls();
    const order = (prefix) => calls.findIndex((call) => call.startsWith(prefix));
    expect(calls.filter((call) => call.startsWith("build ")).map((call) => call.slice(6))).toEqual([
      "gate",
      "brain",
      "desktop",
      "browser",
    ]);
    expect(calls).toContain(
      "pnpm install --frozen-lockfile --config.confirmModulesPurge=false --store-dir " +
        join(host.prefix, "runtime/pnpm-store"),
    );
    expect(calls).toContain(
      "systemctl --user enable --quiet localdot-keyd.service localdot-daemon.service",
    );
    expect(calls).toContain(
      `loginctl enable-linger ${execFileSync("id", ["-un"]).toString().trim()}`,
    );
    expect(order("systemctl --user restart localdot-daemon.service")).toBeGreaterThan(
      order("build browser"),
    );
    expect(order("node --import tsx ../cli/src/main.ts doctor")).toBeGreaterThan(
      order("systemctl --user restart localdot-daemon.service"),
    );
    expect(
      calls.some((call) => call.startsWith("node --import tsx ../cli/src/main.ts open |")),
    ).toBe(true);
    expect(result.stdout).toContain(`ssh -N -L ${host.port}:127.0.0.1:${host.port}`);
    expect(result.stdout).toContain(`http://127.0.0.1:${host.port}/#code=fakecode`);
    expect(readlinkSync(join(host.home, ".local/bin/localdot"))).toBe(
      join(host.prefix, "bin/localdot"),
    );
    const recorded = readFileSync(join(host.prefix, "install.env"), "utf8");
    expect(recorded).toContain(`LOCALDOT_COMMIT="${git(host.origin, "rev-parse", "HEAD")}"`);
    expect(recorded).toContain(`LOCALDOT_PORT="${host.port}"`);
  });

  it("changes nothing when run again without a new version", async () => {
    const host = await makeHost();
    expect((await host.run()).code).toBe(0);
    const unit = readFileSync(host.unit("localdot-daemon.service"), "utf8");
    host.clearCalls();
    const again = await host.run();
    expect(again.code).toBe(0);
    const calls = host.calls();
    expect(calls.filter((call) => /^(pnpm|go|build|corepack) /.test(call))).toEqual([]);
    expect(calls.filter((call) => call.includes("restart"))).toEqual([]);
    expect(calls).toContain("systemctl --user start localdot-daemon.service");
    expect(readFileSync(host.unit("localdot-daemon.service"), "utf8")).toBe(unit);
  });

  it("upgrades to a new version, restarting only what changed", async () => {
    const host = await makeHost();
    expect((await host.run()).code).toBe(0);
    host.commit("second");
    host.clearCalls();
    const upgrade = await host.run();
    expect(upgrade.code).toBe(0);
    const calls = host.calls();
    expect(calls.filter((call) => call.startsWith("build ")).length).toBe(4);
    expect(calls).toContain("systemctl --user restart localdot-daemon.service");
    expect(calls).toContain("systemctl --user start localdot-keyd.service");
    expect(readFileSync(join(host.prefix, "install.env"), "utf8")).toContain(
      `LOCALDOT_COMMIT="${git(host.origin, "rev-parse", "HEAD")}"`,
    );
  });

  it("restarts the key service when it was rebuilt differently", async () => {
    const host = await makeHost();
    expect((await host.run()).code).toBe(0);
    host.commit("second");
    host.clearCalls();
    expect((await host.run([], { STUB_KEYD_BUILD: "2" })).code).toBe(0);
    expect(host.calls()).toContain("systemctl --user restart localdot-keyd.service");
  });

  it("keeps recorded settings on an upgrade unless an option changes them", async () => {
    const host = await makeHost();
    expect((await host.run(["--home", join(host.home, "data")])).code).toBe(0);
    expect((await host.run([], { LOCALDOT_HOME: join(host.home, "elsewhere") })).code).toBe(0);
    expect(readFileSync(host.unit("localdot-daemon.service"), "utf8")).toContain(
      `LOCALDOT_HOME=${host.home}/data"`,
    );
  });

  it("keeps saved keys in a passphrase vault when asked, and remembers it", async () => {
    const host = await makeHost();
    expect((await host.run(["--passphrase-vault"])).code).toBe(0);
    const unit = () => readFileSync(host.unit("localdot-keyd.service"), "utf8");
    expect(unit()).toContain(
      `ExecStart="${host.prefix}/bin/keyd" "-home" "${host.home}/.localdot" "-vault" "passphrase"\n`,
    );
    expect(readFileSync(join(host.prefix, "install.env"), "utf8")).toContain(
      'LOCALDOT_VAULT="passphrase"',
    );
    host.commit("second");
    expect((await host.command(["update"])).code).toBe(0);
    expect(unit()).toContain('"-vault" "passphrase"');
  });

  it("refuses to overwrite a checkout someone changed", async () => {
    const host = await makeHost();
    expect((await host.run()).code).toBe(0);
    writeFileSync(join(host.prefix, "app/package.json"), "{}\n");
    const result = await host.run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("were changed by hand");
  });

  it("pulls published images for the exact version when a registry is given", async () => {
    const host = await makeHost();
    const result = await host.run(["--registry", "ghcr.io/example"], { STUB_PULL_OK: "1" });
    expect(result.code).toBe(0);
    const commit = git(host.origin, "rev-parse", "HEAD");
    const calls = host.calls();
    expect(calls).toContain(`docker pull ghcr.io/example/localdot-desktop:${commit}`);
    expect(calls).toContain(
      `docker tag ghcr.io/example/localdot-desktop:${commit} localdot/desktop:dev`,
    );
    expect(calls.filter((call) => call.startsWith("build "))).toEqual([]);
  });

  it("builds an image whose published copy is missing", async () => {
    const host = await makeHost();
    expect((await host.run(["--registry", "ghcr.io/example"])).code).toBe(0);
    expect(host.calls().filter((call) => call.startsWith("build ")).length).toBe(4);
  });

  it("warns when the services would stop at sign-out", async () => {
    const host = await makeHost();
    script(join(host.stubs, "loginctl"), 'case "$1" in show-user) echo no ;; *) exit 1 ;; esac');
    const result = await host.run();
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("sudo loginctl enable-linger");
  });

  it("says so when the checks fail, and still prints the link", async () => {
    const host = await makeHost();
    const result = await host.run([], { STUB_DOCTOR_RC: "1" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Some checks failed");
    expect(result.stdout).toContain("#code=fakecode");
  });
});

describe.concurrent("remote access through Tailscale", { timeout: 60_000 }, () => {
  const running = (domains) =>
    JSON.stringify(
      { BackendState: "Running", Self: { DNSName: "box.example.ts.net." }, CertDomains: domains },
      null,
      2,
    );

  it("serves the app on the tailnet only and draws a QR code for the phone", async () => {
    const host = await makeHost();
    writeFileSync(join(host.state, "tailscale-status.json"), running(["box.example.ts.net"]));
    const result = await host.run(["--tailscale"], { SSH_CONNECTION: "10.0.0.2 5555 10.0.0.1 22" });
    expect(result.code).toBe(0);
    const origin = `https://box.example.ts.net:${host.port}`;
    const calls = host.calls();
    expect(calls).toContain(
      `tailscale serve --bg --https=${host.port} http://127.0.0.1:${host.port}`,
    );
    expect(calls.some((call) => call.includes("funnel"))).toBe(false);
    expect(readFileSync(host.unit("localdot-daemon.service"), "utf8")).toContain(
      `Environment="LOCALDOT_PUBLIC_ORIGIN=${origin}"`,
    );
    expect(result.stdout).toContain(`From your other devices: ${origin}/#code=fakecode`);
    expect(result.stdout).toContain("[qr code]");
    host.clearCalls();
    const link = await host.command(["open", "--qr"]);
    expect(link.code).toBe(0);
    expect(host.calls()[0]).toContain(`../cli/src/main.ts open --qr |`);
    expect(host.calls()[0]).toContain(`origin=${origin}`);
  });

  it("asks for HTTPS certificates when the tailnet has none", async () => {
    const host = await makeHost();
    writeFileSync(join(host.state, "tailscale-status.json"), running([]));
    const result = await host.run(["--tailscale"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("HTTPS Certificates");
  });

  it("explains the operator permission Linux needs", async () => {
    const host = await makeHost();
    writeFileSync(join(host.state, "tailscale-status.json"), running(["box.example.ts.net"]));
    const result = await host.run(["--tailscale"], {
      STUB_SERVE_ERROR: "Access denied: serve config denied",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("sudo tailscale set --operator=");
  });

  it("stops serving with --no-tailscale", async () => {
    const host = await makeHost();
    writeFileSync(join(host.state, "tailscale-status.json"), running(["box.example.ts.net"]));
    expect((await host.run(["--tailscale"])).code).toBe(0);
    host.clearCalls();
    expect((await host.run(["--no-tailscale"])).code).toBe(0);
    expect(host.calls()).toContain(`tailscale serve --https=${host.port} off`);
    expect(readFileSync(host.unit("localdot-daemon.service"), "utf8")).not.toContain(
      "LOCALDOT_PUBLIC_ORIGIN",
    );
  });
});

describe.concurrent("installing on macOS", { timeout: 60_000 }, () => {
  it("writes LaunchAgents with a passphrase vault and opens the browser", async () => {
    const host = await makeHost({ os: "macos" });
    const result = await host.run();
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const keyd = readFileSync(host.plist("dev.localdot.keyd"), "utf8");
    expect(keyd).toContain("<!-- Managed by localDot's install.sh -->");
    expect(keyd).toContain(
      `<string>${host.prefix}/bin/keyd</string>\n    <string>-home</string>\n    <string>${host.home}/.localdot</string>\n    <string>-vault</string>\n    <string>file</string>`,
    );
    const daemon = readFileSync(host.plist("dev.localdot.daemon"), "utf8");
    expect(daemon).toContain(`<key>LOCALDOT_PORT</key><string>${host.port}</string>`);
    expect(daemon).toContain(
      `<key>WorkingDirectory</key><string>${host.prefix}/app/apps/daemon</string>`,
    );
    const plutil = which("plutil");
    if (plutil) execFileSync(plutil, ["-lint", host.plist("dev.localdot.daemon")]);
    const uid = execFileSync("id", ["-u"]).toString().trim();
    const calls = host.calls();
    expect(calls).toContain(`launchctl bootstrap gui/${uid} ${host.plist("dev.localdot.daemon")}`);
    expect(calls).toContain(`open http://127.0.0.1:${host.port}/#code=fakecode`);
    expect(result.stdout).toContain("Opened localDot in your browser");
  });

  it("leaves loaded agents alone when nothing changed", async () => {
    const host = await makeHost({ os: "macos" });
    expect((await host.run()).code).toBe(0);
    host.clearCalls();
    expect((await host.run()).code).toBe(0);
    expect(host.calls().filter((call) => /launchctl boot/.test(call))).toEqual([]);
  });

  it("refuses to replace LaunchAgents another setup made", async () => {
    const host = await makeHost({ os: "macos" });
    mkdirSync(dirname(host.plist("dev.localdot.keyd")), { recursive: true });
    writeFileSync(host.plist("dev.localdot.keyd"), "<plist/>");
    const result = await host.run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("was not made by this installer");
  });
});

describe.concurrent("the localdot command and uninstall", { timeout: 60_000 }, () => {
  it("starts, stops and shows logs of the installed services", async () => {
    const host = await makeHost();
    expect((await host.run()).code).toBe(0);
    host.clearCalls();
    expect((await host.command(["down"])).code).toBe(0);
    expect(host.calls()).toContain(
      "systemctl --user stop localdot-daemon.service localdot-keyd.service",
    );
    writeFileSync(join(host.home, ".localdot/logs/daemon.log"), "daemon line\n");
    writeFileSync(join(host.home, ".localdot/logs/keyd.log"), "keyd line\n");
    const logs = await host.command(["logs"]);
    expect(logs.stdout).toContain("daemon line");
    expect(logs.stdout).toContain("keyd line");
    host.clearCalls();
    const up = await host.command(["up"]);
    expect(up.code).toBe(0);
    expect(host.calls()).toContain("systemctl --user start localdot-daemon.service");
    expect(up.stdout).toContain("#code=fakecode");
  });

  it("passes app commands to the CLI with the recorded settings", async () => {
    const host = await makeHost();
    expect((await host.run(["--home", join(host.home, "data")])).code).toBe(0);
    host.clearCalls();
    expect((await host.command(["stop", "--all"])).code).toBe(0);
    expect(host.calls()[0]).toMatch(
      new RegExp(
        `^node --import tsx \\.\\./cli/src/main\\.ts stop --all \\| cwd=.*/app/apps/daemon \\| home=${host.home}/data \\| port=${host.port} `,
      ),
    );
  });

  it("prints help with no command and refuses an unknown one", async () => {
    const host = await makeHost();
    expect((await host.run()).code).toBe(0);
    expect((await host.command([])).stdout).toContain("localdot up");
    const unknown = await host.command(["frobnicate"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("Unknown command: frobnicate");
  });

  it("updates through the command, keeping its settings", async () => {
    const host = await makeHost();
    expect((await host.run()).code).toBe(0);
    host.commit("second");
    const update = await host.command(["update"]);
    expect(update.code).toBe(0);
    expect(readFileSync(join(host.prefix, "install.env"), "utf8")).toContain(
      `LOCALDOT_COMMIT="${git(host.origin, "rev-parse", "HEAD")}"`,
    );
  });

  it("uninstalls everything it added and keeps the data", async () => {
    const host = await makeHost();
    writeFileSync(
      join(host.state, "tailscale-status.json"),
      JSON.stringify({ BackendState: "Running", CertDomains: ["box.example.ts.net"] }),
    );
    expect((await host.run(["--tailscale"])).code).toBe(0);
    writeFileSync(join(host.home, ".localdot/memory.md"), "keep me\n");
    host.clearCalls();
    const result = await host.command(["uninstall"]);
    expect(result.code).toBe(0);
    expect(existsSync(host.prefix)).toBe(false);
    expect(existsSync(host.unit("localdot-daemon.service"))).toBe(false);
    expect(existsSync(host.unit("localdot-keyd.service"))).toBe(false);
    expect(existsSync(join(host.home, ".local/bin/localdot"))).toBe(false);
    expect(readFileSync(join(host.home, ".localdot/memory.md"), "utf8")).toBe("keep me\n");
    const calls = host.calls();
    expect(calls).toContain(
      "systemctl --user disable --quiet localdot-daemon.service localdot-keyd.service",
    );
    expect(calls).toContain(`tailscale serve --https=${host.port} off`);
    expect(result.stdout).toContain("docker rm -f");
    expect((await host.run(["--uninstall"])).stdout).toContain("isn't installed");
  });
});

describe.concurrent("the install folder", { timeout: 60_000 }, () => {
  it("refuses a folder that holds other things, and leaves it as it was", async () => {
    const host = await makeHost({ prefix: ".local" });
    const keyring = join(host.home, ".local/share/keyrings/login.keyring");
    mkdirSync(dirname(keyring), { recursive: true });
    writeFileSync(keyring, "secret\n");
    const result = await host.run(["--prefix", host.prefix]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("already holds other files (such as share)");
    expect(readFileSync(keyring, "utf8")).toBe("secret\n");
    expect(existsSync(join(host.prefix, "app"))).toBe(false);
    expect(host.calls()).toEqual([]);
  });

  it("installs into a new folder and uninstalls back to nothing", async () => {
    const host = await makeHost({ prefix: "apps/localdot" });
    expect((await host.run(["--prefix", host.prefix])).code).toBe(0);
    expect((await host.command(["uninstall"])).code).toBe(0);
    expect(existsSync(host.prefix)).toBe(false);
    expect(existsSync(join(host.home, "apps"))).toBe(true);
  });

  it("uninstalls only what it made, even from a folder an older installer shared", async () => {
    const host = await makeHost({ prefix: ".local" });
    const keyring = join(host.home, ".local/share/keyrings/login.keyring");
    mkdirSync(dirname(keyring), { recursive: true });
    writeFileSync(keyring, "secret\n");
    mkdirSync(join(host.prefix, "app"), { recursive: true });
    mkdirSync(join(host.prefix, "bin"), { recursive: true });
    writeFileSync(join(host.prefix, "bin/keyd"), "");
    writeFileSync(join(host.prefix, "bin/other-tool"), "");
    writeFileSync(
      join(host.prefix, "install.env"),
      `# Managed by localDot's install.sh\nLOCALDOT_HOME="${host.home}/.localdot"\n`,
    );
    const result = await host.run(["--uninstall", "--prefix", host.prefix]);
    expect(result.code).toBe(0);
    expect(readFileSync(keyring, "utf8")).toBe("secret\n");
    expect(existsSync(join(host.prefix, "bin/other-tool"))).toBe(true);
    for (const made of ["app", "runtime", "bin/keyd", "install.env"])
      expect(existsSync(join(host.prefix, made)), made).toBe(false);
    expect(result.stdout).toContain(`Kept ${host.prefix}`);
  });

  it("runs again after an install that stopped part way", async () => {
    const host = await makeHost();
    mkdirSync(join(host.prefix, "app.new"), { recursive: true });
    expect((await host.run([], { STUB_DOCKER: "stopped" })).code).toBe(1);
    expect((await host.run()).code).toBe(0);
  });
});

describe.concurrent("options it refuses before doing anything", { timeout: 60_000 }, () => {
  it.each([
    [["--home", "relative/data"], "must be an absolute path"],
    [["--home", "/tmp/with space"], "has characters the services can't use"],
    [["--prefix", "/tmp/a$b"], "has characters the services can't use"],
    [["--ref", "-upload-pack=x"], "--ref wants a branch, tag or commit name"],
    [["--ref", "main;reboot"], "--ref wants a branch, tag or commit name"],
    [["--repo", "--upload-pack=x"], "--repo wants a Git URL or path"],
    [["--repo", "https://example.test/a b.git"], "--repo wants a Git URL or path"],
    [["--registry", "GHCR.io/Owner"], "--registry wants a registry and owner"],
    [["--registry", "ghcr.io/owner;x"], "--registry wants a registry and owner"],
    [["--port", "80"], "--port wants a number from 1024 to 65535"],
  ])("%j", async (args, words) => {
    const host = await makeHost();
    const result = await host.run(args);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(words);
    expect(host.calls()).toEqual([]);
    expect(existsSync(join(host.prefix, "app"))).toBe(false);
  });
});

describe.concurrent("pins", { timeout: 60_000 }, () => {
  const source = readFileSync(installer, "utf8");
  const pinned = (name) => new RegExp(`^${name}=(.+)$`, "m").exec(source)?.[1];

  it("builds keyd with the Go toolchain keyd/go.mod names", () => {
    expect(readFileSync(join(repo, "keyd/go.mod"), "utf8")).toContain(
      `toolchain go${pinned("GO_VERSION")}\n`,
    );
  });

  it("runs the Node.js release the computer images use", () => {
    expect(readFileSync(join(repo, "cells/desktop/Dockerfile"), "utf8")).toContain(
      `ARG NODE_VERSION=${pinned("NODE_VERSION")}\n`,
    );
  });
});

describe("the Windows bootstrap", { timeout: 120_000 }, () => {
  it.skipIf(!which("pwsh"))("passes its PowerShell checks", () => {
    execFileSync(
      "pwsh",
      ["-NoProfile", "-File", join(repo, "scripts/install/install-ps1.test.ps1")],
      {
        encoding: "utf8",
      },
    );
  });
});
