// Runs in GitHub Actions. Credentials stay in headers, never URLs or output.
const { GITHUB_TOKEN, LOCALDOT_STATS_INGEST_TOKEN } = process.env;
if (!GITHUB_TOKEN || !LOCALDOT_STATS_INGEST_TOKEN) throw new Error("Missing import credentials");
const releases = [];
let complete = false;
for (let page = 1; page <= 10; page++) {
  const response = await fetch(
    `https://api.github.com/repos/Shadowhusky/localdot/releases?per_page=100&page=${page}`,
    {
      headers: {
        authorization: `Bearer ${GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "user-agent": "localDot-stats-import",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  const batch = await response.json();
  if (!Array.isArray(batch)) throw new Error("Invalid release response");
  for (const r of batch) {
    if (r.draft) continue;
    releases.push({
      draft: false,
      tag_name: r.tag_name,
      published_at: r.published_at,
      assets: r.assets.map((a) => ({ id: a.id, name: a.name, download_count: a.download_count })),
    });
  }
  if (batch.length < 100) {
    complete = true;
    break;
  }
}
const body = JSON.stringify(releases);
if (!complete || Buffer.byteLength(body) > 4 * 1024 * 1024)
  throw new Error("Import exceeds safe bounds");
const response = await fetch("https://admin.localdot.dev/internal/github", {
  method: "POST",
  headers: {
    authorization: `Bearer ${LOCALDOT_STATS_INGEST_TOKEN}`,
    "content-type": "application/json",
    "user-agent": "localDot-stats-import",
  },
  body,
  signal: AbortSignal.timeout(60000),
});
if (!response.ok) throw new Error(`Import returned ${response.status}; previous counts retained`);
const result = await response.json();
if (result.state !== "synced") throw new Error("Import did not complete");
console.log(`Updated download counts for ${result.assets} public packages.`);
