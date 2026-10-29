import {
  REPORT_CONTENT_TYPE,
  REPORT_GZIP_MAX,
  REPORT_ID,
  REPORT_JSON_MAX,
  REPORT_TOKEN,
  ReportBundle,
  ReportStatus,
  ReportUpdate,
} from "../../../packages/protocol/src/reports.ts";
import { OWNER_SCRIPT, OWNER_STYLE, ownerPage } from "./owner-page.ts";

export interface ReportsEnv {
  DB: D1Database;
  BUNDLES: KVNamespace;
  // A Worker secret; the owner's pages and API stay closed without it.
  OWNER_TOKEN?: string;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Bundles expire from KV after the same time, so the sweep only removes rows.
const RETENTION_MS = 180 * DAY;
// Reports accepted per sending address and per installation in an hour, and from everyone in a day.
const LIMITS = { address: 20, install: 6, day: 500 } as const;
const PAGE = 50;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const COLUMNS =
  "id, received_at, updated_at, install_id, version, channel, platform, source, summary, description, status, notes, bundle_bytes";
const encoder = new TextEncoder();

interface Row {
  id: string;
  received_at: number;
  updated_at: number;
  install_id: string;
  version: string;
  channel: string;
  platform: string;
  source: string;
  summary: string;
  description: string;
  status: string;
  notes: string;
  bundle_bytes: number;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
function same(a: string, b: string): boolean {
  return (
    a.length === b.length && crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b))
  );
}
const SECURITY = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...SECURITY, "content-type": "application/json; charset=utf-8" },
  });
}
function reply(text: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: { ...SECURITY, "content-type": "text/plain; charset=utf-8", ...headers },
  });
}
const busy = (text: string) => reply(text, 429, { "retry-after": "3600" });
const bundleKey = (id: string) => `bundle:${id}`;
const bearer = (request: Request) =>
  request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";

function shown(row: Row) {
  return {
    id: row.id,
    receivedAt: new Date(row.received_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    installId: row.install_id,
    version: row.version,
    channel: row.channel,
    platform: row.platform,
    source: row.source,
    summary: row.summary,
    description: row.description,
    status: row.status,
    notes: row.notes,
    bytes: row.bundle_bytes,
  };
}

// 256 is a multiple of 32, so every character is equally likely.
function reportId(): string {
  const chars = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    CROCKFORD.charAt(b % 32),
  ).join("");
  return `LD-${chars.slice(0, 4)}-${chars.slice(4)}`;
}
function reporterToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Bounded even when Content-Length is missing or dishonest, and for what a small gzip inflates to.
async function readAtMost(
  stream: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array | undefined> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    parts.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return bytes;
}

async function submit(request: Request, env: ReportsEnv, now: number): Promise<Response> {
  if (request.headers.get("content-type") !== REPORT_CONTENT_TYPE)
    return reply("Send a localDot report", 415);
  if (Number(request.headers.get("content-length") ?? 0) > REPORT_GZIP_MAX)
    return reply("Report too large", 413);
  // Every attempt counts, valid or not, so a flood can't reach the parser for long.
  const hour = Math.floor(now / HOUR);
  const address = await sha256(request.headers.get("cf-connecting-ip") ?? "unknown");
  const counted = await env.DB.prepare(
    "INSERT INTO rate_limits (bucket, count, expires_at) VALUES (?1, 1, ?2) ON CONFLICT (bucket) DO UPDATE SET count = count + 1 RETURNING count",
  )
    .bind(`address:${address}:${hour}`, (hour + 1) * HOUR)
    .first<{ count: number }>();
  if ((counted?.count ?? 0) > LIMITS.address)
    return busy("Too many reports from this network. Try again in an hour.");
  const gzip = await readAtMost(request.body, REPORT_GZIP_MAX);
  if (!gzip) return reply("Report too large", 413);
  let bundle: ReportBundle;
  try {
    const body = new Response(gzip).body?.pipeThrough(new DecompressionStream("gzip")) ?? null;
    const text = await readAtMost(body, REPORT_JSON_MAX);
    if (!text) return reply("Report too large", 413);
    bundle = ReportBundle.parse(JSON.parse(new TextDecoder().decode(text)));
  } catch {
    return reply("Invalid report", 400);
  }
  const [install, day] = await env.DB.batch<{ n: number }>([
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM reports WHERE install_id = ?1 AND received_at > ?2",
    ).bind(bundle.installId, now - HOUR),
    env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE received_at > ?1").bind(now - DAY),
  ]);
  if ((install?.results[0]?.n ?? 0) >= LIMITS.install)
    return busy("Too many reports from this computer. Try again in an hour.");
  if ((day?.results[0]?.n ?? 0) >= LIMITS.day)
    return busy("The reports service is busy. Try again later.");
  const token = reporterToken();
  const reporter = await sha256(token);
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = reportId();
    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO reports (id, received_at, updated_at, install_id, version, channel, platform, source, summary, description, bundle_bytes, reporter_hash)
       VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
      .bind(
        id,
        now,
        bundle.installId,
        bundle.app.version,
        bundle.app.channel,
        `${bundle.host.os} ${bundle.host.arch}`,
        bundle.source,
        bundle.summary,
        bundle.message ?? "",
        gzip.byteLength,
        reporter,
      )
      .run();
    if (!inserted.meta.changes) continue;
    try {
      await env.BUNDLES.put(bundleKey(id), gzip, { expirationTtl: RETENTION_MS / 1000 });
    } catch (error) {
      await env.DB.prepare("DELETE FROM reports WHERE id = ?1").bind(id).run();
      throw error;
    }
    return json({ id, token }, 201);
  }
  return reply("Try again", 503);
}

async function remove(env: ReportsEnv, id: string): Promise<Response> {
  const deleted = await env.DB.prepare("DELETE FROM reports WHERE id = ?1").bind(id).run();
  if (!deleted.meta.changes) return reply("No such report", 404);
  await env.BUNDLES.delete(bundleKey(id));
  return new Response(null, { status: 204, headers: SECURITY });
}

// The sender's view: the same answer for a wrong token as for no report at all.
async function reporter(request: Request, env: ReportsEnv, id: string): Promise<Response> {
  const token = bearer(request);
  const row = REPORT_TOKEN.test(token)
    ? await env.DB.prepare(
        "SELECT id, status, received_at, updated_at, reporter_hash FROM reports WHERE id = ?1",
      )
        .bind(id)
        .first<
          Pick<Row, "id" | "status" | "received_at" | "updated_at"> & { reporter_hash: string }
        >()
    : null;
  if (!row || !same(await sha256(token), row.reporter_hash)) return reply("No such report", 404);
  if (request.method === "DELETE") return remove(env, id);
  return json({
    id: row.id,
    status: row.status,
    receivedAt: new Date(row.received_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}

async function list(url: URL, env: ReportsEnv): Promise<Response> {
  const status = url.searchParams.get("status") || null;
  if (status !== null && !ReportStatus.safeParse(status).success)
    return reply("Unknown status", 400);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  // The cursor is the last row shown: its time, then its id for rows received the same millisecond.
  const cursor = /^(\d{1,15})\.(LD-[0-9A-Z-]{9})$/.exec(url.searchParams.get("before") ?? "");
  const [rows, counts] = await env.DB.batch([
    env.DB.prepare(
      `SELECT ${COLUMNS} FROM reports
       WHERE (?1 IS NULL OR status = ?1)
         AND (?2 IS NULL OR id LIKE ?2 ESCAPE '\\' OR summary LIKE ?2 ESCAPE '\\' OR description LIKE ?2 ESCAPE '\\'
              OR notes LIKE ?2 ESCAPE '\\' OR version LIKE ?2 ESCAPE '\\' OR platform LIKE ?2 ESCAPE '\\' OR install_id LIKE ?2 ESCAPE '\\')
         AND (?3 IS NULL OR received_at < ?3 OR (received_at = ?3 AND id < ?4))
       ORDER BY received_at DESC, id DESC LIMIT ?5`,
    ).bind(status, like, cursor ? Number(cursor[1]) : null, cursor?.[2] ?? null, PAGE + 1),
    env.DB.prepare("SELECT status, COUNT(*) AS n FROM reports GROUP BY status"),
  ]);
  const found = (rows?.results ?? []) as unknown as Row[];
  const page = found.slice(0, PAGE);
  const last = page.at(-1);
  return json({
    reports: page.map(shown),
    next: found.length > PAGE && last ? `${last.received_at}.${last.id}` : null,
    counts: Object.fromEntries(
      ((counts?.results ?? []) as { status: string; n: number }[]).map((c) => [c.status, c.n]),
    ),
  });
}

async function owner(request: Request, env: ReportsEnv, url: URL): Promise<Response> {
  const secret = env.OWNER_TOKEN ?? "";
  if (secret.length < 32) return reply("The owner token isn't set up", 503);
  if (!same(await sha256(bearer(request)), await sha256(secret))) return reply("Unauthorized", 401);
  if (url.pathname === "/v1/owner/reports")
    return request.method === "GET" ? list(url, env) : reply("Method not allowed", 405);
  const match = /^\/v1\/owner\/reports\/(LD-[0-9A-Z-]{9})(\/bundle)?$/.exec(url.pathname);
  const id = match?.[1];
  if (!id || !REPORT_ID.test(id)) return reply("Not found", 404);
  if (match[2]) {
    if (request.method !== "GET") return reply("Method not allowed", 405);
    const gzip = await env.BUNDLES.get(bundleKey(id), "arrayBuffer");
    if (!gzip) return reply("No such report", 404);
    // Stored gzipped; the browser inflates it, so the Worker never does.
    return new Response(gzip, {
      headers: {
        ...SECURITY,
        "content-type": "application/json; charset=utf-8",
        "content-encoding": "gzip",
      },
      encodeBody: "manual",
    });
  }
  if (request.method === "DELETE") return remove(env, id);
  if (request.method === "PATCH") {
    let change: ReportUpdate;
    try {
      const body = await readAtMost(request.body, 16 * 1024);
      if (!body) return reply("Too large", 413);
      change = ReportUpdate.parse(JSON.parse(new TextDecoder().decode(body)));
    } catch {
      return reply("Invalid change", 400);
    }
    const row = await env.DB.prepare(
      `UPDATE reports SET status = COALESCE(?2, status), notes = COALESCE(?3, notes), updated_at = ?4
       WHERE id = ?1 RETURNING ${COLUMNS}`,
    )
      .bind(id, change.status ?? null, change.notes ?? null, Date.now())
      .first<Row>();
    return row ? json(shown(row)) : reply("No such report", 404);
  }
  if (request.method !== "GET") return reply("Method not allowed", 405);
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM reports WHERE id = ?1`)
    .bind(id)
    .first<Row>();
  return row ? json(shown(row)) : reply("No such report", 404);
}

function asset(body: string, type: string): Response {
  return new Response(body, {
    headers: { ...SECURITY, "content-type": `${type}; charset=utf-8` },
  });
}

async function route(request: Request, env: ReportsEnv, url: URL): Promise<Response> {
  if (url.pathname === "/v1/reports")
    return request.method === "POST"
      ? submit(request, env, Date.now())
      : reply("Method not allowed", 405);
  const sent = /^\/v1\/reports\/(LD-[0-9A-Z-]{9})$/.exec(url.pathname)?.[1];
  if (sent && REPORT_ID.test(sent))
    return request.method === "GET" || request.method === "DELETE"
      ? reporter(request, env, sent)
      : reply("Method not allowed", 405);
  if (url.pathname.startsWith("/v1/owner/")) return owner(request, env, url);
  if (request.method !== "GET") return reply("Method not allowed", 405);
  if (url.pathname === "/") return ownerPage();
  if (url.pathname === "/owner.js") return asset(OWNER_SCRIPT, "text/javascript");
  if (url.pathname === "/owner.css") return asset(OWNER_STYLE, "text/css");
  return reply("Not found", 404);
}

// Rows past retention go; their bundles have already expired from KV.
async function sweep(env: ReportsEnv, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reports WHERE received_at < ?1").bind(now - RETENTION_MS),
    env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < ?1").bind(now),
  ]);
}

// biome-ignore lint/style/noDefaultExport: Cloudflare's module entry point.
export default {
  async fetch(request: Request, env: ReportsEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol !== "https:" && !/^(?:localhost|127\.0\.0\.1)$/.test(url.hostname))
      return reply("Use HTTPS", 400);
    try {
      return await route(request, env, url);
    } catch {
      return reply("Something went wrong. Try again.", 500);
    }
  },
  async scheduled(_controller: ScheduledController, env: ReportsEnv): Promise<void> {
    await sweep(env, Date.now());
  },
} satisfies ExportedHandler<ReportsEnv>;
