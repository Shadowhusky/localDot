import {
  authorized,
  clearCookie,
  configured,
  readSmall,
  sameOrigin,
  sameToken,
  sessionCookie,
  sign,
} from "./auth.ts";
import { loadStats, rangeOf } from "./data.ts";
import { syncDownloads } from "./github.ts";
import { loginPage, STYLE, statsPage } from "./page.ts";

type AdminEnv = Env & { OWNER_TOKEN?: string; GITHUB_INGEST_TOKEN?: string };
const SECURITY = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow",
  "content-security-policy":
    "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src https://localdot.dev; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};
function reply(
  body: string,
  status = 200,
  type = "text/html; charset=utf-8",
  extra: Record<string, string> = {},
) {
  return new Response(body, { status, headers: { ...SECURITY, "content-type": type, ...extra } });
}
function redirect(path: string, cookie?: string) {
  return reply("", 303, "text/plain", {
    location: path,
    ...(cookie ? { "set-cookie": cookie } : {}),
  });
}
const json = (value: unknown, status = 200) =>
  reply(JSON.stringify(value), status, "application/json");
export const worker = {
  async fetch(request: Request, env: AdminEnv): Promise<Response> {
    const url = new URL(request.url),
      path = url.pathname;
    if (url.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(url.hostname))
      return reply("HTTPS required", 400, "text/plain");
    if (path === "/healthz") return json({ ok: true });
    if (path === "/robots.txt") return reply("User-agent: *\nDisallow: /\n", 200, "text/plain");
    if (path === "/style.css" && request.method === "GET")
      return reply(STYLE, 200, "text/css; charset=utf-8");
    // The scheduled repository workflow uses only a dedicated write-only import credential.
    // It cannot read admin data or authenticate an owner session.
    if (path === "/internal/github" && request.method === "POST") {
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (
        !configured(env.GITHUB_INGEST_TOKEN) ||
        token.length > 256 ||
        !(await sameToken(token, env.GITHUB_INGEST_TOKEN))
      )
        return json({ error: "Unauthorized" }, 401);
      if (request.headers.get("content-type") !== "application/json")
        return json({ error: "Expected JSON" }, 415);
      let releases: unknown;
      try {
        releases = JSON.parse(await readSmall(request, 4 * 1024 * 1024));
      } catch {
        return json({ error: "Invalid or oversized import" }, 400);
      }
      if (!Array.isArray(releases) || releases.length >= 1000)
        return json({ error: "Invalid import" }, 400);
      const snapshot = releases;
      try {
        const result = await syncDownloads(env.DB, async (input) => {
          const page = Number(new URL(String(input)).searchParams.get("page"));
          return Response.json(snapshot.slice((page - 1) * 100, page * 100));
        });
        return json(result, result.state === "busy" ? 409 : 200);
      } catch {
        return json({ error: "Import failed; last counts retained" }, 502);
      }
    }
    if (!configured(env.OWNER_TOKEN))
      return reply("Admin access is not configured.", 503, "text/plain");
    if (path === "/login" && request.method === "POST") {
      if (!sameOrigin(request)) return reply("Origin refused", 403, "text/plain");
      if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded"))
        return reply("Expected form data", 415, "text/plain");
      const now = Date.now(),
        expires = (Math.floor(now / 3_600_000) + 1) * 3_600_000;
      const bucket = await sign(
        env.OWNER_TOKEN,
        `login:${expires}:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
      );
      const limit = await env.DB.prepare(
        "INSERT INTO login_limits(key,expires,n) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET n=n+1 RETURNING n",
      )
        .bind(bucket, expires)
        .first<{ n: number }>();
      if (!limit || limit.n > 10)
        return reply(
          loginPage("Too many attempts. Try again in an hour."),
          429,
          "text/html; charset=utf-8",
          { "retry-after": "3600" },
        );
      let given = "";
      try {
        given = new URLSearchParams(await readSmall(request, 4096)).get("key")?.trim() ?? "";
      } catch {
        return reply("Form too large", 413, "text/plain");
      }
      if (given.length > 256 || !(await sameToken(given, env.OWNER_TOKEN)))
        return reply(loginPage("That owner key didn’t match."), 401);
      return redirect("/stats", await sessionCookie(env.OWNER_TOKEN));
    }
    if (path === "/logout" && request.method === "POST") {
      if (!sameOrigin(request)) return reply("Origin refused", 403, "text/plain");
      return redirect("/stats", clearCookie);
    }
    if (!(await authorized(request, env.OWNER_TOKEN))) {
      return path.startsWith("/api/")
        ? json({ error: "Sign in to view statistics" }, 401)
        : reply(loginPage(), 401);
    }
    if (request.method !== "GET")
      return reply("Method not allowed", 405, "text/plain", { allow: "GET" });
    if (!["/", "/stats", "/api/stats", "/api/export"].includes(path))
      return reply("Not found", 404, "text/plain");
    try {
      const data = await loadStats(env.DB, env.REPORTS, rangeOf(url));
      if (path === "/api/stats") return json(data);
      if (path === "/api/export") {
        if (url.searchParams.get("tab") === "downloads") {
          const rows = [
            "release,platform,lifetime_package_downloads,published_at",
            ...data.releases.map(
              (r) => `${r.version},${r.platform},${r.downloads},${r.published_at}`,
            ),
          ];
          return reply(rows.join("\r\n") + "\r\n", 200, "text/csv; charset=utf-8", {
            "content-disposition": 'attachment; filename="localdot-downloads.csv"',
          });
        }
        const rows = [
          "time_utc,page_views,installer_requests",
          ...data.timeline.map((p) => `${new Date(p.at).toISOString()},${p.page},${p.installer}`),
        ];
        return reply(rows.join("\r\n") + "\r\n", 200, "text/csv; charset=utf-8", {
          "content-disposition": 'attachment; filename="localdot-traffic.csv"',
        });
      }
      return reply(statsPage(data, url));
    } catch {
      console.error(JSON.stringify({ event: "stats_read_failed" }));
      return reply("Statistics are temporarily unavailable. Please try again.", 503, "text/plain");
    }
  },
  async scheduled(_controller: ScheduledController, env: AdminEnv, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM counters WHERE hour<?").bind(Date.now() - 400 * 86_400_000),
          env.DB.prepare("DELETE FROM login_limits WHERE expires<?").bind(Date.now()),
          env.DB.prepare("DELETE FROM download_days WHERE day<?").bind(
            new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10),
          ),
        ]);
      })().catch(() => console.error(JSON.stringify({ event: "stats_sync_failed" }))),
    );
  },
} satisfies ExportedHandler<AdminEnv>;
// biome-ignore lint/style/noDefaultExport: Cloudflare requires a default Worker export.
export default worker;
