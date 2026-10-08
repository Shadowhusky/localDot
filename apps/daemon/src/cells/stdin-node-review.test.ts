import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { ClientRequest } from "node:http";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sendContainerInput } from "./stdin.ts";

describe("actual Node request-construction cancellation", () => {
  it.each(["before", "during", "after"] as const)(
    "closes its exact owned request when cancelled %s construction",
    async (phase) => {
      const directory = await mkdtemp(join(tmpdir(), "bs-node-"));
      const socketPath = join(directory, "d.sock");
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        socket.once("close", () => sockets.delete(socket));
      });
      const lifetime = new AbortController();
      const created = channel("http.client.request.created");
      let owned: ClientRequest | undefined;
      const observer = (message: unknown) => {
        owned = (message as { request: ClientRequest }).request;
        if (phase === "during") lifetime.abort();
      };
      try {
        server.listen(socketPath);
        await once(server, "listening");
        created.subscribe(observer);
        if (phase === "before") lifetime.abort();
        const pending = sendContainerInput(
          { socketPath },
          "a".repeat(64),
          Buffer.from("synthetic-local-only"),
          lifetime.signal,
        );
        if (phase === "after") lifetime.abort();
        await expect(pending).rejects.toThrow(/^Browser private input handoff failed$/u);
        if (phase === "before") expect(owned).toBeUndefined();
        else
          expect(owned?.destroyed, "a refused handoff must not abandon a live ClientRequest").toBe(
            true,
          );
      } finally {
        created.unsubscribe(observer);
        owned?.destroy();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
