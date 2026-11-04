import { readSmall } from "./auth.ts";

interface Asset {
  id: number;
  name: string;
  download_count: number;
}
interface Release {
  draft: boolean;
  tag_name: string;
  published_at: string;
  assets: Asset[];
}
const MAX_PAGES = 10;
export async function syncDownloads(
  db: D1Database,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  // A lease prevents cron/manual refresh races and gives failed runs a bounded recovery time.
  const lease = await db
    .prepare(
      "INSERT INTO meta(key,value) VALUES('sync_lock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(meta.value AS INTEGER) < ? RETURNING value",
    )
    .bind(String(now + 120_000), now)
    .first();
  if (!lease) return { state: "busy" };
  try {
    const first = await db
      .prepare("SELECT value FROM meta WHERE key='downloads_since'")
      .first<{ value: string }>();
    const assets: { asset: Asset; release: Release; platform: string }[] = [];
    let complete = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await fetcher(
        `https://api.github.com/repos/Shadowhusky/localdot/releases?per_page=100&page=${page}`,
        {
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "localDot-stats",
            "x-github-api-version": "2022-11-28",
          },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
      const releases: Release[] = JSON.parse(
        await readSmall(
          new Request("https://internal/", { method: "POST", body: response.body }),
          4 * 1024 * 1024,
        ),
      );
      if (!Array.isArray(releases)) throw new Error("Invalid GitHub release list");
      for (const release of releases) {
        if (
          release.draft ||
          !/^v\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(release.tag_name) ||
          !Number.isFinite(Date.parse(release.published_at))
        )
          continue;
        for (const asset of release.assets) {
          const match =
            /^localdot-\d+\.\d+\.\d+(?:-rc\.\d+)?-(darwin-arm64|darwin-x64|linux-arm64|linux-x64)\.tgz$/.exec(
              asset.name,
            );
          if (
            !match ||
            !Number.isSafeInteger(asset.id) ||
            !Number.isSafeInteger(asset.download_count) ||
            asset.download_count < 0
          )
            continue;
          assets.push({ asset, release, platform: match[1] ?? "unknown" });
        }
      }
      if (releases.length < 100) {
        complete = true;
        break;
      }
    }
    if (!complete)
      throw new Error("GitHub pagination exceeded the bounded import; previous totals retained");
    if (assets.length > 1000) throw new Error("Too many package assets; previous totals retained");
    const day = new Date(now).toISOString().slice(0, 10);
    // One bounded transaction imports the whole snapshot. JSON1 avoids per-asset D1 round trips
    // and keeps this within the free-plan query allowance even with hundreds of packages.
    const payload = JSON.stringify(
      assets.map(({ asset, release, platform }) => ({
        id: asset.id,
        version: release.tag_name,
        platform,
        name: asset.name,
        downloads: asset.download_count,
        published: release.published_at,
        baseline:
          first && Date.parse(release.published_at) >= Number(first.value)
            ? 0
            : asset.download_count,
      })),
    );
    await db.batch([
      db
        .prepare(`INSERT INTO download_days(day,n)
        SELECT ?,COALESCE(SUM(MAX(0,json_extract(j.value,'$.downloads')-COALESCE(a.downloads,json_extract(j.value,'$.baseline')))),0)
        FROM json_each(?) j LEFT JOIN assets a ON a.id=json_extract(j.value,'$.id') WHERE 1
        ON CONFLICT(day) DO UPDATE SET n=n+excluded.n`)
        .bind(day, payload),
      db
        .prepare(`INSERT INTO assets(id,version,platform,name,downloads,published_at,checked_at)
        SELECT json_extract(value,'$.id'),json_extract(value,'$.version'),json_extract(value,'$.platform'),json_extract(value,'$.name'),json_extract(value,'$.downloads'),json_extract(value,'$.published'),?
        FROM json_each(?) WHERE 1
        ON CONFLICT(id) DO UPDATE SET downloads=MAX(assets.downloads,excluded.downloads),checked_at=excluded.checked_at`)
        .bind(now, payload),
      db
        .prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('downloads_since',?)")
        .bind(String(now)),
      db
        .prepare(
          "INSERT INTO meta(key,value) VALUES('github_checked',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .bind(String(now)),
      db.prepare("DELETE FROM meta WHERE key='github_error'"),
    ]);
    return { state: "synced", assets: assets.length };
  } catch (error) {
    const reason =
      error instanceof Error && /^GitHub HTTP \d{3}$/.test(error.message)
        ? error.message
        : "GitHub sync unavailable; last successful counts retained";
    await db
      .prepare(
        "INSERT INTO meta(key,value) VALUES('github_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .bind(reason)
      .run();
    throw new Error(reason);
  } finally {
    await db
      .prepare("DELETE FROM meta WHERE key='sync_lock' AND value=?")
      .bind(String(now + 120_000))
      .run();
  }
}
