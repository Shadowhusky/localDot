/** Bounded, cookie-free edge counters. Nothing from the user's local computer is collected. */
export const HOUR = 3_600_000;
export type EdgeEvent = "page" | "installer_shell" | "installer_windows";
const SOURCES = [
  "google",
  "bing",
  "github",
  "youtube",
  "tiktok",
  "instagram",
  "facebook",
  "reddit",
  "telegram",
  "wechat",
  "x",
  "twitter",
];

export function sourceOf(request: Request): string {
  // Keep only recognised source categories, never arbitrary query values or referral paths.
  const campaign = new URL(request.url).searchParams.get("utm_source")?.toLowerCase();
  if (campaign && SOURCES.includes(campaign)) return campaign;
  const ref = request.headers.get("referer");
  if (!ref) return "direct";
  try {
    const host = new URL(ref).hostname.toLowerCase();
    if (host === "localdot.dev" || host.endsWith(".localdot.dev")) return "localdot";
    for (const source of SOURCES) {
      if (host === `${source}.com` || host.endsWith(`.${source}.com`)) return source;
    }
    if (host === "t.co") return "x";
    if (host === "t.me") return "telegram";
  } catch {
    /* Invalid referrals are never retained. */
  }
  return "other";
}

export function platformOf(ua: string): string {
  if (/android/i.test(ua)) return "Android";
  if (/iphone|ipad|ipod/i.test(ua)) return "iOS";
  if (/windows/i.test(ua)) return "Windows";
  if (/macintosh|mac os/i.test(ua)) return "macOS";
  if (/linux/i.test(ua)) return "Linux";
  if (/curl|wget|powershell/i.test(ua)) return "Command line";
  return "Other";
}

export function shouldCount(request: Request, response: Response, event: EdgeEvent): boolean {
  if (request.method !== "GET" || response.status !== 200 || request.headers.has("range"))
    return false;
  if (request.headers.get("dnt") === "1" || request.headers.get("sec-gpc") === "1") return false;
  if (
    /prefetch|prerender/i.test(
      `${request.headers.get("purpose")} ${request.headers.get("sec-purpose")}`,
    )
  )
    return false;
  const ua = request.headers.get("user-agent") ?? "";
  if (/bot\b|crawler|spider|headless|monitor|uptime|preview|facebookexternalhit/i.test(ua))
    return false;
  if (
    event === "page" &&
    (!request.headers.get("accept")?.includes("text/html") || /curl|wget|powershell/i.test(ua))
  )
    return false;
  return true;
}

export async function recordEdge(
  db: D1Database,
  request: Request,
  event: EdgeEvent,
  now = Date.now(),
): Promise<void> {
  const hour = Math.floor(now / HOUR) * HOUR;
  const cf = request.cf as { country?: string } | undefined;
  const country = /^[A-Z]{2}$/.test(cf?.country ?? "") ? (cf?.country ?? "XX") : "XX";
  const dims = [
    ["total", "all"],
    ["country", country],
    ["platform", platformOf(request.headers.get("user-agent") ?? "")],
    ["source", sourceOf(request)],
  ];
  await db.batch([
    db
      .prepare("INSERT OR IGNORE INTO meta (key,value) VALUES ('tracking_since',?)")
      .bind(String(now)),
    ...dims.map(([dimension, value]) =>
      db
        .prepare(
          "INSERT INTO counters(hour,event,dimension,value,n) VALUES(?,?,?,?,1) ON CONFLICT(hour,event,dimension,value) DO UPDATE SET n=n+1",
        )
        .bind(hour, event, dimension, value),
    ),
  ]);
}

export function countInBackground(
  ctx: ExecutionContext,
  db: D1Database | undefined,
  request: Request,
  response: Response,
  event: EdgeEvent,
): void {
  if (!db || !shouldCount(request, response, event)) return;
  ctx.waitUntil(
    recordEdge(db, request, event).catch(() => {
      // Do not log request data. Collection failure must never interrupt a page or an installer.
      console.warn(JSON.stringify({ event: "analytics_write_failed", source: event }));
    }),
  );
}
