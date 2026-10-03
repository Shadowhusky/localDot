import type { Context, Hono } from "hono";
import { z } from "zod";
import { AccountError, type CodexAccount } from "./account.ts";
export interface ChatgptRoutesDeps {
  account: CodexAccount;
}
const Login = z.strictObject({ method: z.enum(["code", "browser"]).default("code") });
class BodyError extends Error {
  constructor(
    readonly status: 400 | 413 | 415,
    message: string,
  ) {
    super(message);
  }
}
function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
  return new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      action();
    };
    const abort = () => {
      void reader.cancel().catch(() => {});
      finish(() => reject(new BodyError(400, "Account request cancelled.")));
    };
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then(
      (part) => finish(() => resolve(part)),
      (cause) => finish(() => reject(cause)),
    );
    if (signal.aborted) abort();
  });
}
async function readBody(c: Context, login: boolean): Promise<unknown> {
  const raw = c.req.raw;
  if (login && !/^application\/json(?:\s*;|$)/i.test(raw.headers.get("content-type") ?? ""))
    throw new BodyError(415, "JSON body required.");
  const length = raw.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))))
    throw new BodyError(400, "Invalid request length.");
  if (length !== null && Number(length) > (login ? 4096 : 0))
    throw new BodyError(
      login ? 413 : 400,
      login ? "Sign-in request too large." : "This request must have no body.",
    );
  const reader = raw.body?.getReader();
  let bytes = 0;
  const parts: Uint8Array[] = [];
  try {
    if (reader)
      for (;;) {
        raw.signal.throwIfAborted();
        const part = await readChunk(reader, raw.signal);
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > (login ? 4096 : 0))
          throw new BodyError(
            login ? 413 : 400,
            login ? "Sign-in request too large." : "This request must have no body.",
          );
        parts.push(part.value);
      }
  } finally {
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  if (!login) return;
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new BodyError(400, "Invalid sign-in request.");
  }
}
export function chatgptRoutes(app: Hono, { account }: ChatgptRoutesDeps): void {
  const wrap = (run: (c: Context) => Promise<Response>) => async (c: Context) => {
    try {
      return await run(c);
    } catch (cause) {
      if (cause instanceof AccountError || cause instanceof BodyError)
        return c.text(cause.message, cause.status);
      return c.text("The ChatGPT account operation failed.", 503);
    }
  };
  app.get(
    "/api/agent/chatgpt",
    wrap(async (c) => c.json(await account.status())),
  );
  app.post(
    "/api/agent/chatgpt/login",
    wrap(async (c) => {
      const parsed = Login.safeParse(await readBody(c, true));
      if (!parsed.success) return c.text("Invalid sign-in request.", 400);
      c.req.raw.signal.throwIfAborted();
      return c.json(await account.login(parsed.data.method), 202);
    }),
  );
  app.post(
    "/api/agent/chatgpt/login/cancel",
    wrap(async (c) => {
      await readBody(c, false);
      c.req.raw.signal.throwIfAborted();
      await account.cancelLogin();
      return c.body(null, 204);
    }),
  );
  app.post(
    "/api/agent/chatgpt/logout",
    wrap(async (c) => {
      await readBody(c, false);
      c.req.raw.signal.throwIfAborted();
      await account.logout();
      return c.body(null, 204);
    }),
  );
  app.post(
    "/api/agent/chatgpt/refresh",
    wrap(async (c) => {
      await readBody(c, false);
      c.req.raw.signal.throwIfAborted();
      return c.json(await account.refresh());
    }),
  );
}
