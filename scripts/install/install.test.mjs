import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
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
  "df",
  "dirname",
  "env",
  "find",
  "git",
  "grep",
  "gzip",
  "head",
  "iconv",
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

async function makeHost({
  os = "linux",
  machine,
  release,
  prefix: within,
  homeName = "home",
} = {}) {
  // A short, real path: the installer records real paths, and refuses a data folder too long for
  // the sockets kept in it.
  const root = mkdtempSync(join(realpathSync("/tmp"), "ld-"));
  roots.push(root);
  const home = join(root, homeName);
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
build) [ -z "\${STUB_STORAGE_ERROR:-}" ] || { echo "$STUB_STORAGE_ERROR" >&2; exit 9; } ;;
esac`,
  );
  script(
    join(stubs, "systemd-run"),
    `${logged("systemd-run")}\nexit "\${STUB_SERVICE_DOCKER_RC:-0}"`,
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
    script(join(stubs, opener), `${logged(opener)}\nexit "\${STUB_OPENER_RC:-0}"`);

  script(
    join(nodeBin, "node"),
    `[ "$1" != --version ] || { echo v24.21.0; exit 0; }
printf '%s\\n' "node $* | cwd=$PWD | home=$LOCALDOT_HOME | port=$LOCALDOT_PORT | origin=$LOCALDOT_PUBLIC_ORIGIN" >> "$STUB_LOG"
case "$*" in
*" open"*)
  echo "http://127.0.0.1:$LOCALDOT_PORT/#code=fakecode"
  [ -z "$LOCALDOT_PUBLIC_ORIGIN" ] || echo "From your other devices: $LOCALDOT_PUBLIC_ORIGIN/#code=fakecode"
  case "$*" in *--qr*) echo "[qr code]" ;; esac ;;
*" stop --computers"*) exit "\${STUB_STOP_COMPUTERS_RC:-0}" ;;
*" dots env "*)
  [ -n "\${STUB_DOT_HOME:-}" ] || { echo "There's no dot called that" >&2; exit 1; }
  if [ "$STUB_KERNEL" = Darwin ]; then keyd=dev.localdot.work.keyd daemon=dev.localdot.work.daemon
  else keyd=localdot-work-keyd.service daemon=localdot-work-daemon.service; fi
  printf '%s\n' 'DOT_ID="work"' "LD_HOME=\\"$STUB_DOT_HOME\\"" 'PORT="5750"' 'KEYD_PORTS="5760-5789"' \
    'PUBLIC_ORIGIN="https://box.example.ts.net:5750"' "KEYD_SERVICE=\\"$keyd\\"" "DAEMON_SERVICE=\\"$daemon\\"" ;;
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
    location: join(home, ".config/localdot/install-location"),
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

const python = which("python3");

// In a pseudo-terminal, as someone runs the installer: it reads their answers from /dev/tty.
function runInTerminal(host, args, answers) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      python,
      [
        "-c",
        "import pty, sys; sys.exit(pty.spawn(sys.argv[1:]) >> 8)",
        "/bin/bash",
        installer,
        "--repo",
        host.origin,
        "--port",
        String(host.port),
        ...args,
      ],
      { env: host.env, cwd: host.home, detached: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output: output.replaceAll("\r\n", "\n") }));
    child.stdin.end(answers);
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
      "curl -fL --retry 3 -o " +
        join(host.prefix, "runtime/.download/archive.tar.gz") +
        " https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz",
    );
  });
});

describe.concurrent("Docker credential helper discovery", { timeout: 60_000 }, () => {
  it.each([false, true])(
    "keeps helpers available for pulls when the CLI is already on PATH: %s",
    async (existingCLI) => {
      const host = await makeHost({ os: "macos" });
      const desktop = join(host.root, "Desktop.app/Contents/Resources/bin");
      script(
        join(desktop, "docker"),
        'case "$1" in info) echo 29.0.0 ;; pull) exec docker-credential-localdot-test probe ;; esac',
      );
      script(join(desktop, "docker-credential-localdot-test"), "echo helper-found");
      if (existingCLI) {
        script(
          join(host.stubs, "docker"),
          'case "$1" in info) echo 29.0.0 ;; pull) exec docker-credential-localdot-test probe ;; esac',
        );
      } else rmSync(join(host.stubs, "docker"));
      const result = await runBash(
        [
          "-c",
          `source "$1"
OS=macos WSL="" PREREQUISITES=no PACKAGE_CHANNEL=testing
NODE_DIR="$HOME/node"
docker_desktop_bins() { printf '%s\\n' "$TEST_DESKTOP"; }
prepare_prerequisites
check_prerequisites
first_path=$PATH
find_docker
[ "$first_path" = "$PATH" ]
command -v docker
docker pull example.test/image
PATH=$(service_path) docker pull example.test/image
`,
          "test",
          installer,
        ],
        { ...host.env, TEST_DESKTOP: desktop },
      );
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain(join(existingCLI ? host.stubs : desktop, "docker"));
      expect(result.stdout.match(/helper-found/g)).toHaveLength(2);
    },
  );

  it("does not replace a credential helper already selected on PATH", async () => {
    const host = await makeHost({ os: "macos" });
    const desktop = join(host.root, "Desktop.app/Contents/Resources/bin");
    script(join(desktop, "docker"), "exit 0");
    script(join(desktop, "docker-credential-desktop"), "echo fallback");
    script(join(host.stubs, "docker-credential-desktop"), "echo selected");
    const result = await runBash(
      [
        "-c",
        `source "$1"
OS=macos
docker_desktop_bins() { printf '%s\\n' "$TEST_DESKTOP"; }
find_docker
docker-credential-desktop
`,
        "test",
        installer,
      ],
      { ...host.env, TEST_DESKTOP: desktop },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("selected");
  });

  it("leaves Linux PATH unchanged", async () => {
    const host = await makeHost();
    const result = await runBash(
      [
        "-c",
        `source "$1"
OS=linux
before=$PATH
find_docker
[ "$before" = "$PATH" ]
[ -z "$(docker_desktop_bins)" ]
`,
        "test",
        installer,
      ],
      host.env,
    );
    expect(result.code, result.stderr).toBe(0);
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
    expect(result.stderr).toContain("https://docs.docker.com/engine/install/");
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

  it.each(["wsl", "linux"])(
    "catches stale service permissions on %s before changing the installation",
    async (os) => {
      const host = await makeHost({ os });
      const result = await host.run([], { STUB_SERVICE_DOCKER_RC: "1" });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Docker works in this terminal but not in");
      expect(result.stderr).toContain(
        os === "wsl" ? "wsl --terminate" : "Sign out of all sessions",
      );
      expect(host.calls().some((call) => call.startsWith("systemd-run --user"))).toBe(true);
      expect(host.calls().some((call) => /systemctl --user (stop|restart)/.test(call))).toBe(false);
      expect(host.calls().filter((call) => call.startsWith("curl"))).toEqual([]);
    },
  );

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
  it("stops on a full installation disk without starting builds", async () => {
    const host = await makeHost();
    script(
      join(host.stubs, "df"),
      "printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 100 100 0 100%% /\\n'",
    );
    const result = await host.run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no free space");
    expect(host.calls().some((call) => /^(build |pnpm |go )/.test(call))).toBe(false);
  });
  it("catches unwritable Docker storage before building images and cleans up only its probe", async () => {
    const host = await makeHost();
    const result = await host.run([], {
      STUB_STORAGE_ERROR: "metadata_v2.db: read-only file system",
    });
    expect(result.code).toBe(9);
    expect(result.stderr).toContain("docker-storage-read-only");
    expect(host.calls().some((call) => call.startsWith("build "))).toBe(false);
    expect(
      host.calls().some((call) => call.startsWith("docker image rm localdot-install-probe:")),
    ).toBe(true);
    expect(host.calls().some((call) => /prune|volume rm/.test(call))).toBe(false);
  });
  it.each([
    ["write metadata_v2.db: read-only file system", "docker-storage-read-only"],
    ["no space left on device", "docker-storage-full"],
    ["permission denied", "docker-permission-denied"],
    ["Temporary failure resolving archive.ubuntu.com", "image-download-unavailable"],
  ])(
    "explains image failure %s and keeps diagnostics free of raw build secrets",
    async (error, reason) => {
      const host = await makeHost();
      script(
        join(host.origin, "cells/desktop/build.sh"),
        `echo '${error}'; echo 'Bearer private-fixture-secret'; exit 7`,
      );
      host.commit("Fail desktop image");
      const result = await host.run();
      expect(result.code).toBe(7);
      expect(result.stderr).toContain(reason);
      const diagnostic = readFileSync(join(host.prefix, "runtime/install-failure.txt"), "utf8");
      expect(diagnostic).toContain(`reason=${reason}`);
      expect(diagnostic).not.toContain("private-fixture-secret");
      expect(
        host.calls().some((call) => /prune|wsl --shutdown|systemctl.*restart/.test(call)),
      ).toBe(false);
      expect(result.stdout).not.toContain("#code=");
    },
  );

  it("does not claim success or issue a sign-in link when doctor fails", async () => {
    const host = await makeHost();
    const result = await host.run([], { STUB_DOCTOR_RC: "1" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Setup is not complete");
    expect(result.stdout).not.toContain("#code=");
  });
  it("keeps the app installed and offers unlock when only vault setup is pending", async () => {
    const host = await makeHost();
    const result = await host.run([], { STUB_DOCTOR_RC: "2" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("localDot is installed");
    expect(result.stdout).toContain("localdot unlock");
    expect(result.stdout).toContain("#code=");
    expect(existsSync(join(host.prefix, "install.env"))).toBe(true);
  });
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
    // New shells can find the command even when ~/.local/bin was absent at install time.
    const loginPath = execFileSync(
      "/bin/bash",
      ["--noprofile", "--norc", "-c", 'source "$HOME/.profile"; command -v localdot'],
      {
        env: { HOME: host.home, PATH: "/usr/bin:/bin" },
        encoding: "utf8",
      },
    ).trim();
    expect(loginPath).toBe(join(host.home, ".local/bin/localdot"));
    if (existsSync("/bin/zsh")) {
      const zshPath = execFileSync("/bin/zsh", ["-lic", "command -v localdot"], {
        env: { HOME: host.home, ZDOTDIR: host.home, PATH: "/usr/bin:/bin" },
        encoding: "utf8",
      }).trim();
      expect(zshPath).toBe(join(host.home, ".local/bin/localdot"));
    }
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

  it.each(["wsl", "linux", "macos"])(
    "builds the real gate script with managed Go on %s without system Go",
    async (os) => {
      const host = await makeHost({ os });
      copyFileSync(join(repo, "cells/gate/build.sh"), join(host.origin, "cells/gate/build.sh"));
      mkdirSync(join(host.origin, "cells/gate/dist"));
      writeFileSync(join(host.origin, "cells/gate/dist/.keep"), "");
      host.commit("Use the real gate build script");
      script(join(host.stubs, "go"), 'echo "Unexpected system Go" >&2; exit 99');

      const result = await host.run();
      expect(result.stderr).not.toContain("Unexpected system Go");
      expect(result.code, result.stderr).toBe(0);
      expect(host.calls()).toContain(
        "go build -trimpath -o ../cells/gate/dist/ldgate ./cmd/ldgate",
      );
      expect(host.calls()).toContain("docker build -t localdot/gate:dev .");
      expect(result.stdout).toContain(`http://127.0.0.1:${host.port}/#code=fakecode`);
    },
  );

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

  it("recovers from failed final checks when the installer is rerun", async () => {
    const host = await makeHost();
    const result = await host.run([], { STUB_DOCTOR_RC: "1" });
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("#code=fakecode");
    const retry = await host.run();
    expect(retry.code, retry.stderr).toBe(0);
    expect(retry.stdout).toContain("#code=fakecode");
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

describe.concurrent("installation links", { timeout: 60_000 }, () => {
  it.each(["macos", "wsl", "linux"])(
    "prints a usable link even when the %s browser opener fails",
    async (os) => {
      const host = await makeHost({ os });
      const result = await host.run([], { DISPLAY: ":0", STUB_OPENER_RC: "1" });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain(`http://127.0.0.1:${host.port}/#code=fakecode`);
      expect(result.stdout).toContain("this link works once");
      expect(result.stdout).not.toContain("Opened localDot");
      if (os === "wsl") expect(result.stdout).toContain("For a fresh link from PowerShell:");
    },
  );

  it("leaves a Windows link when WSL interop is unavailable", async () => {
    const host = await makeHost({ os: "wsl" });
    rmSync(join(host.stubs, "explorer.exe"));
    const result = await host.run([], { WSL_DISTRO_NAME: "Ubuntu-24.04" });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`http://127.0.0.1:${host.port}/#code=fakecode`);
    expect(result.stdout).toContain("wsl -d Ubuntu-24.04 -- ~/.local/bin/localdot open");
    expect(result.stdout).not.toContain("ssh -N");
  });

  it("keeps remote WSL sessions on the SSH path without opening the host browser", async () => {
    const host = await makeHost({ os: "wsl" });
    const result = await host.run([], { SSH_CONNECTION: "test-ssh-session" });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("ssh -N");
    expect(host.calls().some((line) => line.startsWith("explorer.exe "))).toBe(false);
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
    expect(result.stdout).toContain("If your browser did not open, use the link above.");
    expect(result.stdout).toContain(`http://127.0.0.1:${host.port}/#code=fakecode`);
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

describe.concurrent("several dots on one computer", { timeout: 60_000 }, () => {
  it("runs a command for one dot, with its own folder, port, address and services", async () => {
    const host = await makeHost();
    expect((await host.run()).code).toBe(0);
    const work = join(host.home, ".localdot-work");
    mkdirSync(join(work, "logs"), { recursive: true });
    writeFileSync(join(work, "logs/daemon.log"), "work daemon line\n");
    writeFileSync(join(host.home, ".localdot/logs/daemon.log"), "main daemon line\n");
    const env = { STUB_DOT_HOME: work };
    host.clearCalls();
    const up = await host.command(["up", "--dot", "work"], env);
    expect(up.code).toBe(0);
    expect(host.calls()).toContain("systemctl --user start localdot-work-keyd.service");
    expect(host.calls()).toContain("systemctl --user start localdot-work-daemon.service");
    expect(host.calls()).not.toContain("systemctl --user start localdot-daemon.service");
    expect(host.calls()).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `main\\.ts open( --qr)? \\| .*home=${work} \\| port=5750 \\| origin=https://box\\.example\\.ts\\.net:5750$`,
        ),
      ),
    );
    expect(up.stdout).toContain("http://127.0.0.1:5750/#code=fakecode");
    host.clearCalls();
    expect((await host.command(["down", "--dot", "work"], env)).code).toBe(0);
    expect(host.calls()).toContain(
      "systemctl --user stop localdot-work-daemon.service localdot-work-keyd.service",
    );
    const logs = await host.command(["logs", "--dot", "work"], env);
    expect(logs.stdout).toContain("work daemon line");
    expect(logs.stdout).not.toContain("main daemon line");
    const unknown = await host.command(["doctor", "--dot", "nowhere"]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain("no dot called that");
    const wrong = await host.command(["recover", "--cell", "x", "--dot", "work"], env);
    expect(wrong.code).not.toBe(0);
    expect(wrong.stderr).toContain("--dot works with");
  });

  it("hands dots commands to the app's command, and updates every dot with the installation", async () => {
    const host = await makeHost();
    expect((await host.run()).code).toBe(0);
    expect(host.calls()).toContainEqual(expect.stringMatching(/main\.ts dots refresh /));
    host.clearCalls();
    expect((await host.command(["dots", "add", "Home Mac", "--copy", "keys"])).code).toBe(0);
    expect(host.calls()).toContainEqual(
      expect.stringMatching(/main\.ts dots add Home Mac --copy keys \| /),
    );
    host.clearCalls();
    expect((await host.command(["start-at-login", "off"])).code).toBe(0);
    expect(host.calls()).toContainEqual(expect.stringMatching(/main\.ts dots login off /));
    host.clearCalls();
    expect((await host.command(["uninstall"])).code).toBe(0);
    expect(host.calls()).toContainEqual(expect.stringMatching(/main\.ts dots uninstall /));
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
    expect(host.calls().some((call) => call.includes("stop --computers"))).toBe(true);
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

  it("changes startup without stopping services and preserves the choice on restart", async () => {
    const host = await makeHost();
    expect((await host.run()).code).toBe(0);
    host.clearCalls();
    expect((await host.command(["start-at-login", "off"])).stdout.trim()).toBe("off");
    expect(host.calls()).toContain(
      "systemctl --user disable --quiet localdot-keyd.service localdot-daemon.service",
    );
    expect(host.calls().some((call) => /systemctl.*(stop|restart)/.test(call))).toBe(false);
    host.clearCalls();
    expect((await host.command(["restart"])).code).toBe(0);
    // The app's command restarts, keeping start at login as it was.
    expect(host.calls()).toContainEqual(expect.stringMatching(/main\.ts restart \| /));
    expect(host.calls()).not.toContain(
      "systemctl --user enable --quiet localdot-keyd.service localdot-daemon.service",
    );
    expect((await host.command(["start-at-login", "status"])).stdout.trim()).toBe("off");
    expect((await host.command(["start-at-login", "on"])).stdout.trim()).toBe("on");
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
    for (const args of [
      ["status", "--json"],
      ["link", "remote", "--qr"],
      ["computer", "list"],
    ]) {
      host.clearCalls();
      expect((await host.command(args)).code).toBe(0);
      expect(host.calls()[0]).toContain(`../cli/src/main.ts ${args.join(" ")} | `);
    }
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

  it("installs the exact prepared commit while retaining its branch for future checks", async () => {
    const host = await makeHost();
    expect((await host.run()).code).toBe(0);
    host.commit("prepared");
    const prepared = git(host.origin, "rev-parse", "HEAD");
    host.commit("later");
    const result = await host.command(["update"], {
      LOCALDOT_UPDATE_COMMIT: prepared,
      LOCALDOT_UPDATE_SHUTDOWN: "1",
    });
    expect(result.code, result.stderr).toBe(0);
    const saved = readFileSync(join(host.prefix, "install.env"), "utf8");
    expect(saved).toContain(`LOCALDOT_COMMIT="${prepared}"`);
    expect(saved).toContain('LOCALDOT_REF="main"');
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

describe.concurrent("choosing where to install", { timeout: 60_000 }, () => {
  const xml = (text) =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

  it("installs for a user whose home folder has a space and an apostrophe", async () => {
    const host = await makeHost({ homeName: "Husky's home" });
    const result = await host.run();
    expect(result.code, result.stderr).toBe(0);
    const data = join(host.home, ".localdot");
    expect(readFileSync(host.unit("localdot-keyd.service"), "utf8")).toContain(
      `ExecStart="${host.prefix}/bin/keyd" "-home" "${data}"\n`,
    );
    const daemon = readFileSync(host.unit("localdot-daemon.service"), "utf8");
    expect(daemon).toContain(`WorkingDirectory=${host.prefix}/app/apps/daemon\n`);
    expect(daemon).toContain(`Environment="HOME=${host.home}"\n`);
    expect(daemon).toContain(`Environment="LOCALDOT_INSTALL_PREFIX=${host.prefix}"\n`);
    expect(daemon).toContain(`StandardOutput=append:${data}/logs/daemon.log\n`);
    const loginPath = execFileSync(
      "/bin/bash",
      ["--noprofile", "--norc", "-c", 'source "$HOME/.profile"; command -v localdot'],
      { env: { HOME: host.home, PATH: "/usr/bin:/bin" }, encoding: "utf8" },
    ).trim();
    expect(loginPath).toBe(join(host.home, ".local/bin/localdot"));
    const doctor = await host.command(["doctor"]);
    expect(doctor.code, doctor.stderr).toBe(0);
    expect(doctor.stdout).toContain(`localDot is installed in ${host.prefix}`);
  });

  it("escapes chosen folders in LaunchAgents, the command and the commands it prints", async () => {
    const host = await makeHost({ os: "macos", prefix: "Husky's SSD 4T/localDot" });
    const data = join(host.home, "Husky's SSD 4T", "dot & <data>");
    const result = await host.run(["--prefix", host.prefix, "--home", data]);
    expect(result.code, result.stderr).toBe(0);
    expect(readFileSync(host.plist("dev.localdot.keyd"), "utf8")).toContain(
      `<string>${host.prefix}/bin/keyd</string>\n    <string>-home</string>\n    <string>${xml(data)}</string>`,
    );
    const daemon = host.plist("dev.localdot.daemon");
    expect(readFileSync(daemon, "utf8")).toContain(
      `<key>LOCALDOT_HOME</key><string>${xml(data)}</string>`,
    );
    const plutil = which("plutil");
    if (plutil) {
      const parsed = JSON.parse(
        execFileSync(plutil, ["-convert", "json", "-o", "-", daemon], { encoding: "utf8" }),
      );
      expect(parsed.EnvironmentVariables.LOCALDOT_HOME).toBe(data);
      expect(parsed.EnvironmentVariables.LOCALDOT_INSTALL_PREFIX).toBe(host.prefix);
      expect(parsed.WorkingDirectory).toBe(join(host.prefix, "app/apps/daemon"));
      expect(parsed.StandardOutPath).toBe(join(data, "logs/daemon.log"));
    }
    const doctor = await host.command(["doctor"]);
    expect(doctor.code, doctor.stderr).toBe(0);
    expect(doctor.stdout).toContain(`localDot is installed in ${host.prefix}`);
    const removed = await host.command(["uninstall"]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(existsSync(host.prefix)).toBe(false);
    expect(existsSync(join(data, "logs"))).toBe(true);
    const printed = /to delete it too: rm -rf (.*)$/m.exec(removed.stdout)?.[1];
    expect(execFileSync("/bin/sh", ["-c", `printf %s ${printed}`], { encoding: "utf8" })).toBe(
      data,
    );
  });

  it("records the real folders behind a symlink and ~", async () => {
    const host = await makeHost({ prefix: "disk/localDot" });
    symlinkSync(join(host.home, "disk"), join(host.home, "shortcut"));
    const result = await host.run([
      "--prefix",
      join(host.home, "shortcut/localDot"),
      "--home",
      "~/shortcut/data",
    ]);
    expect(result.code, result.stderr).toBe(0);
    const data = join(host.home, "disk/data");
    expect(realpathSync(host.prefix)).toBe(host.prefix);
    const daemon = readFileSync(host.unit("localdot-daemon.service"), "utf8");
    expect(daemon).toContain(`Environment="LOCALDOT_INSTALL_PREFIX=${host.prefix}"\n`);
    expect(daemon).toContain(`Environment="LOCALDOT_HOME=${data}"\n`);
    expect(readFileSync(join(host.prefix, "install.env"), "utf8")).toContain(
      `LOCALDOT_HOME="${data}"\n`,
    );
    expect(readFileSync(host.location, "utf8")).toBe(
      `# Managed by localDot's install.sh\nLOCALDOT_PREFIX="${host.prefix}"\nLOCALDOT_HOME="${data}"\n`,
    );
  });

  it("finds the chosen folders again on a bare rerun, an update and an uninstall", async () => {
    const host = await makeHost({ prefix: "Husky's SSD 4T/localDot" });
    const data = join(host.home, "Husky's SSD 4T/dot data");
    expect((await host.run(["--prefix", host.prefix, "--home", data])).code).toBe(0);
    host.commit("second");
    // Like other recorded settings, the remembered folders win over the environment.
    const again = await host.run([], {
      LOCALDOT_PREFIX: join(host.home, "elsewhere"),
      LOCALDOT_HOME: join(host.home, "other data"),
    });
    expect(again.code, again.stderr).toBe(0);
    expect(existsSync(join(host.home, "elsewhere"))).toBe(false);
    expect(existsSync(join(host.home, ".local/share/localdot"))).toBe(false);
    const recorded = () => readFileSync(join(host.prefix, "install.env"), "utf8");
    expect(recorded()).toContain(`LOCALDOT_COMMIT="${git(host.origin, "rev-parse", "HEAD")}"`);
    expect(readFileSync(host.unit("localdot-daemon.service"), "utf8")).toContain(
      `Environment="LOCALDOT_HOME=${data}"\n`,
    );
    host.commit("third");
    expect((await host.command(["update"])).code).toBe(0);
    expect(recorded()).toContain(`LOCALDOT_COMMIT="${git(host.origin, "rev-parse", "HEAD")}"`);
    const removed = await host.run(["--uninstall"]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(existsSync(host.prefix)).toBe(false);
    expect(existsSync(host.location)).toBe(false);
    expect(existsSync(join(data, "logs"))).toBe(true);
    expect((await host.run(["--uninstall"])).stdout).toContain("isn't installed");
  });

  it("refuses to install a second copy in another folder, leaving the first", async () => {
    const host = await makeHost({ prefix: "apps/localdot" });
    expect((await host.run(["--prefix", host.prefix])).code).toBe(0);
    host.clearCalls();
    const other = join(host.home, "Husky's SSD 4T/localDot");
    const result = await host.run(["--prefix", other]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`localDot is already installed in ${host.prefix}.`);
    expect(result.stderr).toContain("localdot uninstall");
    expect(result.stderr).toContain(`--prefix '${other.replaceAll("'", "'\\''")}'`);
    expect(existsSync(other)).toBe(false);
    expect(host.calls()).toEqual([]);
    expect(readFileSync(host.unit("localdot-daemon.service"), "utf8")).toContain(
      `LOCALDOT_INSTALL_PREFIX=${host.prefix}"`,
    );
  });

  it("finds an install made before the location was remembered through its command", async () => {
    const host = await makeHost({ prefix: "apps/localdot" });
    expect((await host.run(["--prefix", host.prefix])).code).toBe(0);
    rmSync(host.location);
    host.commit("second");
    const again = await host.run();
    expect(again.code, again.stderr).toBe(0);
    expect(existsSync(join(host.home, ".local/share/localdot"))).toBe(false);
    expect(readFileSync(host.location, "utf8")).toContain(`LOCALDOT_PREFIX="${host.prefix}"\n`);
  });

  it("installs in the default folders without asking when there is no terminal", async () => {
    const host = await makeHost();
    const result = await host.run();
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("type another folder");
    expect(readFileSync(host.location, "utf8")).toContain(
      `LOCALDOT_PREFIX="${host.prefix}"\nLOCALDOT_HOME="${host.home}/.localdot"\n`,
    );
  });

  it("stops when the data folder's disk is full, before building", async () => {
    const host = await makeHost();
    const data = join(host.home, "dot data");
    mkdirSync(data);
    script(
      join(host.stubs, "df"),
      `case "$*" in *"dot data"*) disk="datadisk 100 100 0 100% /data" ;; *) disk="appdisk 100 0 100 0% /" ;; esac
printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n%s\\n' "$disk"`,
    );
    const result = await host.run(["--home", data]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("The data folder's filesystem has no free space");
    expect(host.calls().some((call) => /^(build |pnpm |go )/.test(call))).toBe(false);
  });

  it.each([
    ["control characters", (h) => ["--home", join(h.home, "dot\ndata")], "control characters"],
    ["a double quote", (h) => ["--prefix", join(h.home, 'say "dot"')], "double quotes"],
    ["a colon in the install folder", (h) => ["--prefix", join(h.home, "a:b")], "a colon"],
    ["your home folder", (h) => ["--prefix", h.home], "can't be your home folder itself"],
    ["the filesystem root", () => ["--home", "/"], "can't be / itself"],
    ["data the app replaces", (h) => ["--home", join(h.prefix, "app/data")], "upgrades replace"],
    ["too long a data folder", (h) => ["--home", join(h.home, "d".repeat(50))], "too long"],
  ])("refuses %s before doing anything", async (_, args, words) => {
    const host = await makeHost();
    const result = await host.run(args(host));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(words);
    expect(host.calls()).toEqual([]);
    expect(existsSync(join(host.prefix, "app"))).toBe(false);
    expect(existsSync(host.location)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("refuses a folder you can't write to", async () => {
    const host = await makeHost();
    const locked = join(host.home, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o555);
    try {
      const result = await host.run(["--prefix", join(locked, "localdot")]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`you can't write to ${locked}`);
      expect(host.calls()).toEqual([]);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("refuses a drive that doesn't keep file permissions", async () => {
    const host = await makeHost();
    script(join(host.stubs, "ls"), 'echo "drwxrwxrwx  2 dot  staff  64 Oct 15 10:00 $2"');
    const result = await host.run(["--home", join(host.home, "usb/dot")]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("doesn't keep file permissions");
    expect(host.calls()).toEqual([]);
  });

  it("reads a typed folder the way terminals paste or drop one in", async () => {
    const host = await makeHost();
    const typed = {
      "/Volumes/Husky\\'s\\ SSD\\ 4T/localDot ": "/Volumes/Husky's SSD 4T/localDot",
      "'/media/dot/Husky'\\''s SSD 4T/localDot' ": "/media/dot/Husky's SSD 4T/localDot",
      '  "/Volumes/Husky\'s \\"SSD\\"/$HOME"': '/Volumes/Husky\'s "SSD"/$HOME',
      "~/local dot": "~/local dot",
    };
    for (const [answer, folder] of Object.entries(typed)) {
      const result = await runBash(
        ["-c", 'source "$1"; typed_folder "$2"', "test", installer, answer],
        host.env,
      );
      expect(result.stdout, answer).toBe(folder);
    }
  });

  it.skipIf(!which("iconv"))("refuses a folder name that isn't UTF-8 text", async () => {
    const host = await makeHost();
    const result = await runBash(
      ["-c", `source "$1"; check_path "The data folder" $'/tmp/dot\\xff'`, "test", installer],
      host.env,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("isn't valid UTF-8");
  });
});

describe.concurrent("asking where to install", { timeout: 60_000 }, () => {
  // No waiting for the key service, which the fixture never starts.
  const quick = (host) => script(join(host.stubs, "sleep"), ":");

  it.skipIf(!python)(
    "installs in a folder dragged into the terminal, and remembers it",
    async () => {
      const host = await makeHost({ prefix: "Husky's SSD 4T/localDot" });
      quick(host);
      // Terminal escapes a dragged-in folder's spaces and quotes, and adds a space after it.
      const result = await runInTerminal(host, [], "~/Husky\\'s\\ SSD\\ 4T/localDot \n");
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain(
        "localDot will be installed in:\n  App   ~/.local/share/localdot\n  Data  ~/.localdot\n",
      );
      expect(result.output).toContain(
        "Installing in ~/Husky's SSD 4T/localDot, with your data in ~/Husky's SSD 4T/localDot/data.",
      );
      const data = join(host.prefix, "data");
      expect(readFileSync(host.unit("localdot-daemon.service"), "utf8")).toContain(
        `Environment="LOCALDOT_HOME=${data}"\n`,
      );
      expect(readFileSync(host.location, "utf8")).toContain(
        `LOCALDOT_PREFIX="${host.prefix}"\nLOCALDOT_HOME="${data}"\n`,
      );
      host.commit("second");
      const again = await runInTerminal(host, [], "");
      expect(again.code, again.output).toBe(0);
      expect(again.output).not.toContain("type another folder");
      expect(existsSync(join(host.home, ".local/share/localdot"))).toBe(false);
    },
  );

  it.skipIf(!python)(
    "asks again after a folder it can't use; Enter keeps the defaults",
    async () => {
      const host = await makeHost();
      quick(host);
      const documents = join(host.home, "Documents");
      mkdirSync(documents);
      writeFileSync(join(documents, "notes.txt"), "keep\n");
      const result = await runInTerminal(host, [], "~/Documents\n\n");
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain(
        "~/Documents already holds other files (such as notes.txt). localDot needs a folder of its own: choose a new or empty one, such as ~/Documents/localdot.",
      );
      expect(readFileSync(host.location, "utf8")).toContain(`LOCALDOT_PREFIX="${host.prefix}"\n`);
      expect(readFileSync(join(documents, "notes.txt"), "utf8")).toBe("keep\n");
      expect(existsSync(join(documents, "app"))).toBe(false);
    },
  );

  it.skipIf(!python)("keeps existing data where it is when the app goes elsewhere", async () => {
    const host = await makeHost({ prefix: "apps/localdot" });
    quick(host);
    mkdirSync(join(host.home, ".localdot"));
    // A relative folder starts in the current folder.
    const result = await runInTerminal(host, [], "apps/localdot\n");
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("Your existing data stays in ~/.localdot.");
    expect(readFileSync(host.unit("localdot-daemon.service"), "utf8")).toContain(
      `Environment="LOCALDOT_HOME=${host.home}/.localdot"\n`,
    );
  });

  it.skipIf(!python)("doesn't ask with --yes", async () => {
    const host = await makeHost();
    quick(host);
    const result = await runInTerminal(host, ["--yes"], "");
    expect(result.code, result.output).toBe(0);
    expect(result.output).not.toContain("type another folder");
    expect(readFileSync(host.location, "utf8")).toContain(`LOCALDOT_PREFIX="${host.prefix}"\n`);
  });
});

describe.concurrent("options it refuses before doing anything", { timeout: 60_000 }, () => {
  it.each([
    [["--home", "relative/data"], "must be an absolute path"],
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

describe.concurrent("guided prerequisite setup", { timeout: 60_000 }, () => {
  const functions = (host, code) =>
    runBash(["-c", `source "$1"\n${code}`, "test", installer], host.env);

  it.each(["arm64", "x64"])(
    "verifies and installs the Mac %s artifact, then unmounts it",
    async (arch) => {
      const host = await makeHost({ os: "macos" });
      const result = await functions(
        host,
        `
ARCH=${arch}
curl() { printf 'download %s\\n' "$*" >> "$STUB_LOG"; }
sha256_of() { echo ${arch === "arm64" ? "02147e4d559ff41e1d9d7be63a554101340237064c7b6df234548aa111ebf04c" : "44a9c8524c6f5cc6ba51cec7fd6343b2a744ff4cb5126f7d3d5b6f4da06fd905"}; }
hdiutil() { printf 'hdiutil %s\\n' "$*" >> "$STUB_LOG"; }
sudo() { printf 'sudo %s\\n' "$*" >> "$STUB_LOG"; }
install_mac_docker
`,
      );
      expect(result.code).toBe(0);
      const calls = host.calls().join("\n");
      expect(calls).toContain(`/mac/main/${arch === "x64" ? "amd64" : arch}/241994/Docker.dmg`);
      expect(calls).toContain("hdiutil attach");
      expect(calls).toContain("/Docker.app/Contents/MacOS/install --user=");
      expect(calls).toContain("hdiutil detach");
      expect(calls).not.toContain("--accept-license");
    },
  );

  it("rejects a corrupt Mac download without mounting or executing it", async () => {
    const host = await makeHost({ os: "macos" });
    const result = await functions(
      host,
      `
ARCH=arm64
curl() { :; }
sha256_of() { echo bad; }
hdiutil() { printf 'hdiutil %s\\n' "$*" >> "$STUB_LOG"; }
sudo() { echo sudo >> "$STUB_LOG"; }
install_mac_docker
`,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("verification failed");
    expect(host.calls().join("\n")).not.toMatch(/hdiutil attach|sudo/);
  });

  it("keeps the installer failure visible and cleans up its Mac mount", async () => {
    const host = await makeHost({ os: "macos" });
    const result = await functions(
      host,
      `
ARCH=arm64
curl() { :; }
sha256_of() { echo 02147e4d559ff41e1d9d7be63a554101340237064c7b6df234548aa111ebf04c; }
hdiutil() { printf 'hdiutil %s\\n' "$*" >> "$STUB_LOG"; }
sudo() { return 42; }
install_mac_docker
echo should-not-continue
`,
    );
    expect(result.code).toBe(42);
    expect(host.calls().join("\n")).toContain("hdiutil detach");
    expect(result.stdout).not.toContain("should-not-continue");
  });

  it("leaves a working engine alone", async () => {
    const host = await makeHost();
    const result = await functions(
      host,
      `
OS=linux WSL='' PREREQUISITES=yes
install_linux_prerequisites() { echo unexpected-install; exit 99; }
prepare_prerequisites
`,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("unexpected-install");
  });

  it("does not install or launch dependencies in manual mode", async () => {
    const host = await makeHost({ os: "macos" });
    const result = await functions(
      host,
      `
parse_args --no-prerequisites
prepare_prerequisites
`,
    );
    expect(result.code).toBe(0);
    expect(host.calls()).toEqual([]);
  });

  it("never installs a second engine in WSL", async () => {
    const host = await makeHost({ os: "wsl" });
    const result = await functions(
      host,
      `
OS=linux WSL=2 PREREQUISITES=yes
find_docker() { return 1; }
install_linux_prerequisites() { echo unexpected-install; exit 99; }
prepare_prerequisites
`,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("unexpected-install");
  });

  it("does not replace a configured remote engine when its CLI is missing", async () => {
    const host = await makeHost();
    const result = await functions(
      host,
      `
OS=linux WSL='' PREREQUISITES=yes DOCKER_HOST=tcp://example.test:2376
find_docker() { return 1; }
install_linux_prerequisites() { echo unexpected-install; exit 99; }
prepare_prerequisites
`,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("unexpected-install");
  });

  it("does not claim Linux setup completed when apt fails", async () => {
    const host = await makeHost();
    const result = await functions(
      host,
      `
linux_distribution() { echo ubuntu noble; }
apt-get() { :; }
sudo() { cat >/dev/null; return 42; }
install_linux_prerequisites no
echo should-not-continue
`,
    );
    expect(result.code).toBe(42);
    expect(result.stdout).not.toContain("should-not-continue");
  });

  it("rejects conflicting prerequisite flags", async () => {
    const host = await makeHost();
    const result = await host.run(["--install-prerequisites", "--no-prerequisites"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Choose one prerequisite mode");
    expect(host.calls()).toEqual([]);
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

describe("doctor repair", () => {
  it("keeps normal diagnostics read-only and restarts only localDot for --fix", async () => {
    const host = await makeHost();
    expect((await host.run()).code).toBe(0);
    host.clearCalls();
    expect((await host.command(["doctor"])).code).toBe(0);
    expect(
      host.calls().some((call) => /restart|stop --computers|systemctl --user stop/.test(call)),
    ).toBe(false);
    host.clearCalls();
    const result = await host.command(["doctor", "--fix"]);
    expect(result.code).toBe(0);
    const calls = host.calls();
    const stopped = calls.findIndex((call) => call.includes("stop --computers"));
    const started = calls.findIndex((call) => call.includes("start localdot-daemon.service"));
    const checked = calls.findIndex((call) =>
      call.startsWith("node --import tsx ../cli/src/main.ts doctor"),
    );
    expect(stopped).toBeGreaterThanOrEqual(0);
    expect(started).toBeGreaterThan(stopped);
    expect(checked).toBeGreaterThan(started);
    expect(calls.some((call) => /docker (rm|restart|volume|system)|prune|reboot/.test(call))).toBe(
      false,
    );
    expect(result.stdout).toContain("Saved apps and files are kept");
  });
  it("does not start services when owned-container shutdown fails", async () => {
    const host = await makeHost();
    expect((await host.run()).code).toBe(0);
    host.clearCalls();
    expect((await host.command(["doctor", "--fix"], { STUB_STOP_COMPUTERS_RC: "1" })).code).toBe(1);
    expect(host.calls().some((call) => call.includes("start localdot-daemon.service"))).toBe(false);
  });
});
