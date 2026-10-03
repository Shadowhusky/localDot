import { createServer, type IncomingMessage } from "node:http";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

const MAX_BODY = 1024 * 1024,
  MAX_REQUESTS = 128;
const b64u = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims: Record<string, unknown>) =>
  `${b64u({ alg: "none", typ: "JWT" })}.${b64u(claims)}.c2ln`;
// Inert unsigned identities only. Never import a real account's credentials into these fixtures.
export function fakeTokens(n: number, expiresInSec: number) {
  if (!Number.isSafeInteger(n) || n < 1 || !Number.isSafeInteger(expiresInSec))
    throw new Error("Invalid fixture token input.");
  const claims = {
    email: "user@example.invalid",
    exp: Math.floor(Date.now() / 1000) + expiresInSec,
    "https://api.openai.com/auth": {
      chatgpt_plan_type: "plus",
      chatgpt_account_id: "acct-test",
      chatgpt_user_id: "user-test",
    },
  };
  return {
    id_token: jwt(claims),
    access_token: jwt({ ...claims, n }),
    refresh_token: `rt-${n}`,
    account_id: "acct-test",
  };
}
export function fakeAuthJson(n = 1, expiresInSec = 3600): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: fakeTokens(n, expiresInSec),
    last_refresh: new Date().toISOString(),
  });
}
export interface MockRequest {
  method: string;
  path: string;
  auth?: string;
  body: string;
}
export type Answer = (
  body: Record<string, unknown>,
  index: number,
) => Record<string, unknown> | readonly Record<string, unknown>[] | undefined;
export interface OpenAiMock {
  readonly base: string;
  readonly requests: MockRequest[];
  readonly responses: Record<string, unknown>[];
  readonly errors: string[];
  expireAccess(): void;
  refreshFails: boolean;
  close(): Promise<void>;
}
class RequestError extends Error {
  constructor(readonly status: 400 | 413 | 408) {
    super("Invalid fixture request.");
  }
}
async function body(req: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for await (const value of req) {
      const part = Buffer.isBuffer(value) ? value : Buffer.from(value);
      size += part.length;
      if (size > MAX_BODY) throw new RequestError(413);
      parts.push(part);
    }
    let raw = Buffer.concat(parts, size);
    const encoding = req.headers["content-encoding"];
    if (encoding === "gzip") raw = gunzipSync(raw, { maxOutputLength: MAX_BODY });
    else if (encoding === "zstd") raw = zstdDecompressSync(raw, { maxOutputLength: MAX_BODY });
    else if (encoding !== undefined && encoding !== "identity") throw new RequestError(400);
    if (raw.length > MAX_BODY) throw new RequestError(413);
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch (cause) {
    if (cause instanceof RequestError) throw cause;
    if ((cause as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE")
      throw new RequestError(413);
    throw new RequestError(400);
  }
}
// Every listener/socket belongs to this fixture. The pinned probe additionally constrains child
// egress to this exact loopback endpoint; URL overrides alone are not an egress guarantee.
export async function startOpenAiMock(answer: Answer = () => undefined): Promise<OpenAiMock> {
  const requests: MockRequest[] = [],
    responses: Record<string, unknown>[] = [],
    errors: string[] = [];
  let expired = false,
    n = 1,
    closePromise: Promise<void> | undefined;
  const state = { refreshFails: false };
  const server = createServer((req, res) => {
    const json = (status: number, value: unknown) => {
      if (!res.destroyed) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      }
    };
    void (async () => {
      if (requests.length >= MAX_REQUESTS) {
        errors.push("fixture request limit exceeded");
        json(503, {});
        return;
      }
      const text = await body(req),
        path = req.url ?? "/";
      if (path.length > 8192) throw new RequestError(413);
      requests.push({
        method: req.method ?? "",
        path,
        auth: req.headers.authorization,
        body: text,
      });
      if (path.startsWith("/oauth/token")) {
        if (state.refreshFails) {
          json(401, { error: { message: "refresh token expired", code: "refresh_token_expired" } });
          return;
        }
        expired = false;
        json(200, fakeTokens(++n, 3600));
        return;
      }
      if (path.split("?")[0] === "/backend-api/codex/responses") {
        if (req.method !== "POST") {
          json(404, {});
          return;
        }
        if (expired) {
          json(401, { error: { message: "token expired", code: "token_expired" } });
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new RequestError(400);
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new RequestError(400);
        const input = parsed as Record<string, unknown>;
        responses.push(input);
        const supplied = answer(input, responses.length - 1),
          items =
            supplied === undefined
              ? [
                  {
                    type: "message",
                    role: "assistant",
                    id: `msg_${responses.length}`,
                    content: [{ type: "output_text", text: "ok" }],
                  },
                ]
              : Array.isArray(supplied)
                ? supplied
                : [supplied];
        const id = `resp_${responses.length}`,
          events: Record<string, unknown>[] = [
            { type: "response.created", response: { id, status: "in_progress" } },
          ];
        for (const [index, item] of items.entries()) {
          events.push({ type: "response.output_item.added", output_index: index, item });
          events.push({ type: "response.output_item.done", output_index: index, item });
        }
        events.push({
          type: "response.completed",
          response: {
            id,
            status: "completed",
            output: items,
            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
          },
        });
        const wire = events
          .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          .join("");
        if (Buffer.byteLength(wire) > MAX_BODY) throw new Error("fixture answer too large");
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(wire);
        return;
      }
      if (path.startsWith("/backend-api/wham/usage")) {
        json(200, {
          plan_type: "plus",
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              used_percent: 7,
              limit_window_seconds: 18000,
              reset_after_seconds: 1000,
              reset_at: 1790900000,
            },
            secondary_window: {
              used_percent: 1,
              limit_window_seconds: 604800,
              reset_after_seconds: 5000,
              reset_at: 1791400000,
            },
          },
        });
        return;
      }
      if (path.startsWith("/backend-api/codex/models")) {
        json(200, { models: [] });
        return;
      }
      if (path.startsWith("/backend-api/wham/settings/user")) {
        json(200, {});
        return;
      }
      json(404, {});
    })().catch((cause) => {
      if (cause instanceof RequestError) {
        json(cause.status, {});
        return;
      }
      errors.push(cause instanceof Error ? cause.message.slice(0, 256) : "fixture hook failed");
      json(500, {});
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.on("clientError", (_cause, socket) => {
    errors.push("fixture client transport failed");
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Fixture listener missing.");
  }
  return Object.assign(state, {
    base: `http://127.0.0.1:${address.port}`,
    requests,
    responses,
    errors,
    expireAccess: () => {
      expired = true;
    },
    close: () => {
      if (!closePromise) {
        closePromise = new Promise<void>((resolve, reject) => {
          server.close((cause) => (cause ? reject(cause) : resolve()));
          server.closeAllConnections();
        });
      }
      return closePromise;
    },
  });
}
