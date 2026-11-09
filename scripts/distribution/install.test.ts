import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dot-package-install-"));
  roots.push(root);
  for (const dir of ["app", "bin", "runtime", "data"]) mkdirSync(join(root, dir));
  for (const file of ["app/identity", "bin/keyd", "keyd.service", "daemon.service", "install.env"])
    writeFileSync(join(root, file), "previous");
  writeFileSync(join(root, "data", "user-file"), "keep me");
  const setup = `
source "$INSTALLER"
PREFIX=$TEST_ROOT APP=$TEST_ROOT/app RUNTIME=$TEST_ROOT/runtime
KEYD_FILE=$TEST_ROOT/keyd.service DAEMON_FILE=$TEST_ROOT/daemon.service LD_HOME=$TEST_ROOT/data
OPT_REF="" OPT_REPO="" OPT_REGISTRY=""
prepare_prerequisites() { :; }; check_prerequisites() { :; }; check_port() { :; }
ensure_node() { :; }; check_install_storage() { :; }
prepare_package() {
  echo download >> "$TEST_ROOT/order"
  [ "$FAIL" != download ] || die "download failed"
  PACKAGE_SCRATCH=$(mktemp -d "$RUNTIME/.package.XXXXXX")
  PACKAGE_STAGE=$PACKAGE_SCRATCH/app
  mkdir "$PACKAGE_STAGE"
  echo candidate > "$PACKAGE_STAGE/identity"
  echo keyd-new > "$PACKAGE_STAGE/keyd"
}
stop_services() { echo stop >> "$TEST_ROOT/order"; }
stop_daemon() { echo stop-daemon >> "$TEST_ROOT/order"; }
start_services() {
  echo "start $(cat "$APP/identity")" >> "$TEST_ROOT/order"
  if [ "$FAIL" = hang ] && [ "$(cat "$APP/identity")" = candidate ]; then sleep 30; fi
}
eval "$(declare -f update_stage | sed '1s/update_stage/record_stage/')"
update_stage() { echo "$1 \${UPDATE_PROBLEM:-}" >> "$TEST_ROOT/stages"; record_stage "$@"; }
configure_remote_access() { :; }; install_command() { :; }
write_services() { echo candidate > "$KEYD_FILE"; echo candidate > "$DAEMON_FILE"; }
write_state() { echo candidate > "$PREFIX/install.env"; }
finish() {
  update_stage check
  if [ "$FAIL" = startup ]; then UPDATE_PROBLEM=checks; die "startup failed"; fi
}
if [ -n "\${KEEP_KEYD:-}" ]; then echo keyd-new > "$PREFIX/bin/keyd"; fi
run_package_install
`;
  const environment = (fail: string, status: boolean, extra: Record<string, string> = {}) => ({
    ...process.env,
    TEST_ROOT: root,
    FAIL: fail,
    INSTALLER: join(process.cwd(), "install.sh"),
    ...(status ? { LOCALDOT_UPDATE_STATUS: join(root, "status.json") } : {}),
    ...extra,
  });
  const run = (fail = "", status = false, extra: Record<string, string> = {}) => {
    try {
      execFileSync("/bin/bash", ["-c", setup], {
        env: environment(fail, status, extra),
        stdio: "pipe",
      });
      return 0;
    } catch (e) {
      return (e as { status: number }).status;
    }
  };
  // In the background, as far as a swap that won't end by itself, to be killed.
  const start = (fail: string) =>
    spawn("/bin/bash", ["-c", setup], { env: environment(fail, true), stdio: "ignore" });
  return { root, run, start, setup, read: (path: string) => readFileSync(join(root, path), "utf8").trim() };
}
it("downloads before stopping services and retains the previous app without touching computer data", () => {
  const f = fixture();
  expect(f.run()).toBe(0);
  expect(f.read("order")).toBe("download\nstop\nstart candidate");
  expect(f.read("app/identity")).toBe("candidate");
  expect(f.read("app.previous/identity")).toBe("previous");
  expect(f.read("data/user-file")).toBe("keep me");
  expect(existsSync(join(f.root, ".package-install.lock"))).toBe(false);
});
it("a download failure cannot stop or modify the installed app", () => {
  const f = fixture();
  expect(f.run("download")).not.toBe(0);
  expect(f.read("order")).toBe("download");
  expect(f.read("app/identity")).toBe("previous");
  expect(f.read("install.env")).toBe("previous");
  expect(existsSync(join(f.root, ".package-install.lock"))).toBe(false);
});
it("restores the app, helper and service definitions after failed startup", () => {
  const f = fixture();
  expect(f.run("startup")).not.toBe(0);
  for (const file of ["app/identity", "bin/keyd", "keyd.service", "daemon.service", "install.env"])
    expect(f.read(file)).toBe("previous");
  expect(f.read("order")).toBe("download\nstop\nstart candidate\nstop\nstart previous");
  expect(f.read("data/user-file")).toBe("keep me");
});
it("refuses another installer's lock without touching it", () => {
  const f = fixture();
  const lock = join(f.root, ".package-install.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), String(process.pid));
  expect(f.run()).not.toBe(0);
  expect(existsSync(join(f.root, "order"))).toBe(false);
  expect(f.read(".package-install.lock/pid")).toBe(String(process.pid));
});
it("refuses a lock symlink without writing outside the install directory", () => {
  const f = fixture();
  symlinkSync(join(f.root, "data"), join(f.root, ".package-install.lock"));
  expect(f.run()).not.toBe(0);
  expect(existsSync(join(f.root, "data/pid"))).toBe(false);
});

it("a published installer does not inherit a previous source-only channel", () => {
  const f = fixture();
  writeFileSync(
    join(f.root, "install.env"),
    `# Managed by localDot's install.sh\nLOCALDOT_PACKAGE_CHANNEL=""\n`,
  );
  const result = execFileSync(
    "/bin/bash",
    [
      "-c",
      `source "$INSTALLER"
parse_args --prefix "$TEST_ROOT"
DEFAULT_PACKAGE_CHANNEL=https://downloads.localdot.dev/channels/testing.json
resolve_settings
printf '%s' "$PACKAGE_CHANNEL"`,
    ],
    {
      env: {
        ...process.env,
        HOME: f.root,
        TEST_ROOT: f.root,
        INSTALLER: join(process.cwd(), "install.sh"),
      },
      encoding: "utf8",
    },
  );
  expect(result).toBe("https://downloads.localdot.dev/channels/releases.json");
});

it("moves a saved legacy channel to the main repository channel", () => {
  const f = fixture();
  writeFileSync(
    join(f.root, "install.env"),
    '# Managed by localDot\'s install.sh\nLOCALDOT_PACKAGE_CHANNEL="https://downloads.localdot.dev/channels/testing.json"\n',
  );
  const channel = execFileSync(
    "/bin/bash",
    [
      "-c",
      'source "$INSTALLER"; parse_args --prefix "$TEST_ROOT"; resolve_settings; printf "%s" "$PACKAGE_CHANNEL"',
    ],
    {
      env: {
        ...process.env,
        HOME: f.root,
        TEST_ROOT: f.root,
        INSTALLER: join(process.cwd(), "install.sh"),
      },
      encoding: "utf8",
    },
  );
  expect(channel).toBe("https://downloads.localdot.dev/channels/releases.json");
});

it.each([false, true])(
  "checks the new verifier pin before using an older installation (corrupt=%s)",
  (corrupt) => {
    const f = fixture();
    mkdirSync(join(f.root, "app", "dist"));
    writeFileSync(join(f.root, "app", "bootstrap.mjs"), "legacy verifier");
    writeFileSync(join(f.root, "app", "dist", "package-bootstrap.mjs"), "stale verifier");
    mkdirSync(join(f.root, "node", "bin"), { recursive: true });
    writeFileSync(
      join(f.root, "node", "bin", "node"),
      '#!/bin/bash\nprintf "%s" "$1" > "$TEST_ROOT/selected-verifier"\nexit 1\n',
      { mode: 0o700 },
    );
    const payload = "new pinned verifier";
    writeFileSync(join(f.root, "incoming"), corrupt ? "wrong bytes" : payload);
    const script = `source "$INSTALLER"
PREFIX=$TEST_ROOT APP=$TEST_ROOT/app RUNTIME=$TEST_ROOT/runtime NODE_DIR=$TEST_ROOT/node
OPT_PACKAGE_VERSION=""
PACKAGE_BOOTSTRAP_SHA256=$PIN PACKAGE_CHANNEL=https://downloads.localdot.dev/channels/releases.json NODE_PLATFORM=darwin-arm64
curl() { while [ "$1" != -o ]; do shift; done; cp "$TEST_ROOT/incoming" "$2"; }
prepare_package`;
    expect(() =>
      execFileSync("/bin/bash", ["-c", script], {
        env: {
          ...process.env,
          TEST_ROOT: f.root,
          PIN: createHash("sha256").update(payload).digest("hex"),
          INSTALLER: join(process.cwd(), "install.sh"),
        },
        stdio: "pipe",
      }),
    ).toThrow();
    if (corrupt) expect(existsSync(join(f.root, "selected-verifier"))).toBe(false);
    else expect(f.read("selected-verifier")).toBe(join(f.root, "runtime", "bootstrap.mjs"));
    expect(f.read("app/identity")).toBe("previous");
  },
);

it("hands the app's kept archive to the verifier and pulls only images Docker lacks", () => {
  const f = fixture();
  const verifier = "pinned verifier";
  mkdirSync(join(f.root, "app", "dist"));
  writeFileSync(join(f.root, "app", "dist", "package-bootstrap.mjs"), verifier);
  mkdirSync(join(f.root, "node", "bin"), { recursive: true });
  // Plays the verifier's prepare, and is Node for the installer's reads of its record.
  writeFileSync(
    join(f.root, "node", "bin", "node"),
    `#!/bin/bash
if [ "$2" = prepare ]; then
  printf '%s\\n' "$@" > "$TEST_ROOT/verifier-args"
  mkdir -p "$6"
  printf '{"commit":"c","images":{"desktop":"d@x","gate":"g@x","brain":"b@x","browser":"w@x"}}' > "$6/package-release.json"
  exit 0
fi
exec "${process.execPath}" "$@"
`,
    { mode: 0o700 },
  );
  const script = `source "$INSTALLER"
PREFIX=$TEST_ROOT APP=$TEST_ROOT/app RUNTIME=$TEST_ROOT/runtime NODE_DIR=$TEST_ROOT/node
OPT_PACKAGE_VERSION=0.1.0-rc.2 PACKAGE_BOOTSTRAP_SHA256=$PIN NODE_PLATFORM=darwin-arm64
PACKAGE_CHANNEL=https://downloads.localdot.dev/channels/releases.json
docker() {
  if [ "$1 $2" = "image inspect" ]; then [ "$3" = d@x ] || [ "$3" = g@x ]; return; fi
  echo "$*" >> "$TEST_ROOT/pulled"
}
prepare_package`;
  execFileSync("/bin/bash", ["-c", script], {
    env: {
      ...process.env,
      TEST_ROOT: f.root,
      PIN: createHash("sha256").update(verifier).digest("hex"),
      INSTALLER: join(process.cwd(), "install.sh"),
      LOCALDOT_PACKAGE_ARCHIVE: "/kept/app.tgz",
    },
    stdio: "pipe",
  });
  const args = f.read("verifier-args").split("\n");
  expect(args.slice(1, 4)).toEqual([
    "prepare",
    "https://downloads.localdot.dev/channels/releases.json",
    "darwin-arm64",
  ]);
  expect(args.slice(6)).toEqual(["0.1.0-rc.2", "/kept/app.tgz"]);
  expect(f.read("pulled")).toBe("pull b@x\npull w@x");
});

it("records how an update from the app gets on, for whichever daemon reads it next", () => {
  const f = fixture();
  expect(f.run("", true)).toBe(0);
  expect(f.read("stages").split("\n")).toEqual(["prepare ", "stop ", "start ", "check ", "done"]);
  expect(JSON.parse(f.read("status.json"))).toMatchObject({
    v: 1,
    stage: "done",
    restored: false,
  });
});
it("records a failure before the swap as nothing changed, and one after it as restored", () => {
  const before = fixture();
  expect(before.run("download", true)).not.toBe(0);
  expect(JSON.parse(before.read("status.json"))).toMatchObject({ stage: "failed", restored: false });
  const after = fixture();
  expect(after.run("startup", true)).not.toBe(0);
  expect(JSON.parse(after.read("status.json"))).toMatchObject({
    stage: "failed",
    problem: "checks",
    restored: true,
  });
});
it("leaves an unchanged key service running, and only what it stopped is started again", () => {
  const f = fixture();
  expect(f.run("startup", false, { KEEP_KEYD: "1" })).not.toBe(0);
  expect(f.read("order")).toBe(
    "download\nstop-daemon\nstart candidate\nstop-daemon\nstart previous",
  );
});
it("records another installer's lock as a reason, not a mystery", () => {
  const f = fixture();
  const lock = join(f.root, ".package-install.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), String(process.pid));
  expect(f.run("", true)).not.toBe(0);
  expect(JSON.parse(f.read("status.json"))).toMatchObject({ stage: "failed", problem: "busy" });
});
it("puts the previous version back when the installer is killed part-way through the swap", async () => {
  const f = fixture();
  const installer = f.start("hang");
  await vi.waitFor(() => expect(f.read("order")).toContain("start candidate"), { timeout: 10_000 });
  expect(existsSync(join(f.root, ".package-swap"))).toBe(true);
  installer.kill("SIGKILL");
  await vi.waitFor(() => expect(f.read("order")).toContain("start previous"), { timeout: 10_000 });
  await vi.waitFor(
    () =>
      expect(JSON.parse(f.read("status.json"))).toMatchObject({
        stage: "failed",
        problem: "interrupted",
        restored: true,
      }),
    { timeout: 10_000 },
  );
  expect(f.read("app/identity")).toBe("previous");
  expect(existsSync(join(f.root, ".package-swap"))).toBe(false);
  expect(existsSync(join(f.root, ".package-install.lock"))).toBe(false);
}, 30_000);
it("finishes the undoing on the next start when nothing could at the time, as after a power cut", () => {
  const f = fixture();
  rmSync(join(f.root, "app"), { recursive: true });
  mkdirSync(join(f.root, "app"));
  writeFileSync(join(f.root, "app/identity"), "candidate");
  mkdirSync(join(f.root, "app.previous"));
  writeFileSync(join(f.root, "app.previous/identity"), "previous");
  const rollback = join(f.root, "runtime/.rollback.crashed");
  mkdirSync(rollback);
  writeFileSync(join(rollback, "state"), "previous");
  writeFileSync(join(f.root, ".package-swap"), `${rollback}\n`);
  const script = `source "$INSTALLER"
PREFIX=$TEST_ROOT APP=$TEST_ROOT/app RUNTIME=$TEST_ROOT/runtime
KEYD_FILE=$TEST_ROOT/keyd.service DAEMON_FILE=$TEST_ROOT/daemon.service LD_HOME=$TEST_ROOT/data
stop_services() { echo stop >> "$TEST_ROOT/order"; }
start_services() { echo "start $(cat "$APP/identity")" >> "$TEST_ROOT/order"; }
recover_package_swap`;
  execFileSync("/bin/bash", ["-c", script], {
    env: { ...process.env, TEST_ROOT: f.root, INSTALLER: join(process.cwd(), "install.sh") },
    stdio: "pipe",
  });
  expect(f.read("app/identity")).toBe("previous");
  expect(f.read("install.env")).toBe("previous");
  expect(f.read("order")).toContain("start previous");
  expect(existsSync(join(f.root, ".package-swap"))).toBe(false);
});
it("doesn't open a browser or wait for a terminal when the app started the update", () => {
  const f = fixture();
  const script = `source "$INSTALLER"
wait_ready() { :; }
offer_unlock() { echo unlock >> "$TEST_ROOT/order"; }
show_link() { echo link >> "$TEST_ROOT/order"; }
cli() { echo "cli $*" >> "$TEST_ROOT/order"; }
finish`;
  execFileSync("/bin/bash", ["-c", script], {
    env: {
      ...process.env,
      TEST_ROOT: f.root,
      LOCALDOT_UPDATE_STATUS: join(f.root, "status.json"),
      INSTALLER: join(process.cwd(), "install.sh"),
    },
    stdio: "pipe",
  });
  expect(f.read("order")).toBe("cli doctor");
});
it("still opens a browser for a person running the installer", () => {
  const f = fixture();
  const script = `source "$INSTALLER"
wait_ready() { :; }
offer_unlock() { echo unlock >> "$TEST_ROOT/order"; }
show_link() { echo link >> "$TEST_ROOT/order"; }
cli() { echo "cli $*" >> "$TEST_ROOT/order"; }
finish`;
  execFileSync("/bin/bash", ["-c", script], {
    env: { ...process.env, TEST_ROOT: f.root, INSTALLER: join(process.cwd(), "install.sh") },
    stdio: "pipe",
  });
  expect(f.read("order").split("\n")).toEqual(["unlock", "cli doctor", "link"]);
});
it("gives up on a check that hangs, and calls it a failed check", () => {
  const f = fixture();
  mkdirSync(join(f.root, "node", "bin"), { recursive: true });
  writeFileSync(
    join(f.root, "node", "bin", "node"),
    '#!/bin/bash\ncase "$1" in -e) exit 0 ;; esac\nexec sleep 20\n',
    { mode: 0o700 },
  );
  const script = `source "$INSTALLER"
UPDATE_CHECK_SECONDS=1 APP=$TEST_ROOT/app NODE_DIR=$TEST_ROOT/node
PACKAGE_CHANNEL=https://downloads.localdot.dev/channels/releases.json
wait_ready() { :; }
finish`;
  const started = Date.now();
  expect(() =>
    execFileSync("/bin/bash", ["-c", script], {
      env: {
        ...process.env,
        TEST_ROOT: f.root,
        LOCALDOT_UPDATE_STATUS: join(f.root, "status.json"),
        INSTALLER: join(process.cwd(), "install.sh"),
      },
      stdio: "pipe",
    }),
  ).toThrow();
  expect(Date.now() - started).toBeLessThan(10_000);
});
it.each([
  [3, "network"],
  [4, "stalled"],
  [5, "disk"],
  [6, "verify"],
  [7, "channel"],
] as const)("passes on what stopped the verifier: exit %i", (code, problem) => {
  const f = fixture();
  mkdirSync(join(f.root, "app", "dist"));
  writeFileSync(join(f.root, "app", "dist", "package-bootstrap.mjs"), "pinned verifier");
  mkdirSync(join(f.root, "node", "bin"), { recursive: true });
  writeFileSync(join(f.root, "node", "bin", "node"), `#!/bin/bash\nexit ${code}\n`, { mode: 0o700 });
  const script = `source "$INSTALLER"
PREFIX=$TEST_ROOT APP=$TEST_ROOT/app RUNTIME=$TEST_ROOT/runtime NODE_DIR=$TEST_ROOT/node
OPT_PACKAGE_VERSION="" PACKAGE_BOOTSTRAP_SHA256=$PIN NODE_PLATFORM=darwin-arm64
PACKAGE_CHANNEL=https://downloads.localdot.dev/channels/releases.json
trap 'update_stage failed' EXIT
prepare_package`;
  expect(() =>
    execFileSync("/bin/bash", ["-c", script], {
      env: {
        ...process.env,
        TEST_ROOT: f.root,
        PIN: createHash("sha256").update("pinned verifier").digest("hex"),
        LOCALDOT_UPDATE_STATUS: join(f.root, "status.json"),
        INSTALLER: join(process.cwd(), "install.sh"),
      },
      stdio: "pipe",
    }),
  ).toThrow();
  expect(JSON.parse(f.read("status.json")).problem).toBe(problem);
});
it("the installed command gets the app back if a crash left it set aside", () => {
  const f = fixture();
  rmSync(join(f.root, "app"), { recursive: true });
  const script = `source "$INSTALLER"
PREFIX=$TEST_ROOT APP=$TEST_ROOT/app HOME=$TEST_ROOT
install_command`;
  execFileSync("/bin/bash", ["-c", script], {
    env: { ...process.env, TEST_ROOT: f.root, INSTALLER: join(process.cwd(), "install.sh") },
    stdio: "pipe",
  });
  const shim = f.read("bin/localdot");
  expect(shim).toContain("app.previous");
});
it("a source update that fails puts the old commit back and starts it", () => {
  const f = fixture();
  const script = `source "$INSTALLER"
PREFIX=$TEST_ROOT APP=$TEST_ROOT/app RUNTIME=$TEST_ROOT/runtime LD_HOME=$TEST_ROOT/data
LOCALDOT_UPDATE_RESTORE=aaaa
git() { case "$*" in *rev-parse*) echo bbbb ;; *checkout*) echo "checkout $*" >> "$TEST_ROOT/order" ;; esac; }
stop_services() { echo stop >> "$TEST_ROOT/order"; }
build_app() { echo build >> "$TEST_ROOT/order"; }
build_keyd() { KEYD_CHANGED=1; }
write_services() { :; }
write_state() { echo state >> "$TEST_ROOT/order"; }
start_services() { echo "start $1 $2" >> "$TEST_ROOT/order"; }
trap source_update_exit EXIT
die "The build failed"`;
  expect(() =>
    execFileSync("/bin/bash", ["-c", script], {
      env: {
        ...process.env,
        TEST_ROOT: f.root,
        LOCALDOT_UPDATE_STATUS: join(f.root, "status.json"),
        INSTALLER: join(process.cwd(), "install.sh"),
      },
      stdio: "pipe",
    }),
  ).toThrow();
  expect(f.read("order").split("\n")).toEqual([
    "stop",
    "checkout -C " + join(f.root, "app") + " -c advice.detachedHead=false checkout --quiet --detach aaaa",
    "build",
    "start 1 1",
    "state",
  ]);
  expect(JSON.parse(f.read("status.json"))).toMatchObject({ stage: "failed", restored: true });
});
