import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTAINER_INPUT_MS, sendContainerInput } from "./stdin.ts";

const containerId = "a".repeat(64);
const cleanups: (() => Promise<void>)[] = [];

async function fixture(mode: "accept" | "refuse" | "drop" | "stall" = "accept") {
  const directory = await mkdtemp(join(tmpdir(), "ld-stdin-"));
  const socketPath = join(directory, "docker.sock");
  const server = createServer();
  const sockets = new Set<Duplex>();
  const requested = Promise.withResolvers<{ path: string; length: string | undefined }>();
  const received = Promise.withResolvers<Buffer>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket) => {
    requested.resolve({ path: request.url ?? "", length: request.headers["content-length"] });
    socket.on("error", () => {});
    if (mode === "stall") return;
    if (mode === "drop") {
      socket.destroy();
      return;
    }
    if (mode === "refuse") {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    socket.on("end", () => {
      received.resolve(Buffer.concat(chunks));
      socket.end();
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return { socketPath, requested: requested.promise, received: received.promise };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("exact-container private stdin delivery", () => {
  it("sends captured bytes only after the Docker upgrade and closes the write side", async () => {
    const peer = await fixture();
    const bytes = Buffer.from('{"synthetic":"private 中文"}');
    const original = Buffer.from(bytes);
    const sent = sendContainerInput(peer, containerId, bytes, new AbortController().signal);
    bytes.fill(0);
    await sent;
    expect(await peer.received).toEqual(original);
    expect(await peer.requested).toEqual({
      path: `/v1.47/containers/${containerId}/attach?stream=1&stdin=1&stdout=0&stderr=0`,
      length: "0",
    });
  });

  it.each([
    "",
    "short",
    "localdot-browser-cell",
    "../containers/other",
    "g".repeat(64),
    "a".repeat(65),
  ])("refuses a container name or malformed ID before connecting", async (target) => {
    await expect(
      sendContainerInput(
        { socketPath: "/does-not-exist" },
        target,
        Buffer.from("synthetic"),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/^Browser private input handoff failed$/u);
  });

  it("refuses empty sockets, empty/oversized input and pre-abort", async () => {
    const valid = { socketPath: "/does-not-exist" };
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(32769)])
      await expect(
        sendContainerInput(valid, containerId, bytes, new AbortController().signal),
      ).rejects.toThrow("handoff failed");
    await expect(
      sendContainerInput(
        { socketPath: "" },
        containerId,
        Buffer.from("x"),
        new AbortController().signal,
      ),
    ).rejects.toThrow("handoff failed");
    await expect(
      sendContainerInput(valid, containerId, Buffer.from("x"), AbortSignal.abort()),
    ).rejects.toThrow("handoff failed");
  });

  it.each(["refuse", "drop"] as const)(
    "rejects a %s response without disclosing the body",
    async (mode) => {
      const peer = await fixture(mode);
      await expect(
        sendContainerInput(
          peer,
          containerId,
          Buffer.from("private-canary"),
          new AbortController().signal,
        ),
      ).rejects.toThrow(/^Browser private input handoff failed$/u);
    },
  );

  it("cancels a pending upgrade", async () => {
    const peer = await fixture("stall");
    const lifetime = new AbortController();
    const pending = sendContainerInput(
      peer,
      containerId,
      Buffer.from("private-canary"),
      lifetime.signal,
    );
    const refused = expect(pending).rejects.toThrow("handoff failed");
    await peer.requested;
    lifetime.abort();
    await refused;
  });

  it("bounds a silent Docker connection", async () => {
    const peer = await fixture("stall");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = sendContainerInput(
      peer,
      containerId,
      Buffer.from("private-canary"),
      new AbortController().signal,
    );
    const refused = expect(pending).rejects.toThrow("handoff failed");
    await peer.requested;
    await vi.advanceTimersByTimeAsync(CONTAINER_INPUT_MS);
    await refused;
    expect(vi.getTimerCount()).toBe(0);
  });
});
