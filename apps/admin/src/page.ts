import type { Stats } from "./data.ts";
import { STYLE } from "./style.ts";

const e = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n: number | null | undefined) => new Intl.NumberFormat("en").format(n ?? 0);
const stamp = (v: string | number | undefined) =>
  v
    ? new Date(Number(v)).toLocaleString("en-GB", {
        timeZone: "UTC",
        dateStyle: "medium",
        timeStyle: "short",
      }) + " UTC"
    : "Not yet recorded";
const label = (v: string) =>
  ({
    installer_shell: "macOS / Linux",
    installer_windows: "Windows / WSL",
    "darwin-arm64": "macOS · Apple silicon",
    "darwin-x64": "macOS · Intel",
    "linux-x64": "Linux / WSL · x64",
    "linux-arm64": "Linux · ARM64",
    direct: "Direct",
    localdot: "localDot website",
    other: "Other",
    new: "New",
    investigating: "Investigating",
    fixed: "Fixed",
    wontfix: "Closed",
  })[v] ?? v.charAt(0).toUpperCase() + v.slice(1);
const brand = `<a class="brand" href="/stats"><img src="https://localdot.dev/favicon.svg" width="33" height="33" alt="">localDot<span class="divider"></span><small>Admin</small></a>`;
function document(body: string, title = "Overview") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="dark"><title>${e(title)} · localDot</title><link rel="icon" href="https://localdot.dev/favicon.svg"><link rel="stylesheet" href="/style.css"></head><body>${body}</body></html>`;
}
export function loginPage(error = "") {
  return document(
    `<main class="login"><section class="login-card">${brand}<p class="eyebrow">Just for you</p><h1>A little perspective.</h1><p class="subtitle">Traffic, downloads and how localDot is doing.</p>${error ? `<p class="error" role="alert">${e(error)}</p>` : ""}<form action="/login" method="post"><label for="key">Owner key</label><input type="password" id="key" name="key" autocomplete="current-password" required minlength="32" maxlength="256" autofocus><button class="primary" type="submit">Open dashboard <span aria-hidden="true">↗</span></button></form><p class="hint">Use your localDot reports owner key. This browser stays signed in for eight hours.</p></section></main>`,
    "Sign in",
  );
}
function delta(now: number, previous: number, complete: boolean) {
  if (!complete) return "Collecting a comparison period";
  if (!previous)
    return now ? "No activity in the previous period" : "No change from previous period";
  const percent = Math.round(((now - previous) / previous) * 100);
  return `<em>${percent > 0 ? "+" : ""}${percent}%</em> vs previous period`;
}
function card(name: string, value: string, note: string) {
  return `<article class="card"><p class="metric-label">${e(name)}</p><div class="value">${value}</div><p class="metric-note">${note}</p></article>`;
}
function breakdown(
  title: string,
  rows: { label: string; n: number }[],
  kind = "",
  note = "Page views · selected period",
) {
  const total = rows.reduce((s, r) => s + r.n, 0);
  const maximum = Math.max(1, ...rows.map((r) => r.n));
  const render = (r: { label: string; n: number }) => {
    let name = label(r.label);
    if (kind === "country") {
      try {
        name =
          r.label === "XX"
            ? "Unknown"
            : (new Intl.DisplayNames(["en"], { type: "region" }).of(r.label) ?? r.label);
      } catch {
        name = r.label;
      }
    }
    return `<div><div class="row-label"><span>${e(name)}</span><b>${fmt(r.n)} <small>· ${Math.round((r.n / Math.max(1, total)) * 100)}%</small></b></div><div class="bar"><i style="width:${(r.n / maximum) * 100}%"></i></div></div>`;
  };
  return `<section class="panel"><div class="panel-head"><div><h2>${e(title)}</h2><p>${e(note)}</p></div><span class="badge">${rows.length}</span></div>${rows.length ? `<div class="rows">${rows.slice(0, 6).map(render).join("")}</div>${rows.length > 6 ? `<details><summary>Show ${rows.length - 6} more</summary><div class="rows">${rows.slice(6).map(render).join("")}</div></details>` : ""}` : `<div class="empty">No data in this period.</div>`}</section>`;
}
function chart(s: Stats) {
  const points = s.timeline;
  const max = Math.max(4, ...points.flatMap((p) => [p.page, p.installer]));
  const y = (v: number) => 180 - (v / max) * 155;
  const x = (i: number) => 40 + (i / Math.max(1, points.length - 1)) * 960;
  const line = (key: "page" | "installer") =>
    points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(p[key]).toFixed(2)}`).join(" ");
  const day = (at: number) =>
    new Date(at).toLocaleString("en-GB", {
      timeZone: "UTC",
      ...(s.range.period === "24h"
        ? { hour: "2-digit" as const, minute: "2-digit" as const }
        : { day: "numeric" as const, month: "short" as const }),
    });
  return `<section class="panel"><div class="panel-head"><div><h2>People finding localDot</h2><p>Page views and installer requests over time</p></div><div class="legend"><span>Page views</span><span>Installer requests</span></div></div><div class="chart-scroll"><svg class="chart" viewBox="0 0 1040 220" preserveAspectRatio="none" role="img" aria-label="${e(points.map((p) => `${day(p.at)}: ${p.page} page views, ${p.installer} installer requests`).join("; "))}"><defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#b9c4ff" stop-opacity=".12"/><stop offset="1" stop-color="#b9c4ff" stop-opacity="0"/></linearGradient></defs>${[0, 1, 2, 3, 4].map((i) => `<line class="grid" x1="40" x2="1000" y1="${y((max * i) / 4)}" y2="${y((max * i) / 4)}"/><text x="28" y="${y((max * i) / 4) + 3}" text-anchor="end">${fmt(Math.round((max * i) / 4))}</text>`).join("")}<path class="area" d="${line("page")} L1000,180 L40,180 Z"/><path class="line" d="${line("page")}"/><path class="line install-line" d="${line("installer")}"/>${points.map((p, i) => `<g class="point"><title>${e(day(p.at))}: ${p.page} page views · ${p.installer} installer requests</title><circle cx="${x(i)}" cy="${y(p.page)}" r="${p.page ? 2 : 0}"/><rect class="hit" x="${x(i) - 8}" y="15" width="16" height="170"/></g>`).join("")}</svg><div class="chart-dates"><span>${e(day(points[0]?.at ?? s.range.since))}</span><span>${e(day(points[Math.floor(points.length / 2)]?.at ?? s.range.since))}</span><span>${e(day(points[points.length - 1]?.at ?? s.range.since))}</span></div></div><div class="chart-note"><span>UTC · known bots and prefetches excluded</span><span>Requests are not unique people or completed installations.</span></div><details><summary>View chart as a table</summary><div class="data-table"><table><thead><tr><th>Time (UTC)</th><th>Page views</th><th>Installer requests</th></tr></thead><tbody>${points.map((p) => `<tr><td>${e(day(p.at))}</td><td>${p.page}</td><td>${p.installer}</td></tr>`).join("")}</tbody></table></div></details></section>`;
}
function releases(s: Stats) {
  return `<section class="panel"><div class="panel-head"><div><h2>Release downloads</h2><p>GitHub’s package download counts · lifetime per asset</p></div><span class="badge">${fmt(s.lifetime.assets)} packages</span></div>${s.releases.length ? `<div class="data-table"><table><thead><tr><th>Release</th><th>Platform</th><th>Published</th><th>Downloads</th></tr></thead><tbody>${s.releases.map((r) => `<tr><td><a target="_blank" rel="noreferrer" href="https://github.com/Shadowhusky/localdot/releases/tag/${encodeURIComponent(r.version)}">${e(r.version)}</a></td><td>${e(label(r.platform))}</td><td>${e(new Date(r.published_at).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }))}</td><td>${fmt(r.downloads)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Waiting for the first GitHub import.</div>`}<p class="chart-note">Includes repeat downloads and updates. Source ZIPs, container pulls and the legacy downloads repository are not included.</p></section>`;
}
function health(s: Stats) {
  const r = s.reports;
  return `<section class="panel"><div class="panel-head"><div><h2>A pulse on the app</h2><p>Submitted problem reports · selected period</p></div><a class="button" href="https://reports.localdot.dev" target="_blank" rel="noreferrer">Open reports ↗</a></div>${r.available ? `<div class="health-summary"><div class="health-number">${fmt(r.total)}<span>Problem reports</span></div><div class="health-number">${fmt(r.installations)}<span>Reporting installations</span></div></div><p class="muted">Reporting installations are only computers that sent a problem report—not all users or active installs.</p>` : `<div class="notice error">The reports service could not be read. Other statistics are still available.</div>`}</section>${r.available ? `<div class="grid-two">${breakdown("Report status", r.statuses, "", "Selected period")}${breakdown("Reported app versions", r.versions, "", "Selected period")}</div>` : ""}`;
}
export function statsPage(s: Stats, url: URL) {
  const tab = ["overview", "downloads", "audience", "health"].includes(
    url.searchParams.get("tab") ?? "",
  )
    ? (url.searchParams.get("tab") ?? "overview")
    : "overview";
  const page = s.current.page ?? 0,
    installers = (s.current.installer_shell ?? 0) + (s.current.installer_windows ?? 0);
  const complete =
    !!s.meta.tracking_since &&
    Number(s.meta.tracking_since) <= s.range.since - (s.range.until - s.range.since);
  const href = (period: string, t = tab) => `/stats?period=${period}&tab=${t}`;
  const fresh =
    !!s.meta.github_checked && Date.now() - Number(s.meta.github_checked) < 8 * 3_600_000;
  const cards = `<div class="cards">${card("Page views", fmt(page), delta(page, s.previous.page ?? 0, complete))}${card("Installer requests", fmt(installers), delta(installers, (s.previous.installer_shell ?? 0) + (s.previous.installer_windows ?? 0), complete))}${card("Package downloads", s.meta.github_checked ? fmt(s.lifetime.downloads) : "—", "All-time · GitHub release assets")}${card("Reporting installations", s.reports.available ? fmt(s.reports.installations) : "—", "Selected period · not total users")}</div>`;
  const notice =
    s.meta.github_error || !fresh
      ? `<div class="notice${s.meta.github_error ? " error" : ""}" role="status">${s.meta.github_checked ? `Download counts last checked ${e(stamp(s.meta.github_checked))}. ${s.meta.github_error ? e(s.meta.github_error) : "A refresh is due."}` : "Download counts are waiting for their first sync."}</div>`
      : "";
  const coverage = `<details class="panel coverage"><summary>What these numbers mean</summary><dl class="definitions"><div><dt>Traffic starts here</dt><dd>Collection began ${e(stamp(s.meta.tracking_since))}. Page views are requests for the website homepage. A reload can count again. No cookies, persistent visitor IDs or personal profiles are created. Do Not Track and Global Privacy Control are respected.</dd></div><div><dt>Downloads have history; daily growth starts now</dt><dd>Lifetime download totals come from GitHub. Daily increments are observed between syncs, beginning ${e(stamp(s.meta.downloads_since))}; they are not the original download times. The initial historical total is not counted as today’s growth.</dd></div><div><dt>Your users’ work stays theirs</dt><dd>This dashboard receives no chat messages, recordings, files, keys or local agent activity. Active users, retention and completed installations are not measured. Reports count only installations that chose to send diagnostics.</dd></div><div><dt>Small by design</dt><dd>Only hourly aggregates are stored, retained for 13 months. Countries come from edge metadata; devices and referral sources are broad categories. No raw addresses or full referral URLs are stored.</dd></div></dl></details>`;
  let content =
    tab === "overview"
      ? `${cards}${chart(s)}<div class="grid-three">${breakdown("Top sources", s.sources)}${breakdown("Countries", s.countries, "country")}${breakdown("Devices & systems", s.platforms)}</div>`
      : tab === "audience"
        ? `${cards}<div class="grid-three">${breakdown("Sources", s.sources)}${breakdown("Countries", s.countries, "country")}${breakdown("Devices & systems", s.platforms)}</div>`
        : tab === "health"
          ? health(s)
          : `<div class="cards">${card("Package downloads", s.meta.github_checked ? fmt(s.lifetime.downloads) : "—", "All-time · not unique users")}${card("Observed new downloads", s.meta.downloads_since ? fmt(s.downloadDays.reduce((sum, d) => sum + d.n, 0)) : "—", "Selected UTC days · since tracking began")}${card("Installer requests", fmt(installers), "Selected period · scripts fetched")}${card("Release packages", fmt(s.lifetime.assets), "Published macOS and Linux packages")}</div><div class="grid-two">${breakdown("Downloaded platforms", s.downloadPlatforms, "", "All-time · GitHub package downloads")}${breakdown("Installer scripts", s.installers, "", "Selected period · requests")}</div>${releases(s)}`;
  content += coverage;
  return document(
    `<div class="shell"><header class="top">${brand}<div class="top-actions"><a href="https://localdot.dev" target="_blank" rel="noreferrer">Visit localDot ↗</a><form action="/logout" method="post"><button class="text-button">Sign out</button></form></div></header><main><div class="intro"><div><p class="eyebrow">The bigger picture</p><h1>${tab === "overview" ? "A little perspective." : tab === "downloads" ? "From curiosity to download." : tab === "audience" ? "Where people find you." : "Keep getting better."}</h1><p class="subtitle">${tab === "overview" ? "A clear view of localDot, one day at a time." : "Measured carefully. Kept simple."}</p></div><div class="range"><nav class="periods" aria-label="Time range">${["24h", "7d", "30d", "90d"].map((p) => `<a href="${href(p)}" aria-current="${p === s.range.period}">${p}</a>`).join("")}</nav><a class="button" href="/api/export?period=${s.range.period}&tab=${tab}" download>↓ Export</a></div></div><nav class="tabs" aria-label="Statistics sections">${["overview", "downloads", "audience", "health"].map((t) => `<a href="${href(s.range.period, t)}" aria-current="${t === tab ? "page" : "false"}">${t === "health" ? "App health" : label(t)}</a>`).join("")}</nav>${notice}${Number(s.meta.tracking_since ?? Date.now()) > s.range.since ? `<div class="notice">${s.meta.tracking_since ? `Traffic history starts ${e(stamp(s.meta.tracking_since))}. Earlier dates were not measured.` : "Traffic collection is ready. Your first visits and installer requests will appear here."}</div>` : ""}${content}</main><footer class="foot"><span>localDot · Private admin dashboard<br>GitHub sync: ${e(stamp(s.meta.github_checked))}</span><div><a href="https://github.com/Shadowhusky/localdot/actions/workflows/stats-import.yml" target="_blank" rel="noreferrer">Download import status ↗</a><span>Automatic every six hours · <a href="/stats">Refresh statistics</a></span></div></footer></div>`,
    label(tab),
  );
}
export { STYLE };
