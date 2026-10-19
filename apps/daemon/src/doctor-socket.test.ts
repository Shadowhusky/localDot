import { describe, expect, it, vi } from "vitest";
import { type DockerContext, findDockerSocket } from "./doctor-socket.ts";

const HOME = "/Users/me";
const USER_SOCKET = "/Users/me/.docker/run/docker.sock";
const desktopLinux: DockerContext = { name: "desktop-linux", host: `unix://${USER_SOCKET}` };

// The machine as findDockerSocket sees it: which socket files exist, and the CLI's active context.
function machine(existing: string[], context?: DockerContext) {
  return { exists: (path: string) => existing.includes(path), context: vi.fn(() => context) };
}

describe("findDockerSocket", () => {
  it("uses the default socket when it exists, without asking the Docker CLI", () => {
    const probes = machine(["/var/run/docker.sock", USER_SOCKET], desktopLinux);
    expect(findDockerSocket({ HOME }, probes)).toEqual({
      path: "/var/run/docker.sock",
      source: "the default socket",
    });
    expect(probes.context).not.toHaveBeenCalled();
  });

  it("uses DOCKER_HOST's socket when it exists", () => {
    const probes = machine(["/tmp/other.sock", "/var/run/docker.sock"], desktopLinux);
    expect(findDockerSocket({ HOME, DOCKER_HOST: "unix:///tmp/other.sock" }, probes)).toEqual({
      path: "/tmp/other.sock",
      source: "DOCKER_HOST",
    });
    expect(probes.context).not.toHaveBeenCalled();
  });

  it("finds the docker context's socket when the default socket is off", () => {
    expect(findDockerSocket({ HOME }, machine([USER_SOCKET], desktopLinux))).toEqual({
      path: USER_SOCKET,
      source: "the docker context desktop-linux",
    });
  });

  it("keeps an explicit missing socket without probing another engine", () => {
    const env = { HOME, DOCKER_HOST: "unix:///tmp/gone.sock" };
    const probes = machine([USER_SOCKET], desktopLinux);
    expect(findDockerSocket(env, probes)).toEqual({
      path: "/tmp/gone.sock",
      source: "DOCKER_HOST",
    });
    expect(probes.context).not.toHaveBeenCalled();
  });

  it("refuses explicit remote endpoints instead of using an available default engine", () => {
    const probes = machine(["/var/run/docker.sock", USER_SOCKET], desktopLinux);
    expect(() => findDockerSocket({ HOME, DOCKER_HOST: "tcp://127.0.0.1:2375" }, probes)).toThrow(
      "local Unix socket",
    );
    expect(probes.context).not.toHaveBeenCalled();
  });

  it("preserves an explicit selection of the default pathname even when absent", () => {
    const probes = machine([USER_SOCKET], desktopLinux);
    expect(findDockerSocket({ HOME, DOCKER_HOST: "unix:///var/run/docker.sock" }, probes)).toEqual({
      path: "/var/run/docker.sock",
      source: "DOCKER_HOST",
    });
    expect(probes.context).not.toHaveBeenCalled();
  });

  it("falls back to Docker Desktop's user socket without a Docker CLI or a Unix-socket context", () => {
    const remote: DockerContext = { name: "remote", host: "tcp://10.0.0.5:2376" };
    for (const context of [undefined, remote]) {
      expect(findDockerSocket({ HOME }, machine([USER_SOCKET], context))).toMatchObject({
        path: USER_SOCKET,
        source: "Docker Desktop's user socket",
      });
    }
  });

  it("keeps the selected context while its socket is absent", () => {
    const gone: DockerContext = { name: "desktop-linux", host: "unix:///Users/me/gone.sock" };
    expect(findDockerSocket({ HOME }, machine([], gone))).toEqual({
      path: "/Users/me/gone.sock",
      source: "the docker context desktop-linux",
    });
  });

  it("finds rootless Docker and Docker Desktop for Linux when the system socket is missing", () => {
    const env = { HOME: "/home/ana", XDG_RUNTIME_DIR: "/run/user/1000" };
    expect(findDockerSocket(env, machine(["/run/user/1000/docker.sock"]), "linux")).toEqual({
      path: "/run/user/1000/docker.sock",
      source: "rootless Docker's socket",
    });
    expect(
      findDockerSocket(env, machine(["/home/ana/.docker/desktop/docker.sock"]), "linux"),
    ).toEqual({
      path: "/home/ana/.docker/desktop/docker.sock",
      source: "Docker Desktop's user socket",
    });
    expect(findDockerSocket(env, machine(["/run/user/1000/docker.sock"]), "darwin").path).toBe(
      "/home/ana/.docker/run/docker.sock",
    );
  });
});
