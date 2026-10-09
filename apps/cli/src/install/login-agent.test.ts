import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type LoginAgentHost,
  nodeLoginAgentHost,
  setStartAtLogin,
  startAtLoginStore,
  syncLoginAgent,
} from "./login-agent.ts";
import { defineLoginService } from "./service-definition.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  // privateRecordStore insists on canonical paths; macOS tmpdir() is a /var -> /private/var link.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ld-login-")));
  roots.push(root);
  const home = join(root, "dot"),
    state = join(home, "install"),
    userHome = join(root, "user");
  for (const dir of [home, state, userHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const uid = process.getuid?.() ?? 501;
  const configuration = {
    settings: {
      state,
      home,
      userHome,
      node: join(state, "runtime", "node", "bin", "node"),
      dockerSocket: join(root, "docker.sock"),
      uid,
      port: 4750,
      ownerId: "a".repeat(32),
    },
    release: { version: "0.4.0", packageSha256: "b".repeat(64), manifestSha256: "c".repeat(64) },
    configuration: "d".repeat(64),
  };
  const bootouts: string[] = [];
  const real = nodeLoginAgentHost(uid);
  const host: LoginAgentHost = {
    ...real,
    bootout: vi.fn(async (target: string) => {
      bootouts.push(target);
    }),
  };
  const expected = defineLoginService(configuration.settings, configuration.release);
  return { root, state, userHome, configuration, host, bootouts, expected };
}
const signal = () => AbortSignal.timeout(5000);

describe("start at login", () => {
  it("is off by default and writes nothing", async () => {
    const f = fixture();
    expect(await syncLoginAgent(f.configuration, f.host, signal())).toBe("off");
    expect(() => statSync(f.expected.plist)).toThrow();
    expect(await startAtLoginStore(f.state).read()).toBeNull();
  });

  it("turning it on records the choice and writes a private plist without loading it now", async () => {
    const f = fixture();
    expect(f.expected.plist.startsWith(f.userHome)).toBe(true);
    expect(await setStartAtLogin(f.configuration, true, f.host, signal())).toBe("on");
    expect(readFileSync(f.expected.plist, "utf8")).toBe(f.expected.contents);
    expect(statSync(f.expected.plist).mode & 0o777).toBe(0o600);
    expect((await startAtLoginStore(f.state).read())?.enabled).toBe(true);
    expect(f.bootouts).toEqual([]);
  });

  it("rewrites the plist when the configured release changes", async () => {
    const f = fixture();
    await setStartAtLogin(f.configuration, true, f.host, signal());
    const next = {
      ...f.configuration,
      release: { ...f.configuration.release, packageSha256: "e".repeat(64) },
    };
    expect(await syncLoginAgent(next, f.host, signal())).toBe("on");
    expect(readFileSync(f.expected.plist, "utf8")).toContain(`${"e".repeat(64)}-${"c".repeat(64)}`);
  });

  it("turning it off removes the plist and unloads the login job", async () => {
    const f = fixture();
    await setStartAtLogin(f.configuration, true, f.host, signal());
    expect(await setStartAtLogin(f.configuration, false, f.host, signal())).toBe("off");
    expect(() => statSync(f.expected.plist)).toThrow();
    expect(f.bootouts).toEqual([f.expected.target]);
  });

  it("refuses to replace a symlink or a file it does not own at the plist path", async () => {
    const f = fixture();
    mkdirSync(f.expected.directory, { recursive: true });
    writeFileSync(join(f.root, "elsewhere"), "x");
    symlinkSync(join(f.root, "elsewhere"), f.expected.plist);
    await expect(setStartAtLogin(f.configuration, true, f.host, signal())).rejects.toThrow(
      "Start at login could not be changed safely.",
    );
    expect(readFileSync(join(f.root, "elsewhere"), "utf8")).toBe("x");
  });
});
