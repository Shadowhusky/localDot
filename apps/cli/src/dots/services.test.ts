import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DotInstance } from "../../../../packages/protocol/src/dots.ts";
import {
  type ExecResult,
  INSTALLER_MARKER,
  launchdServices,
  ServicesError,
  systemdServices,
  systemdWord,
  systemdWords,
} from "./services.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "dot-services-"));
  dirs.push(dir);
  return dir;
};
const work: DotInstance = {
  v: 1,
  id: "work",
  name: "Work",
  ports: { app: 5750, tool: 5751, keyd: [5760, 5789], preview: [5850, 5865] },
  keychainService: "localdot-keyd.work",
  publicOrigins: ["https://studio.example.ts.net:5750"],
};

// launchctl, plutil and systemctl as a record of what was asked of them.
function host(
  answers: (command: string, args: readonly string[]) => Partial<ExecResult> = () => ({}),
) {
  const calls: string[] = [];
  return {
    calls,
    exec: async (command: string, args: readonly string[]) => {
      calls.push([command.split("/").at(-1), ...args].join(" "));
      return { code: 0, stdout: "", stderr: "", ...answers(command, args) };
    },
  };
}

describe("launchd services for a dot", () => {
  const plists = new Map<string, unknown>();
  const launchd = (directory: string, loaded = new Set<string>()) => {
    const h = host((command, args) => {
      const label = String(args[1]).split("/").at(-1) ?? "";
      if (!command.endsWith("launchctl")) return {};
      if (args[0] === "bootout") loaded.delete(label);
      return args[0] === "print" ? { code: loaded.has(label) ? 0 : 113 } : {};
    });
    return {
      ...h,
      services: launchdServices({
        exec: h.exec,
        uid: 501,
        directory,
        readPlist: async (file) => {
          if (!plists.has(file)) throw new Error("missing");
          return plists.get(file);
        },
      }),
    };
  };
  const firstDot = (directory: string, marker = false) => {
    plists.set(join(directory, "dev.localdot.keyd.plist"), {
      Label: "dev.localdot.keyd",
      ProgramArguments: [
        "/apps/localdot/bin/keyd",
        "-home",
        "/Users/a/.localdot",
        "-vault",
        "file",
      ],
    });
    plists.set(join(directory, "dev.localdot.daemon.plist"), {
      Label: "dev.localdot.daemon",
      ProgramArguments: ["/apps/node/bin/node", "--import", "tsx", "src/main.ts"],
      WorkingDirectory: "/apps/localdot/app/apps/daemon",
      EnvironmentVariables: {
        HOME: "/Users/a",
        PATH: "/apps/node/bin:/usr/bin:/bin",
        LOCALDOT_HOME: "/Users/a/.localdot",
        LOCALDOT_PORT: "4750",
        LOCALDOT_PUBLIC_ORIGIN: "https://studio.example.ts.net:4750",
        LOCALDOT_INSTALL_PREFIX: "/apps/localdot",
        LOCALDOT_DESKTOP_IMAGE: "ghcr.io/x/desktop@sha256:1",
      },
    });
    writeFileSync(
      join(directory, "dev.localdot.daemon.plist"),
      marker ? `<!-- ${INSTALLER_MARKER} -->` : "<plist/>",
    );
  };

  it("are made from the first dot's, with this dot's names, folder, ports and Keychain service", async () => {
    const directory = folder();
    const home = join(folder(), "dot-work");
    firstDot(directory, true);
    const { services } = launchd(directory);
    expect(services.names("main")).toEqual({
      keyd: "dev.localdot.keyd",
      daemon: "dev.localdot.daemon",
    });
    expect(services.names("work")).toEqual({
      keyd: "dev.localdot.work.keyd",
      daemon: "dev.localdot.work.daemon",
    });
    const template = await services.template();
    expect(template.keyd).toEqual({ program: "/apps/localdot/bin/keyd", args: ["-vault", "file"] });
    expect(template.marker).toBe(true);
    expect(await services.write(work, home, template)).toBe(true);
    expect(await services.write(work, home, template)).toBe(false);
    const keyd = readFileSync(join(directory, "dev.localdot.work.keyd.plist"), "utf8");
    const daemon = readFileSync(join(directory, "dev.localdot.work.daemon.plist"), "utf8");
    expect(daemon).toContain(INSTALLER_MARKER);
    expect(keyd).toContain("<string>dev.localdot.work.keyd</string>");
    expect(keyd).toContain(
      `<array><string>/apps/localdot/bin/keyd</string><string>-home</string><string>${home}</string><string>-vault</string><string>file</string><string>-ports</string><string>5760-5789</string><string>-keychain-service</string><string>localdot-keyd.work</string></array>`,
    );
    expect(keyd).toContain(`<string>${join(home, "logs", "keyd.log")}</string>`);
    for (const value of [
      `<key>LOCALDOT_HOME</key><string>${home}`,
      "<key>LOCALDOT_PORT</key><string>5750</string>",
      "<key>LOCALDOT_TOOL_PORT</key><string>5751</string>",
      "<key>LOCALDOT_KEYD_PORTS</key><string>5760-5789</string>",
      "<key>LOCALDOT_PREVIEW_PORTS</key><string>5850-5865</string>",
      "<key>LOCALDOT_PUBLIC_ORIGIN</key><string>https://studio.example.ts.net:5750</string>",
      "<key>LOCALDOT_INSTALL_PREFIX</key><string>/apps/localdot</string>",
      "<key>LOCALDOT_DESKTOP_IMAGE</key><string>ghcr.io/x/desktop@sha256:1</string>",
      "<key>WorkingDirectory</key><string>/apps/localdot/app/apps/daemon</string>",
    ])
      expect(daemon).toContain(value);
    expect(daemon).not.toContain("4750");
  });

  it("start, stop and go away through launchctl, and never take the first dot's away", async () => {
    const directory = folder();
    firstDot(directory);
    const loaded = new Set(["dev.localdot.work.daemon"]);
    const { services, calls } = launchd(directory, loaded);
    await services.write(work, join(folder(), "w"), await services.template());
    await services.start("work");
    expect(calls).toContain(
      `launchctl bootstrap gui/501 ${join(directory, "dev.localdot.work.keyd.plist")}`,
    );
    expect(calls).toContain("launchctl kickstart gui/501/dev.localdot.work.daemon");
    calls.length = 0;
    await services.stop("work");
    expect(calls).toEqual([
      "launchctl print gui/501/dev.localdot.work.daemon",
      "launchctl bootout gui/501/dev.localdot.work.daemon",
      "launchctl print gui/501/dev.localdot.work.daemon",
      "launchctl print gui/501/dev.localdot.work.keyd",
    ]);
    await services.remove("work");
    expect(await services.exists("work")).toBe(false);
    await expect(services.remove("main")).rejects.toThrow(ServicesError);
  });

  it("stop only the daemon when asked, and name the data folder each daemon runs", async () => {
    const directory = folder();
    firstDot(directory);
    const { services, calls } = launchd(directory, new Set(["dev.localdot.daemon"]));
    await services.stop("main", "daemon");
    expect(calls).toEqual([
      "launchctl print gui/501/dev.localdot.daemon",
      "launchctl bootout gui/501/dev.localdot.daemon",
      "launchctl print gui/501/dev.localdot.daemon",
    ]);
    expect(await services.home("main")).toBe("/Users/a/.localdot");
    expect(await services.home("work")).toBeUndefined();
    // A development agent leaves LOCALDOT_HOME out: the daemon uses ~/.localdot of its HOME.
    plists.set(join(directory, "dev.localdot.daemon.plist"), {
      Label: "dev.localdot.daemon",
      ProgramArguments: ["/apps/node/bin/node", "--import", "tsx", "src/main.ts"],
      EnvironmentVariables: { HOME: "/Users/b" },
    });
    expect(await services.home("main")).toBe("/Users/b/.localdot");
  });

  it("refuse to make a dot when the first one isn't run by launchd", async () => {
    plists.clear();
    const { services } = launchd(folder());
    await expect(services.template()).rejects.toThrow("isn't run by launchd");
  });

  it("read and change start at login per dot", async () => {
    const directory = folder();
    const h = host(() => ({
      stdout: 'disabled services = {\n\t"dev.localdot.work.daemon" => disabled\n}',
    }));
    const services = launchdServices({ exec: h.exec, uid: 501, directory });
    expect(await services.login("work")).toBe(false);
    expect(await services.login("main")).toBe(true);
    await services.setLogin("work", true);
    expect(h.calls.slice(-2)).toEqual([
      "launchctl enable gui/501/dev.localdot.work.keyd",
      "launchctl enable gui/501/dev.localdot.work.daemon",
    ]);
  });
});

describe("systemd services for a dot", () => {
  const firstDot = (directory: string) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "localdot-keyd.service"),
      `# ${INSTALLER_MARKER}\n[Service]\nExecStart="/apps/localdot/bin/keyd" "-home" "/home/a/.localdot" "-vault" "passphrase"\n`,
    );
    writeFileSync(
      join(directory, "localdot-daemon.service"),
      `# ${INSTALLER_MARKER}
[Unit]
Wants=localdot-keyd.service

[Service]
WorkingDirectory=/apps/localdot/app/apps/daemon
Environment="HOME=/home/a"
Environment="PATH=/apps/node/bin:/usr/bin"
Environment="LOCALDOT_HOME=/home/a/.localdot"
Environment="LOCALDOT_PORT=4750"
Environment="LOCALDOT_INSTALL_PREFIX=/apps/50%% off"
ExecStart="/apps/node/bin/node" "--import" "tsx" "src/main.ts"
`,
    );
  };

  it("quote words as the source installer does", () => {
    const word = 'a "b" \\c 50% $HOME';
    expect(systemdWord(word, true)).toBe('"a \\"b\\" \\\\c 50%% $$HOME"');
    expect(systemdWords(systemdWord(word, true), true)).toEqual([word]);
    expect(systemdWords(`${systemdWord("x")} ${systemdWord("y z")}`)).toEqual(["x", "y z"]);
    expect(() => systemdWords('"x" y')).toThrow(ServicesError);
  });

  it("are units made from the first dot's, which start, stop and go away", async () => {
    const directory = join(folder(), "user");
    firstDot(directory);
    const h = host();
    const services = systemdServices({ exec: h.exec, uid: 1000, directory });
    expect(services.names("work")).toEqual({
      keyd: "localdot-work-keyd.service",
      daemon: "localdot-work-daemon.service",
    });
    const template = await services.template();
    expect(template.keyd.args).toEqual(["-vault", "passphrase"]);
    expect(template.daemon.env.LOCALDOT_INSTALL_PREFIX).toBe("/apps/50% off");
    const home = join(folder(), ".localdot-work");
    await services.write(work, home, template);
    const keyd = readFileSync(join(directory, "localdot-work-keyd.service"), "utf8");
    const daemon = readFileSync(join(directory, "localdot-work-daemon.service"), "utf8");
    expect(keyd).toContain(
      `ExecStart="/apps/localdot/bin/keyd" "-home" "${home}" "-vault" "passphrase" "-ports" "5760-5789" "-keychain-service" "localdot-keyd.work"`,
    );
    expect(daemon).toContain("Wants=localdot-work-keyd.service");
    expect(daemon).toContain(`Environment="LOCALDOT_HOME=${home}"`);
    expect(daemon).toContain('Environment="LOCALDOT_PORT=5750"');
    expect(daemon).toContain('Environment="LOCALDOT_INSTALL_PREFIX=/apps/50%% off"');
    expect(daemon).not.toContain("4750");
    expect(daemon.startsWith(`# ${INSTALLER_MARKER}`)).toBe(true);
    expect(h.calls).toContain("systemctl --user daemon-reload");
    await services.start("work");
    await services.stop("work");
    await services.remove("work");
    expect(h.calls.slice(-6)).toEqual([
      "systemctl --user start localdot-work-keyd.service",
      "systemctl --user start localdot-work-daemon.service",
      "systemctl --user stop localdot-work-daemon.service localdot-work-keyd.service",
      "systemctl --user stop localdot-work-daemon.service localdot-work-keyd.service",
      "systemctl --user disable --quiet localdot-work-daemon.service localdot-work-keyd.service",
      "systemctl --user daemon-reload",
    ]);
    expect(await services.exists("work")).toBe(false);
  });

  it("stop only the daemon when asked, and name the data folder it runs", async () => {
    const directory = join(folder(), "user");
    firstDot(directory);
    const h = host();
    const services = systemdServices({ exec: h.exec, uid: 1000, directory });
    await services.stop("main", "daemon");
    expect(h.calls).toEqual(["systemctl --user stop localdot-daemon.service"]);
    expect(await services.home("main")).toBe("/home/a/.localdot");
    expect(await services.home("work")).toBeUndefined();
  });
});
