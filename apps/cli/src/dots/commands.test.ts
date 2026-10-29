import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DotInstance } from "../../../../packages/protocol/src/dots.ts";
import type { KeydVault, Sealed } from "../../../../packages/protocol/src/keyd.ts";
import { instanceOf } from "../../../daemon/src/dots/instance.ts";
import { DotsRegistry, registryPath } from "../../../daemon/src/dots/registry.ts";
import { launchdLabels } from "../../../daemon/src/dots/service-names.ts";
import { KeydError } from "../../../daemon/src/keyd/client.ts";
import {
  addDot,
  DotsCommandError,
  type DotsDeps,
  type DotsKeyd,
  dotEnvironmentLines,
  dotIdFor,
  homeProblem,
  refreshDots,
  removeDot,
  startDot,
} from "./commands.ts";
import { blockPorts } from "./ports.ts";
import type { DotServices, ServiceTemplate } from "./services.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
// Short real paths: a dot's folder must fit its sockets.
const folder = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dc-")));
  dirs.push(dir);
  return dir;
};

const SEAL_KEY = "k".repeat(87);
const template: ServiceTemplate = {
  marker: false,
  keyd: { program: "/apps/keyd", args: [] },
  daemon: {
    program: "/apps/node",
    args: ["src/main.ts"],
    env: { HOME: "/Users/a", LOCALDOT_PUBLIC_ORIGIN: "https://studio.example.ts.net:4750" },
    workingDirectory: "/apps/daemon",
  },
};

// The installation's services, key services and daemons, in memory.
function machine(options: { vault?: KeydVault; managed?: boolean; startFails?: boolean } = {}) {
  const root = folder();
  const main = join(root, "ld");
  mkdirSync(main, { mode: 0o700 });
  writeFileSync(
    join(main, "agent.json"),
    JSON.stringify({ name: "Studio", persona: "coder", localDots: [] }),
    { mode: 0o600 },
  );
  const registry = new DotsRegistry(registryPath({ XDG_CONFIG_HOME: join(root, "config") }), main);
  const running = new Set<string>(["main"]);
  const written = new Map<string, { dot: DotInstance; home: string }>();
  const calls: string[] = [];
  const homes = new Map<string, string>([[main, "main"]]);
  const services: DotServices = {
    manager: "launchd",
    names: launchdLabels,
    template: async () => template,
    async write(dot, home) {
      calls.push(`write ${dot.id}`);
      written.set(dot.id, { dot, home });
      homes.set(home, dot.id);
      return true;
    },
    exists: async (id) => written.has(id) || id === "main",
    home: async (id) => [...homes].find(([, dot]) => dot === id)?.[0],
    async start(id, only) {
      calls.push(`start ${id}${only ? ` ${only}` : ""}`);
      if (options.startFails) throw new Error("launchd said no");
      running.add(only ? `${id}:keyd` : id);
      if (!only) running.add(`${id}:keyd`);
    },
    async stop(id) {
      calls.push(`stop ${id}`);
      running.delete(id);
      running.delete(`${id}:keyd`);
    },
    async remove(id) {
      calls.push(`remove ${id}`);
      written.delete(id);
    },
    login: async () => true,
    setLogin: async (id, on) => {
      calls.push(`login ${id} ${on}`);
    },
  };
  const vaults = new Map<string, KeydVault>();
  const keyd = (home: string): DotsKeyd => {
    const id = homes.get(home) ?? "unknown";
    const up = () => {
      if (id !== "main" && !running.has(`${id}:keyd`))
        throw new KeydError(0, "unavailable", "down", "/v1/status");
    };
    return {
      async status() {
        up();
        return {
          sealKey: SEAL_KEY,
          vault:
            vaults.get(home) ??
            (id === "main" ? { backend: "keychain", state: "ready" } : options.vault),
          keyCopy: true,
          vaultForget: true,
        };
      },
      async unlockVault(sealed: Sealed) {
        up();
        calls.push(`unlock ${id} ${sealed.ct}`);
        const vault = {
          backend: "file",
          state: "ready" as const,
          key: "passphrase" as const,
          fingerprint: "f".repeat(32),
        };
        vaults.set(home, vault);
        return vault;
      },
      async copyKeys(destination) {
        up();
        calls.push(`copy ${id} -> ${homes.get(destination)}`);
        if (
          vaults.get(destination)?.state === "setup" ||
          (options.vault?.state === "setup" && !vaults.has(destination))
        )
          throw new KeydError(409, "receiver-locked", "locked", "/v1/keys/copy");
        return { secrets: 3, logins: 1, skipped: 0 };
      },
      async forgetVault() {
        up();
        calls.push(`forget ${id}`);
        return { secrets: 3, logins: 1 };
      },
    };
  };
  const out: string[] = [];
  const deps: DotsDeps = {
    env: {},
    signal: new AbortController().signal,
    registry,
    services,
    managed: options.managed ?? false,
    keyd,
    docker: () => {
      throw new Error("no Docker in this test");
    },
    probe: async () => true,
    running: async (port) =>
      [...written.values()].some((w) => w.dot.ports.app === port && running.has(w.dot.id)) ||
      (port === 4750 && running.has("main")),
    tailscale: {
      serve: async (name, port) => {
        calls.push(`tailscale serve ${port}`);
        return `https://${name}:${port}`;
      },
      off: async (port) => {
        calls.push(`tailscale off ${port}`);
      },
    },
    signInLink: async (_home, port) => `http://127.0.0.1:${port}/#code=${"c".repeat(43)}`,
    waitMs: 2000,
  };
  const io = { out: (line: string) => out.push(line), err: (line: string) => out.push(line) };
  return { root, main, registry, deps, io, out, calls, running, written };
}

describe("adding a dot", () => {
  it("makes its folder, ports, services and keys, and gives a sign-in link", async () => {
    const m = machine();
    const id = await addDot(m.deps, m.io, {
      name: "Work",
      copy: ["settings", "keys", "memory", "skills", "connectors"],
    });
    expect(id).toBe("work");
    const home = `${m.main}-work`;
    expect(instanceOf(home)).toEqual({
      v: 1,
      id: "work",
      name: "Work",
      ports: blockPorts(1),
      keychainService: "localdot-keyd.work",
      publicOrigins: ["https://studio.example.ts.net:5750"],
    });
    expect(JSON.parse(readFileSync(join(home, "agent.json"), "utf8"))).toEqual({
      persona: "coder",
      name: "Work",
    });
    expect(m.registry.read()).toEqual([
      { id: "main", home: m.main },
      { id: "work", home },
    ]);
    expect(m.calls).toEqual([
      "tailscale serve 5750",
      "write work",
      "start work",
      "copy main -> work",
    ]);
    expect(m.out.at(-1)).toBe(`  http://127.0.0.1:5750/#code=${"c".repeat(43)}`);
  });

  it("asks the app for the new dot's own passphrase, sealed, before copying keys", async () => {
    const m = machine({ vault: { backend: "file", state: "setup" } });
    const sealed = { v: 1, epk: "e".repeat(87), nonce: "n".repeat(16), ct: "c".repeat(40) };
    const answers = [JSON.stringify({ sealed })][Symbol.iterator]();
    m.deps.answers = {
      next: async () => answers.next(),
    } as AsyncIterator<string>;
    await addDot(m.deps, { ...m.io, json: true }, { name: "Home", copy: ["keys"] });
    const lines = m.out.map((line) => JSON.parse(line));
    expect(lines).toContainEqual({
      step: "Choose a passphrase for Home's saved keys",
      needs: "passphrase",
      sealKey: SEAL_KEY,
    });
    expect(m.calls).toContain(`unlock home ${"c".repeat(40)}`);
    expect(m.calls.indexOf(`unlock home ${"c".repeat(40)}`)).toBeLessThan(
      m.calls.indexOf("copy main -> home"),
    );
    expect(lines.at(-1)).toEqual({ done: true, dot: "home" });
    expect(readFileSync(join(`${m.main}-home`, "passphrase-chosen"), "utf8").trim()).toBe(
      "f".repeat(32),
    );
  });

  it("undoes the new dot when its passphrase is never given", async () => {
    const m = machine({ vault: { backend: "file", state: "setup" } });
    m.deps.answers = {
      next: async () => ({ done: true, value: undefined }),
    } as AsyncIterator<string>;
    await expect(
      addDot(m.deps, { ...m.io, json: true }, { name: "Home", copy: ["keys"] }),
    ).rejects.toThrow("Adding Home was cancelled.");
    expect(existsSync(`${m.main}-home`)).toBe(false);
    expect(m.registry.read()).toEqual([{ id: "main", home: m.main }]);
    expect(m.calls).toContain("remove home");
    m.deps.answers = { next: () => new Promise(() => {}) } as AsyncIterator<string>;
    m.deps.passphraseWaitMs = 50;
    await expect(
      addDot(m.deps, { ...m.io, json: true }, { name: "Home", copy: ["keys"] }),
    ).rejects.toThrow("was cancelled");
  });

  it("undoes everything when the new dot can't start", async () => {
    const m = machine({ startFails: true });
    await expect(addDot(m.deps, m.io, { name: "Work", copy: ["settings"] })).rejects.toThrow(
      "launchd said no",
    );
    expect(existsSync(`${m.main}-work`)).toBe(false);
    expect(m.registry.read()).toEqual([{ id: "main", home: m.main }]);
    expect(m.calls).toEqual([
      "tailscale serve 5750",
      "write work",
      "start work",
      "remove work",
      "tailscale off 5750",
    ]);
  });

  it("refuses what it can't do before making anything", async () => {
    const m = machine();
    await addDot(m.deps, m.io, { name: "Work", copy: [] });
    for (const [options, message] of [
      [{ name: "work", copy: [] }, "already a dot called work"],
      [{ name: "Home", from: "nowhere", copy: [] }, "no dot called nowhere"],
      [{ name: "Home", copy: [], home: `/${"x".repeat(90)}` }, "too long"],
      [{ name: "Home", copy: [], home: m.main }, "another dot's folder"],
      [{ name: "", copy: [] }, "Give the new dot a name"],
    ] as const)
      await expect(addDot(m.deps, m.io, options), message).rejects.toThrow(message);
    const busy = join(m.root, "busy");
    mkdirSync(busy);
    writeFileSync(join(busy, "file"), "");
    await expect(addDot(m.deps, m.io, { name: "Home", copy: [], home: busy })).rejects.toThrow(
      "already holds files",
    );
    const managed = machine({ managed: true });
    await expect(addDot(managed.deps, managed.io, { name: "Work", copy: [] })).rejects.toThrow(
      DotsCommandError,
    );
  });

  it("gives each dot an id its services and Keychain can use", () => {
    const taken = new Set(["main", "work"]);
    expect(dotIdFor("Work", taken)).toBe("work-2");
    expect(dotIdFor("Main", taken)).toBe("main-2");
    expect(dotIdFor("Café Ünder Mac!", taken)).toBe("cafe-under-mac");
    expect(dotIdFor("2nd", taken)).toBe("dot-2nd");
    expect(dotIdFor("办公室", taken)).toBe("dot");
    expect(homeProblem("relative/path")).toBe("A dot's folder must be an absolute path.");
    expect(homeProblem(`/${"x".repeat(80)}`, "linux")).toContain("at most 60 bytes");
  });
});

describe("the other dot commands", () => {
  it("start and stop a dot, and tell the installer where it lives", async () => {
    const m = machine();
    await addDot(m.deps, m.io, { name: "Work", copy: [] });
    const stopped: [string, number][] = [];
    m.deps.stopComputers = async (home, port) => {
      stopped.push([home, port]);
      return true;
    };
    await startDot(m.deps, m.io, "Work", false);
    expect(m.running.has("work")).toBe(false);
    expect(stopped).toEqual([[`${m.main}-work`, 5750]]);
    await startDot(m.deps, m.io, "work", true);
    expect(m.running.has("work")).toBe(true);
    expect(dotEnvironmentLines(m.deps, "work")).toEqual([
      'DOT_ID="work"',
      `LD_HOME="${m.main}-work"`,
      'PORT="5750"',
      'KEYD_PORTS="5760-5789"',
      'PUBLIC_ORIGIN="https://studio.example.ts.net:5750"',
      'KEYD_SERVICE="dev.localdot.work.keyd"',
      'DAEMON_SERVICE="dev.localdot.work.daemon"',
    ]);
    expect(dotEnvironmentLines(m.deps, "Studio")[0]).toBe('DOT_ID="main"');
  });

  it("refresh every other dot's services after an update and restart the running ones", async () => {
    const m = machine();
    await addDot(m.deps, m.io, { name: "Work", copy: [] });
    await addDot(m.deps, m.io, { name: "Home", copy: [] });
    await startDot(m.deps, m.io, "home", false);
    m.calls.length = 0;
    await refreshDots(m.deps, m.io);
    expect(m.calls).toEqual([
      "write work",
      "login work true",
      "stop work",
      "start work",
      "write home",
      "login home true",
    ]);
  });

  it("remove a dot: its keys, services and entry go; its data stays unless asked", async () => {
    const m = machine();
    await addDot(m.deps, m.io, { name: "Work", copy: [] });
    await addDot(m.deps, m.io, { name: "Home", copy: [] });
    m.deps.docker = () => ({ request: async () => [] as never });
    m.calls.length = 0;
    await removeDot(m.deps, m.io, { dot: "Work", deleteData: false });
    expect(m.calls).toEqual([
      "stop work",
      "start work keyd",
      "forget work",
      "stop work",
      "tailscale off 5750",
      "remove work",
    ]);
    expect(existsSync(join(`${m.main}-work`, "instance.json"))).toBe(true);
    expect(m.registry.read().map((dot) => dot.id)).toEqual(["main", "home"]);
    await removeDot(m.deps, m.io, { dot: "home", deleteData: true });
    expect(existsSync(`${m.main}-home`)).toBe(false);
    await expect(removeDot(m.deps, m.io, { dot: "main", deleteData: true })).rejects.toThrow(
      "The first dot stays",
    );
    expect(existsSync(m.main)).toBe(true);
  });
});
