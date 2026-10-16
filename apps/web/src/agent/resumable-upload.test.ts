import { USER_UPLOAD, userUploadPath } from "@localdot/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { uploadFile } from "./resumable-upload.ts";

afterEach(() => vi.useRealTimers());
it("allows a slow large upload to take longer than two minutes, with a separate deadline for each chunk", async () => {
  vi.useFakeTimers();
  const file = new File([new Uint8Array(USER_UPLOAD.chunkBytes + 1)], "dataset.bin");
  const id = crypto.randomUUID(),
    cell = "01JXYZ0000000000000000CE11";
  let offset = 0;
  let chunkIndex = 0;
  const admitted = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const api = createApi("fixture", {
    origin: "http://localhost:4747",
    fetchImpl: async (url, init) => {
      if (init?.method === "PATCH") {
        admitted[chunkIndex++]?.resolve();
        await new Promise((resolve) => setTimeout(resolve, 90_000));
        offset += (init.body as Uint8Array).byteLength;
      }
      const complete = String(url).endsWith("/complete");
      return Response.json({
        id,
        name: file.name,
        bytes: file.size,
        offset,
        phase: complete ? "complete" : "receiving",
        ...(complete ? { path: `~/${userUploadPath(id, file.name)}`, sha256: "0".repeat(64) } : {}),
      });
    },
  });
  const pending = uploadFile(api, cell, file, new AbortController().signal, { id });
  await admitted[0]?.promise;
  await vi.advanceTimersByTimeAsync(90_000);
  await admitted[1]?.promise;
  await vi.advanceTimersByTimeAsync(90_000);
  await expect(pending).resolves.toBe(`~/${userUploadPath(id, file.name)}`);
  expect(offset).toBe(file.size);
});
