import { execFileSync } from "node:child_process";
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
import { afterEach, expect, it } from "vitest";

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
start_services() { echo "start $(cat "$APP/identity")" >> "$TEST_ROOT/order"; }
configure_remote_access() { :; }; install_command() { :; }
write_services() { echo candidate > "$KEYD_FILE"; echo candidate > "$DAEMON_FILE"; }
write_state() { echo candidate > "$PREFIX/install.env"; }
finish() { [ "$FAIL" != startup ] || die "startup failed"; }
run_package_install
`;
  const run = (fail = "") => {
    try {
      execFileSync("/bin/bash", ["-c", setup], {
        env: {
          ...process.env,
          TEST_ROOT: root,
          FAIL: fail,
          INSTALLER: join(process.cwd(), "install.sh"),
        },
        stdio: "pipe",
      });
      return 0;
    } catch (e) {
      return (e as { status: number }).status;
    }
  };
  return { root, run, read: (path: string) => readFileSync(join(root, path), "utf8").trim() };
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
