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

  it("uses the socket it found in place of a DOCKER_HOST that points nowhere", () => {
    const env = { HOME, DOCKER_HOST: "unix:///tmp/gone.sock" };
    expect(findDockerSocket(env, machine([USER_SOCKET], desktopLinux))).toEqual({
      path: USER_SOCKET,
      source: "the docker context desktop-linux",
    });
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

  it("keeps the daemon's socket when no other exists, so the doctor reports it unreachable", () => {
    const gone: DockerContext = { name: "desktop-linux", host: "unix:///Users/me/gone.sock" };
    expect(findDockerSocket({ HOME }, machine([], gone))).toEqual({
      path: "/var/run/docker.sock",
      source: "the default socket",
    });
  });
});
