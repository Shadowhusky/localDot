import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IMAGE_ROLES,
  imageRef,
  ReleaseManifest,
} from "../../../../packages/protocol/src/release.ts";
import { sampleManifest } from "../../../../packages/protocol/src/testing/sample-release.ts";
import {
  defineLoginService,
  defineReleaseServices,
  installedServiceDefinitions,
  loginServiceLocation,
  type ServiceSettings,
  serviceConfigurationId,
  serviceLocation,
} from "./service-definition.ts";

const readInstalled = vi.hoisted(() => vi.fn());
vi.mock("./promote-release.ts", () => ({ readInstalledRelease: readInstalled }));
afterEach(() => {
  readInstalled.mockReset();
  vi.unstubAllEnvs();
});
const settings: ServiceSettings = {
  state: "/private/tmp/localdot/install",
  home: "/private/tmp/localdot/home",
  userHome: "/Users/example",
  node: "/opt/node/bin/node",
  dockerSocket: "/private/tmp/docker.sock",
  uid: 501,
  port: 4747,
  ownerId: "e".repeat(32),
};
function fixture() {
  const manifest = ReleaseManifest.parse(sampleManifest());
  manifest.files["dist/daemon.mjs"] = "c".repeat(64);
  const identity = {
    version: manifest.version,
    packageSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
  };
  return { manifest, identity };
}

it("uses isolated per-home labels and exact release paths with all four digest references", () => {
  vi.stubEnv("NODE_OPTIONS", "--require=/untrusted.js");
  vi.stubEnv("OPENAI_API_KEY", "never-pass-this");
  const f = fixture(),
    definitions = defineReleaseServices(settings, f.identity, f.manifest);
  const daemon = definitions.daemon,
    keyd = definitions.keyd;
  expect(daemon.target).toMatch(/^gui\/501\/dev\.localdot\.[a-f0-9]{64}\.[a-f0-9]{32}\.daemon$/);
  expect(daemon.arguments.slice(0, 2)).toEqual(["/usr/bin/env", "-i"]);
  expect(daemon.arguments.slice(-7)).toEqual([
    `${settings.state}/releases/${"a".repeat(64)}-${"b".repeat(64)}/keyd/bin/keyd`,
    "service-exec",
    settings.state,
    settings.home,
    settings.ownerId,
    serviceConfigurationId(settings, f.identity),
    "daemon",
  ]);
  for (const role of IMAGE_ROLES)
    expect(daemon.arguments).toContain(
      `LOCALDOT_${role.toUpperCase()}_IMAGE=${imageRef(f.manifest.images[role])}`,
    );
  expect(daemon.arguments).toContain(`DOCKER_HOST=unix://${settings.dockerSocket}`);
  expect(daemon.contents).not.toMatch(/never-pass-this|untrusted|:dev|:latest/);
  expect(keyd.arguments.slice(-6)).toEqual([
    "service-exec",
    settings.state,
    settings.home,
    settings.ownerId,
    serviceConfigurationId(settings, f.identity),
    "keyd",
  ]);
  expect(keyd.arguments.join(" ")).not.toMatch(/-stun|-natpmp|DOCKER_HOST|_IMAGE/);
  expect(Object.isFrozen(definitions)).toBe(true);
  expect(Object.isFrozen(daemon.arguments)).toBe(true);
  expect(
    serviceLocation(settings.state, `${settings.home}-other`, 501, settings.ownerId, "d".repeat(64))
      .daemon.label,
  ).not.toBe(daemon.label);
  expect(
    serviceLocation(`${settings.state}-other`, settings.home, 501, settings.ownerId, "d".repeat(64))
      .daemon.label,
  ).toBe(daemon.label);
  const next = { ...f.identity, version: "2.0.0" },
    manifest = { ...f.manifest, version: "2.0.0" };
  expect(defineReleaseServices(settings, next, manifest).daemon.label).toBe(daemon.label);
});

it.runIf(process.platform === "darwin")(
  "roundtrips XML and literal arguments through Apple's plist parser without loading services",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "localdot-plist-"));
    try {
      const f = fixture();
      const home = '/private/tmp/Richard’s <test> & "quote" $HOME $(echo nope)';
      const defs = defineReleaseServices({ ...settings, home }, f.identity, f.manifest);
      for (const role of ["daemon", "keyd"] as const) {
        const file = join(root, `${role}.plist`);
        await writeFile(file, defs[role].contents, { mode: 0o600 });
        const { stdout } = await promisify(execFile)(
          "/usr/bin/plutil",
          ["-convert", "json", "-o", "-", file],
          { maxBuffer: 64 * 1024 },
        );
        const parsed = JSON.parse(stdout);
        expect(parsed.ProgramArguments).toEqual(defs[role].arguments);
        expect(parsed.WorkingDirectory).toBe(home);
        expect(parsed.KeepAlive).toBe(false);
        expect(parsed.RunAtLoad).toBe(false);
        expect(parsed.Umask).toBe(63);
        expect(parsed.ExitTimeOut).toBe(20);
        expect(parsed.StandardOutPath).toBe(`${settings.state}/logs/${role}.log`);
        expect(parsed.StandardErrorPath).toBe(`${settings.state}/logs/${role}.error.log`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([
  "relative",
  "/",
  "/private/tmp/../home",
  "/private/tmp/bad\nname",
  "/private/tmp/\ud800",
  `/private/tmp/${"a".repeat(1024)}`,
])("refuses unsafe path %j in each path setting", (value) => {
  const f = fixture();
  for (const field of ["home", "state", "node", "userHome", "dockerSocket"])
    expect(() =>
      defineReleaseServices({ ...settings, [field]: value }, f.identity, f.manifest),
    ).toThrow();
});
it.each([0, -1, 1.5, NaN, Infinity, 0xffff_ffff])("refuses invalid service UID %s", (uid) => {
  expect(() =>
    serviceLocation(settings.state, settings.home, uid, settings.ownerId, "d".repeat(64)),
  ).toThrow();
});
it.each([0, 1023, 65536, 4747.5, NaN])("refuses invalid daemon port %s", (port) => {
  const f = fixture();
  expect(() => defineReleaseServices({ ...settings, port }, f.identity, f.manifest)).toThrow();
});
it("rejects incompatible release metadata, missing runtime and unsafe socket/node paths", () => {
  const f = fixture();
  expect(() =>
    defineReleaseServices(settings, { ...f.identity, version: "9.9.9" }, f.manifest),
  ).toThrow();
  delete f.manifest.files["dist/daemon.mjs"];
  expect(() => defineReleaseServices(settings, f.identity, f.manifest)).toThrow();
  for (const patch of [{ dockerSocket: "/tmp/sock?x" }, { node: "/opt/a:b/node" }]) {
    const next = fixture();
    expect(() =>
      defineReleaseServices({ ...settings, ...patch }, next.identity, next.manifest),
    ).toThrow();
  }
});
it("production entry reopens the anchor and snapshots inputs before awaiting verification", async () => {
  const f = fixture(),
    mutable = { ...settings };
  let finish!: (result: { manifest: typeof f.manifest }) => void;
  readInstalled.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const signal = new AbortController().signal;
  const pending = installedServiceDefinitions(mutable, f.identity, signal);
  mutable.node = "/untrusted/node";
  f.identity.packageSha256 = "d".repeat(64);
  finish({ manifest: f.manifest });
  const result = await pending;
  expect(readInstalled).toHaveBeenCalledWith(
    settings.state,
    expect.objectContaining({ packageSha256: "a".repeat(64) }),
    signal,
  );
  expect(result.daemon.arguments).toContain("PATH=/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  expect(result.daemon.arguments).not.toContain(mutable.node);
});
it("verification failure or cancellation yields no service definitions", async () => {
  const f = fixture(),
    controller = new AbortController();
  readInstalled.mockRejectedValueOnce(new Error("untrusted"));
  await expect(
    installedServiceDefinitions(settings, f.identity, controller.signal),
  ).rejects.toThrow("untrusted");
  readInstalled.mockImplementation(async () => {
    controller.abort(new Error("cancel"));
    return { manifest: f.manifest };
  });
  await expect(
    installedServiceDefinitions(settings, f.identity, controller.signal),
  ).rejects.toThrow("cancel");
  readInstalled.mockClear();
  await expect(
    installedServiceDefinitions(settings, f.identity, controller.signal),
  ).rejects.toThrow("cancel");
  expect(readInstalled).not.toHaveBeenCalled();
});

it("separates ownership generations and refuses malformed ownership inputs", () => {
  const f = fixture();
  const first = defineReleaseServices(settings, f.identity, f.manifest);
  const next = defineReleaseServices(
    { ...settings, ownerId: "f".repeat(32) },
    f.identity,
    f.manifest,
  );
  expect(next.daemon.label).not.toBe(first.daemon.label);
  expect(next.daemon.plist).not.toBe(first.daemon.plist);
  for (const id of ["", "foreign", "a".repeat(31), "A".repeat(32), `../${"a".repeat(32)}`])
    expect(() =>
      defineReleaseServices({ ...settings, ownerId: id }, f.identity, f.manifest),
    ).toThrow();
});

const loginSettings = {
  state: "/Users/sam/.localdot/install",
  home: "/Users/sam/.localdot",
  userHome: "/Users/sam",
  node: "/Users/sam/.localdot/install/runtime/node/bin/node",
  dockerSocket: "/Users/sam/.docker/run/docker.sock",
  uid: 501,
  port: 4750,
  ownerId: "a".repeat(32),
};
const loginRelease = {
  version: "0.4.0",
  packageSha256: "b".repeat(64),
  manifestSha256: "c".repeat(64),
};

describe("start at login agent", () => {
  it("lives in the user's LaunchAgents folder under a per-installation label", () => {
    const suffix = createHash("sha256").update(loginSettings.home).digest("hex");
    const label = `dev.localdot.${suffix}.${"a".repeat(32)}.login`;
    expect(loginServiceLocation(loginSettings)).toEqual({
      label,
      domain: "gui/501",
      target: `gui/501/${label}`,
      directory: "/Users/sam/Library/LaunchAgents",
      plist: `/Users/sam/Library/LaunchAgents/${label}.plist`,
    });
  });

  it("runs the installed CLI's verified up path once at login, with a cleared environment", () => {
    const login = defineLoginService(loginSettings, loginRelease);
    expect(login.arguments).toEqual([
      "/usr/bin/env",
      "-i",
      "HOME=/Users/sam",
      "PATH=/Users/sam/.localdot/install/runtime/node/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      "LANG=en_US.UTF-8",
      "LOCALDOT_HOME=/Users/sam/.localdot",
      "/Users/sam/.localdot/install/runtime/node/bin/node",
      `/Users/sam/.localdot/install/releases/${"b".repeat(64)}-${"c".repeat(64)}/app/bin/localdot.mjs`,
      "up",
      "--from-login",
    ]);
    expect(login.contents).toContain("<key>RunAtLoad</key><true/>");
    expect(login.contents).toContain("<key>KeepAlive</key><false/>");
    expect(login.contents).toContain("<key>LimitLoadToSessionType</key><string>Aqua</string>");
    expect(login.contents).toContain("<key>Umask</key><integer>63</integer>");
    expect(login.contents).toContain(
      "<key>StandardOutPath</key><string>/Users/sam/.localdot/install/logs/login.log</string>",
    );
    expect(login.contents).not.toMatch(/token|secret|LOCALDOT_PORT|DOCKER_HOST/i);
  });

  it("escapes XML and refuses unsafe paths", () => {
    const odd = { ...loginSettings, userHome: "/Users/s&m" };
    expect(defineLoginService(odd, loginRelease).contents).toContain(
      "<string>HOME=/Users/s&amp;m</string>",
    );
    for (const bad of ["relative/home", "/Users/sam/../x", "/Users/sam\nx", "/"])
      expect(() => defineLoginService({ ...loginSettings, userHome: bad }, loginRelease)).toThrow(
        "Invalid localDot service configuration.",
      );
  });

  it("leaves the two service plists without RunAtLoad or KeepAlive", () => {
    const { manifest, identity } = fixture();
    const services = defineReleaseServices(settings, identity, manifest);
    for (const role of ["keyd", "daemon"] as const) {
      expect(services[role].contents).toContain("<key>RunAtLoad</key><false/>");
      expect(services[role].contents).toContain("<key>KeepAlive</key><false/>");
    }
  });
});
