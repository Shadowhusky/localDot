import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DOCKER_TESTS,
  docker,
  dockerExec,
  dockerExecAs,
  dockerOk,
  removeAll,
} from "./testing/docker-cli.ts";

export const DESKTOP_IMAGE = "localdot/desktop:dev";
const C = "localdot-test-desktop-tools";

// A probe's output counts only if it exited 0: `out` joins stderr, and Docker's "executable file
// not found" error names the missing binary.
function outputOf(...cmd: string[]): string {
  const r = dockerExec(C, ...cmd);
  expect(r.status, `${cmd.join(" ")}: ${r.out}`).toBe(0);
  return r.out;
}

function outputAs(user: string, ...cmd: string[]): string {
  const r = dockerExecAs(C, user, ...cmd);
  expect(r.status, `${cmd.join(" ")} as ${user}: ${r.out}`).toBe(0);
  return r.out;
}

describe.skipIf(!DOCKER_TESTS)("desktop image: pinned tools", () => {
  beforeAll(() => {
    if (!dockerOk("image", "inspect", DESKTOP_IMAGE)) {
      throw new Error(`${DESKTOP_IMAGE} is missing: run cells/desktop/build.sh first`);
    }
    removeAll({ containers: [C] });
    docker("run", "-d", "--name", C, "--network", "none", "--shm-size=1g", DESKTOP_IMAGE);
  });

  afterAll(() => removeAll({ containers: [C] }));

  it("ships the app set", () => {
    expect(outputOf("libreoffice", "--version")).toContain("LibreOffice");
    expect(outputAs("abc", "codium", "--version").split("\n")[0]).toBe("1.135.06055");
    expect(outputOf("gimp", "--version")).toMatch(/Image Manipulation Program/);
    expect(outputOf("ffmpeg", "-version")).toContain("ffmpeg version");
    expect(outputOf("convert", "-version")).toContain("ImageMagick");
    expect(outputOf("pandoc", "--version")).toMatch(/^pandoc \d/m);
    expect(outputOf("chromium-browser", "--version")).toContain("Chromium");
    for (const tool of ["thunar", "xfce4-terminal", "mousepad", "git", "curl", "jq", "python3"]) {
      expect(dockerExec(C, "sh", "-c", `command -v ${tool}`).status, tool).toBe(0);
    }
  });

  it("ships Node 24.21.0", () => {
    expect(outputOf("node", "--version").trim()).toBe("v24.21.0");
    expect(outputOf("readlink", "-f", "/usr/local/bin/node").trim()).toBe("/opt/node/bin/node");
  });

  it("runs Cua Driver 0.30.4 as the desktop user with telemetry and update checks off", () => {
    expect(outputAs("abc", "cua-driver", "--version")).toContain("0.30.4");
    const env = docker("image", "inspect", "--format", "{{json .Config.Env}}", DESKTOP_IMAGE);
    expect(env).toContain('"CUA_DRIVER_RS_TELEMETRY_ENABLED=0"');
    expect(env).toContain('"CUA_DRIVER_RS_UPDATE_CHECK=0"');
    expect(env).toContain('"CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS=0"');
    expect(env).toContain('"START_DOCKER=false"');
  });

  it("has Inter, JetBrains Mono, Noto CJK and Noto Color Emoji", () => {
    const families = outputOf("fc-list", ":", "family");
    expect(families).toMatch(/\bInter\b/);
    expect(families).toContain("JetBrains Mono");
    expect(families).toContain("Noto Sans CJK");
    expect(families).toContain("Noto Color Emoji");
  });

  it("has the X, accessibility and certificate tools", () => {
    expect(dockerExec(C, "xinput", "--version").status).toBe(0);
    expect(dockerExec(C, "python3", "-c", "import Xlib").status).toBe(0);
    expect(dockerExec(C, "sh", "-c", "command -v xprop && command -v certutil").status).toBe(0);
    expect(dockerExec(C, "sh", "-c", "ls /usr/libexec/at-spi-bus-launcher").status).toBe(0);
  });
});
