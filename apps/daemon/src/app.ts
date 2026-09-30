import { Hono } from "hono";
import { isAllowedHost, isAllowedOrigin, tokenFromHeaders } from "./guard.ts";
import { tokensMatch } from "./token.ts";

export interface AppOptions {
  token: string;
  port: number;
}

export function createApp({ token, port }: AppOptions): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const urlHost = new URL(c.req.url).host;
    const rawHost = c.req.header("host") ?? urlHost;
    if (!isAllowedHost(rawHost, port) || !isAllowedHost(urlHost, port)) {
      return c.text("forbidden host", 403);
    }
    if (!isAllowedOrigin(c.req.header("origin"), port)) return c.text("forbidden origin", 403);
    await next();
  });

  app.get("/healthz", (c) => c.text("ok"));

  app.use("/api/*", async (c, next) => {
    const given = tokenFromHeaders({ authorization: c.req.header("authorization") });
    if (!tokensMatch(token, given)) return c.text("unauthorized", 401);
    await next();
  });

  app.get("/api/whoami", (c) => c.json({ ok: true }));

  return app;
}
