const DAY = 86_400_000;
export const PERIODS = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };
export type Period = keyof typeof PERIODS;
export function rangeOf(url: URL, now = Date.now()) {
  const asked = url.searchParams.get("period") ?? "30d";
  const period: Period = Object.hasOwn(PERIODS, asked) ? (asked as Period) : "30d";
  const until =
    period === "24h"
      ? Math.ceil(now / 3_600_000) * 3_600_000
      : Date.parse(new Date(now).toISOString().slice(0, 10)) + DAY;
  return {
    period,
    since: until - PERIODS[period] * DAY,
    until,
    step: period === "24h" ? 3_600_000 : DAY,
  };
}
export type Range = ReturnType<typeof rangeOf>;
type Count = { label: string; n: number };
type Metric = { event: string; n: number };
export async function loadStats(db: D1Database, reports: D1Database, range: Range) {
  const { since, until, step } = range;
  const queries = [
    db
      .prepare(
        "SELECT event,SUM(n) AS n FROM counters WHERE dimension='total' AND hour>=? AND hour<? GROUP BY event",
      )
      .bind(since, until),
    db
      .prepare(
        "SELECT event,SUM(n) AS n FROM counters WHERE dimension='total' AND hour>=? AND hour<? GROUP BY event",
      )
      .bind(since - (until - since), since),
    db
      .prepare(
        "SELECT CAST((hour-?)/? AS INTEGER) AS bucket,event,SUM(n) AS n FROM counters WHERE dimension='total' AND hour>=? AND hour<? GROUP BY bucket,event",
      )
      .bind(since, step, since, until),
    ...["country", "platform", "source"].map((d) =>
      db
        .prepare(
          "SELECT value AS label,SUM(n) AS n FROM counters WHERE event='page' AND dimension=? AND hour>=? AND hour<? GROUP BY value ORDER BY n DESC LIMIT 25",
        )
        .bind(d, since, until),
    ),
    db
      .prepare(
        "SELECT event AS label,SUM(n) AS n FROM counters WHERE dimension='total' AND event!='page' AND hour>=? AND hour<? GROUP BY event ORDER BY n DESC",
      )
      .bind(since, until),
    db.prepare(
      "SELECT version,platform,downloads,published_at FROM assets ORDER BY published_at DESC,platform LIMIT 200",
    ),
    db.prepare("SELECT SUM(downloads) AS downloads,COUNT(*) AS assets FROM assets"),
    db.prepare(
      "SELECT platform AS label,SUM(downloads) AS n FROM assets GROUP BY platform ORDER BY n DESC",
    ),
    db
      .prepare("SELECT day,n FROM download_days WHERE day>=? AND day<=? ORDER BY day")
      .bind(
        new Date(since).toISOString().slice(0, 10),
        new Date(until - 1).toISOString().slice(0, 10),
      ),
    db.prepare(
      "SELECT key,value FROM meta WHERE key IN ('tracking_since','downloads_since','github_checked','github_error')",
    ),
  ];
  const result = await db.batch(queries);
  const rows = <T>(i: number) => (result[i]?.results ?? []) as T[];
  const totals = (i: number) => Object.fromEntries(rows<Metric>(i).map((r) => [r.event, r.n]));
  const timeline = Array.from({ length: Math.round((until - since) / step) }, (_, i) => ({
    at: since + i * step,
    page: 0,
    installer: 0,
  }));
  for (const row of rows<Metric & { bucket: number }>(2)) {
    const point = timeline[row.bucket];
    if (point) point[row.event === "page" ? "page" : "installer"] += row.n;
  }
  let reportData: {
    available: boolean;
    total: number;
    installations: number;
    statuses: Count[];
    versions: Count[];
  } = { available: false, total: 0, installations: 0, statuses: [], versions: [] };
  try {
    const rs = await reports.batch([
      reports
        .prepare(
          "SELECT COUNT(*) AS total,COUNT(DISTINCT install_id) AS installations FROM reports WHERE received_at>=? AND received_at<?",
        )
        .bind(since, until),
      reports
        .prepare(
          "SELECT status AS label,COUNT(*) AS n FROM reports WHERE received_at>=? AND received_at<? GROUP BY status",
        )
        .bind(since, until),
      reports
        .prepare(
          "SELECT version AS label,COUNT(*) AS n FROM reports WHERE received_at>=? AND received_at<? GROUP BY version ORDER BY n DESC LIMIT 12",
        )
        .bind(since, until),
    ]);
    reportData = {
      available: true,
      ...(rs[0]?.results[0] as { total: number; installations: number }),
      statuses: (rs[1]?.results ?? []) as Count[],
      versions: (rs[2]?.results ?? []) as Count[],
    };
  } catch {
    /* Other metrics remain available if the separate reports service is unavailable. */
  }
  return {
    range,
    current: totals(0),
    previous: totals(1),
    timeline,
    countries: rows<Count>(3),
    platforms: rows<Count>(4),
    sources: rows<Count>(5),
    installers: rows<Count>(6),
    releases: rows<{ version: string; platform: string; downloads: number; published_at: string }>(
      7,
    ),
    lifetime: rows<{ downloads: number | null; assets: number }>(8)[0] ?? {
      downloads: null,
      assets: 0,
    },
    downloadPlatforms: rows<Count>(9),
    downloadDays: rows<{ day: string; n: number }>(10),
    meta: Object.fromEntries(rows<{ key: string; value: string }>(11).map((r) => [r.key, r.value])),
    reports: reportData,
  };
}
export type Stats = Awaited<ReturnType<typeof loadStats>>;
