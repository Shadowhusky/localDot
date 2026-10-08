import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  execute: vi.fn(),
  realpath: vi.fn(),
  lstat: vi.fn(),
}));
vi.mock("node:http", () => ({ request: mocks.request }));
vi.mock("./host-command.ts", () => ({ readHostCommand: mocks.execute }));
vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
  statfs: vi.fn(),
  lstat: mocks.lstat,
  realpath: mocks.realpath,
}));

import { installDockerSocket, installHostProbes } from "./host-probes.ts";

interface FakeRequestOptions {
  socketPath: string;
  method: string;
  path: string;
  signal: AbortSignal;
}
class Response extends Readable {
  statusCode = 200;
  headers = { "content-type": "application/json" };
  complete = true;
  constructor() {
    super({ read() {} });
    this.on("error", () => {});
  }
}
const responses: Response[] = [];
beforeEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  responses.splice(0);
  mocks.realpath.mockImplementation(async (path) => path);
  mocks.lstat.mockResolvedValue({ isSocket: () => true });
  mocks.execute.mockResolvedValue(
    JSON.stringify([{ Endpoints: { docker: { Host: "unix:///fake/docker.sock" } } }]),
  );
  mocks.request.mockImplementation(
    (options: FakeRequestOptions, callback: (response: Response) => void) => {
      const req = new EventEmitter();
      return Object.assign(req, {
        destroy() {
          queueMicrotask(() => req.emit("close"));
        },
        end() {
          queueMicrotask(() => {
            const response = new Response();
            responses.push(response);
            callback(response);
            const value =
              options.path === "/version"
                ? {
                    Version: "29.2.0",
                    ApiVersion: "1.53",
                    MinAPIVersion: "1.44",
                    Os: "linux",
                    Arch: "aarch64",
                  }
                : { OperatingSystem: "Docker Desktop", MemTotal: 8 * 1024 ** 3 };
            response.push(Buffer.from(JSON.stringify(value)));
            response.push(null);
          });
        },
      });
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
});

it("issues only bounded GET probes to the explicitly selected local socket", async () => {
  const selected = vi.fn();
  const facts = await installHostProbes(
    { DOCKER_HOST: "unix:///fake/docker.sock" },
    selected,
  ).docker(new AbortController().signal);
  expect(selected).toHaveBeenCalledExactlyOnceWith("/fake/docker.sock");
  expect(facts).toMatchObject({
    desktop: true,
    operatingSystem: "linux",
    architecture: "aarch64",
    memoryBytes: 8 * 1024 ** 3,
  });
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(mocks.request).toHaveBeenCalledTimes(2);
  expect(
    mocks.request.mock.calls.map(([request]) => ({
      method: request.method,
      path: request.path,
      socket: request.socketPath,
    })),
  ).toEqual([
    { method: "GET", path: "/version", socket: "/fake/docker.sock" },
    { method: "GET", path: "/info", socket: "/fake/docker.sock" },
  ]);
});
it("does not fall back from a selected remote Docker context to an unrelated local engine", async () => {
  mocks.execute.mockResolvedValue(
    JSON.stringify([{ Endpoints: { docker: { Host: "tcp://remote:2375" } } }]),
  );
  await expect(installDockerSocket({}, new AbortController().signal)).rejects.toThrow(
    "Remote Docker",
  );
  expect(mocks.lstat).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
});
it("discovers Docker Desktop's conventional socket only when the CLI executable is absent", async () => {
  mocks.execute.mockRejectedValue(Object.assign(new Error("not installed"), { code: "ENOENT" }));
  expect(await installDockerSocket({}, new AbortController().signal)).toMatch(
    /\.docker\/run\/docker.sock$/,
  );
  await expect(
    installDockerSocket({ DOCKER_CONTEXT: "explicit" }, new AbortController().signal),
  ).rejects.toThrow("not installed");
});
it.each(["oversized", "invalid-json", "redirect"])(
  "refuses %s Docker responses without following redirects",
  async (mode) => {
    mocks.request.mockImplementation(
      (_options: FakeRequestOptions, callback: (response: Response) => void) => {
        const req = new EventEmitter();
        return Object.assign(req, {
          destroy() {
            queueMicrotask(() => req.emit("close"));
          },
          end() {
            queueMicrotask(() => {
              const response = new Response();
              responses.push(response);
              if (mode === "redirect") response.statusCode = 302;
              callback(response);
              if (mode === "redirect") return;
              response.push(
                mode === "oversized" ? Buffer.alloc(1024 * 1024 + 1) : Buffer.from("invalid json"),
              );
              if (!response.destroyed) response.push(null);
            });
          },
        });
      },
    );
    await expect(
      installHostProbes({ DOCKER_HOST: "unix:///fake/docker.sock" }).docker(
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(mocks.request).toHaveBeenCalledTimes(2);
    if (mode !== "invalid-json")
      expect(responses.every((response) => response.destroyed)).toBe(true);
  },
);
it("passes caller cancellation into both pending socket requests", async () => {
  const controller = new AbortController();
  mocks.request.mockImplementation((options: FakeRequestOptions) => {
    const req = new EventEmitter();
    options.signal.addEventListener("abort", () => req.emit("error", options.signal.reason), {
      once: true,
    });
    return Object.assign(req, {
      end() {},
      destroy() {
        queueMicrotask(() => req.emit("close"));
      },
    });
  });
  const pending = installHostProbes({ DOCKER_HOST: "unix:///fake/docker.sock" }).docker(
    controller.signal,
  );
  const expectation = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
  controller.abort();
  await expectation;
  expect(mocks.request.mock.calls.every(([options]) => options.signal.aborted)).toBe(true);
});
it("times out an unresponsive Docker probe and cancels its sibling request", async () => {
  mocks.request.mockImplementation((options: FakeRequestOptions) => {
    const req = new EventEmitter();
    options.signal.addEventListener("abort", () => req.emit("error", options.signal.reason), {
      once: true,
    });
    return Object.assign(req, {
      end() {},
      destroy() {
        queueMicrotask(() => req.emit("close"));
      },
    });
  });
  await expect(
    installHostProbes({ DOCKER_HOST: "unix:///fake/docker.sock" }).docker(
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(mocks.request.mock.calls.every(([options]) => options.signal.aborted)).toBe(true);
}, 5_000);
