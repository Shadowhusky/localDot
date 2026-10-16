import { ULID_PATTERN, UploadDigest, USER_UPLOAD, UserUploadCreate } from "@localdot/protocol";
import type { Context, Hono } from "hono";
import { UserUploadError, type UserUploads } from "./user-uploads.ts";

async function read(request: Request, limit: number): Promise<Buffer> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))
    throw new UserUploadError(413, "Upload request is too large.");
  const reader = request.body?.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => {
    void reader?.cancel().catch(() => {});
  };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    request.signal.throwIfAborted();
    while (reader) {
      const part = await reader.read();
      request.signal.throwIfAborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) throw new UserUploadError(413, "Upload request is too large.");
      chunks.push(part.value);
    }
    if (length !== null && Number(length) !== bytes)
      throw new UserUploadError(400, "Incomplete upload request.");
    return Buffer.concat(chunks, bytes);
  } finally {
    request.signal.removeEventListener("abort", abort);
    void reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}

export function userUploadRoutes(
  app: Hono,
  uploads: UserUploads,
  hasCell: (id: string) => boolean,
) {
  const route =
    (work: (c: Context, cellId: string, id: string) => Promise<Response>) => async (c: Context) => {
      c.header("cache-control", "no-store");
      const cellId = c.req.param("cellId") ?? "",
        id = c.req.param("uploadId") ?? "";
      try {
        if (!ULID_PATTERN.test(cellId) || !hasCell(cellId))
          throw new UserUploadError(404, "Computer not found.");
        return await work(c, cellId, id);
      } catch (error) {
        if (error instanceof UserUploadError) return c.json({ error: error.message }, error.status);
        if ((error as NodeJS.ErrnoException)?.code === "ENOSPC")
          return c.json({ error: "Not enough storage for this upload." }, 507);
        if (c.req.raw.signal.aborted)
          return c.json({ error: "Upload interrupted; it can be resumed." }, 408);
        return c.json({ error: "Upload could not be completed. Retry to resume it." }, 503);
      }
    };
  const root = "/api/cells/:cellId/uploads";
  app.post(
    root,
    route(async (c, cellId) => {
      let input: UserUploadCreate;
      try {
        input = UserUploadCreate.parse(JSON.parse((await read(c.req.raw, 4096)).toString("utf8")));
      } catch (error) {
        if (error instanceof UserUploadError) throw error;
        throw new UserUploadError(400, "Invalid file name, size or upload ID.");
      }
      return c.json(await uploads.create(cellId, input), 201);
    }),
  );
  app.get(
    `${root}/:uploadId`,
    route(async (c, cellId, id) => c.json(await uploads.status(cellId, id))),
  );
  app.patch(
    `${root}/:uploadId`,
    route(async (c, cellId, id) => {
      const offset = c.req.header("upload-offset") ?? "";
      const sha256 = UploadDigest.safeParse(c.req.header("upload-checksum"));
      if (!/^\d+$/.test(offset) || !Number.isSafeInteger(Number(offset)) || !sha256.success)
        throw new UserUploadError(400, "Invalid upload offset or checksum.");
      const chunk = await read(c.req.raw, USER_UPLOAD.chunkBytes);
      return c.json(await uploads.append(cellId, id, Number(offset), chunk, sha256.data));
    }),
  );
  app.post(
    `${root}/:uploadId/complete`,
    route(async (c, cellId, id) => {
      await read(c.req.raw, 0);
      return c.json(await uploads.complete(cellId, id), 202);
    }),
  );
  app.delete(
    `${root}/:uploadId`,
    route(async (c, cellId, id) => {
      await read(c.req.raw, 0);
      await uploads.remove(cellId, id);
      return c.body(null, 204);
    }),
  );
}
