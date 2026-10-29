// The owner's single page. Report content comes from anyone who can send one, so the script
// builds every node with textContent and the policy allows no inline code.
export function ownerPage(): Response {
  return new Response(PAGE, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>localDot reports</title>
<link rel="stylesheet" href="/owner.css">
<script src="/owner.js" defer></script>
</head>
<body>
<main id="gate" class="gate" hidden>
  <form id="signin" class="gate-card">
    <h1>localDot reports</h1>
    <p>Enter the owner token to read and track problem reports.</p>
    <label for="token">Owner token</label>
    <input id="token" type="password" autocomplete="current-password" spellcheck="false" required>
    <button type="submit" class="primary">Open reports</button>
    <p id="gate-error" class="error" role="alert"></p>
  </form>
</main>
<div id="app" class="app" hidden>
  <header class="top">
    <h1>localDot reports</h1>
    <input id="search" type="search" placeholder="Search ID, summary, version, notes" aria-label="Search reports">
    <button id="signout" type="button" class="quiet">Sign out</button>
  </header>
  <nav id="filters" class="filters" aria-label="Status"></nav>
  <div class="panes">
    <section id="list" class="list" aria-label="Reports"></section>
    <section id="detail" class="detail" aria-label="Report"></section>
  </div>
</div>
</body>
</html>`;

export const OWNER_STYLE = `
:root {
  --bg: #f6f6f4; --raised: #ffffff; --line: #e3e3df; --fg: #1b1b1a; --fg2: #5f5f5a; --fg3: #8b8b85;
  --accent: #2563eb; --on-accent: #ffffff; --ok: #15803d; --bad: #b91c1c; --warn: #a16207; --chip: #eeeeea;
  --new: #2563eb; --investigating: #a16207; --fixed: #15803d; --wontfix: #6b7280;
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--fg); background: var(--bg);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111213; --raised: #1a1b1d; --line: #2c2e31; --fg: #ececea; --fg2: #a3a39e; --fg3: #75756f;
    --accent: #7aa2ff; --on-accent: #0b1220; --ok: #4ade80; --bad: #f87171; --warn: #facc15; --chip: #25272a;
    --new: #7aa2ff; --investigating: #facc15; --fixed: #4ade80; --wontfix: #9ca3af;
  }
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100svh; }
[hidden] { display: none !important; }
h1 { font-size: 16px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 18px; font-weight: 600; margin: 0; }
h3 { font-size: 12px; font-weight: 600; margin: 0 0 8px; color: var(--fg2); text-transform: uppercase; letter-spacing: 0.06em; }
button, input, select, textarea { font: inherit; color: inherit; }
button { border: 1px solid var(--line); background: var(--raised); border-radius: 8px; padding: 6px 12px; cursor: pointer; }
button:hover { border-color: var(--fg3); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
button.quiet { background: transparent; border-color: transparent; color: var(--fg2); }
button.danger { color: var(--bad); }
input, select, textarea { border: 1px solid var(--line); background: var(--raised); border-radius: 8px; padding: 6px 10px; }
input:focus, select:focus, textarea:focus, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
code, pre, .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12.5px; }
.gate { display: grid; place-items: center; min-height: 100svh; padding: 16px; }
.gate-card { width: min(380px, 100%); display: grid; gap: 10px; background: var(--raised); border: 1px solid var(--line); border-radius: 14px; padding: 28px; }
.gate-card p { margin: 0 0 6px; color: var(--fg2); }
.gate-card label { font-weight: 500; }
.error { color: var(--bad); min-height: 1.4em; margin: 0; }
.app { display: grid; grid-template-rows: auto auto 1fr; height: 100svh; }
.top { display: flex; align-items: center; gap: 12px; padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--raised); }
.top input { flex: 1; max-width: 420px; margin-left: auto; }
.filters { display: flex; gap: 6px; padding: 10px 20px; border-bottom: 1px solid var(--line); overflow-x: auto; }
.filters button { border-radius: 999px; padding: 4px 12px; background: transparent; white-space: nowrap; }
.filters button[aria-pressed="true"] { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.filters .count { color: var(--fg3); margin-left: 6px; }
.filters button[aria-pressed="true"] .count { color: inherit; opacity: 0.7; }
.panes { display: grid; grid-template-columns: minmax(280px, 380px) 1fr; min-height: 0; }
.list { border-right: 1px solid var(--line); overflow-y: auto; }
.row { display: grid; gap: 3px; width: 100%; text-align: left; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; padding: 12px 20px; background: transparent; }
.row:hover { background: var(--chip); }
.row[aria-current="true"] { background: var(--raised); box-shadow: inset 3px 0 0 var(--accent); }
.row-head { display: flex; align-items: center; gap: 8px; }
.row-summary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-meta { color: var(--fg3); font-size: 12.5px; }
.pill { display: inline-flex; align-items: center; gap: 5px; border-radius: 999px; padding: 1px 8px; font-size: 12px; background: var(--chip); color: var(--fg2); margin-left: auto; }
.pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--dot, var(--fg3)); }
.pill[data-status="new"] { --dot: var(--new); }
.pill[data-status="investigating"] { --dot: var(--investigating); }
.pill[data-status="fixed"] { --dot: var(--fixed); }
.pill[data-status="wontfix"] { --dot: var(--wontfix); }
.more { width: calc(100% - 40px); margin: 12px 20px; }
.empty { color: var(--fg3); padding: 32px 20px; }
.detail { overflow-y: auto; padding: 24px 28px 48px; display: grid; gap: 20px; align-content: start; }
.title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.title h2 { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.facts { display: flex; flex-wrap: wrap; gap: 6px 16px; color: var(--fg2); }
.card { background: var(--raised); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
.said { white-space: pre-wrap; margin: 0; }
.quiet-text { color: var(--fg3); margin: 0; }
h3.spaced { margin-top: 16px; }
.track { display: grid; gap: 10px; }
.track-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.track-head h3 { margin: 0; }
.track textarea { width: 100%; min-height: 88px; resize: vertical; }
.actions { display: flex; gap: 8px; align-items: center; }
.actions .saved { color: var(--fg3); }
.actions .danger { margin-left: auto; }
dl.grid { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
dl.grid dt { color: var(--fg2); }
dl.grid dd { margin: 0; overflow-wrap: anywhere; }
.checks { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.checks li { display: grid; grid-template-columns: 18px 180px 1fr; gap: 8px; }
.checks .mark { font-weight: 600; }
.checks .ok { color: var(--ok); }
.checks .bad { color: var(--bad); }
.checks .detail-text { color: var(--fg2); overflow-wrap: anywhere; }
.task { border-top: 1px solid var(--line); padding-top: 10px; margin-top: 10px; display: grid; gap: 4px; }
.task:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
.task ul { margin: 2px 0 0; padding-left: 18px; color: var(--fg2); }
details.log { border-top: 1px solid var(--line); padding: 8px 0; }
details.log:first-of-type { border-top: 0; }
details.log summary { cursor: pointer; font-weight: 500; }
details.log pre { margin: 8px 0 0; max-height: 420px; overflow: auto; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 760px) {
  .app { height: auto; }
  .top { flex-wrap: wrap; padding: 12px 16px; }
  .top input { order: 3; max-width: none; flex-basis: 100%; }
  .top .quiet { margin-left: auto; }
  .filters { padding: 10px 16px; }
  .panes { grid-template-columns: 1fr; }
  .list { border-right: 0; max-height: 45svh; }
  .row { padding: 12px 16px; }
  .detail { padding: 20px 16px 40px; }
  .checks li { grid-template-columns: 18px 1fr; }
  .checks .detail-text { grid-column: 2; }
}
`;

export const OWNER_SCRIPT = `"use strict";
(function () {
  var STATUSES = [["", "All"], ["new", "New"], ["investigating", "Investigating"], ["fixed", "Fixed"], ["wontfix", "Won't fix"]];
  var NAMES = { new: "New", investigating: "Investigating", fixed: "Fixed", wontfix: "Won't fix" };
  var state = { token: stored(), status: "", q: "", reports: [], next: null, counts: {}, selected: location.hash.slice(1) || null };
  var searchTimer;
  function $(id) { return document.getElementById(id); }
  function stored() { try { return localStorage.getItem("localdot-owner-token") || ""; } catch (e) { return ""; } }
  function remember(value) {
    try { if (value) localStorage.setItem("localdot-owner-token", value); else localStorage.removeItem("localdot-owner-token"); } catch (e) {}
  }
  function el(tag, props, kids) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (key) {
      var value = props[key];
      if (value === undefined || value === null || value === false) return;
      if (key === "text") node.textContent = String(value);
      else if (key === "class") node.className = value;
      else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : String(value));
    });
    (kids || []).forEach(function (kid) { if (kid !== undefined && kid !== null && kid !== false) node.append(kid); });
    return node;
  }
  function when(iso) {
    var d = new Date(iso);
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function ago(iso) {
    var minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return minutes + " min ago";
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + " h ago";
    return when(iso);
  }
  function size(bytes) { return bytes < 1024 ? bytes + " B" : (bytes / 1024).toFixed(1) + " KB"; }
  function pill(status) { return el("span", { class: "pill", "data-status": status, text: NAMES[status] || status }); }

  async function api(path, options) {
    options = options || {};
    var headers = Object.assign({ authorization: "Bearer " + state.token }, options.body ? { "content-type": "application/json" } : {});
    var response = await fetch(path, Object.assign({}, options, { headers: headers, cache: "no-store" }));
    if (response.status === 401) { signOut("That token isn't right."); throw new Error("unauthorized"); }
    if (!response.ok) throw new Error((await response.text()) || "Request failed");
    return response.status === 204 ? null : response.json();
  }

  function signOut(message) {
    state.token = "";
    remember("");
    $("app").hidden = true;
    $("gate").hidden = false;
    $("gate-error").textContent = message || "";
    $("token").focus();
  }

  // more: the next page, under the rows shown; keep: refresh the list and counts, not the report open.
  async function load(more, keep) {
    var query = new URLSearchParams();
    if (state.status) query.set("status", state.status);
    if (state.q) query.set("q", state.q);
    if (more && state.next) query.set("before", state.next);
    var page = await api("/v1/owner/reports?" + query.toString());
    state.reports = more ? state.reports.concat(page.reports) : page.reports;
    state.next = page.next;
    state.counts = page.counts;
    drawFilters();
    drawList();
    if (!more && !keep) {
      if (state.selected && state.selected.indexOf("LD-") === 0) show(state.selected);
      else if (state.reports[0] && window.matchMedia("(min-width: 761px)").matches) show(state.reports[0].id);
      else $("detail").replaceChildren(el("p", { class: "empty", text: state.reports.length ? "Choose a report." : "" }));
    }
  }

  function drawFilters() {
    var total = 0;
    Object.keys(state.counts).forEach(function (k) { total += state.counts[k]; });
    $("filters").replaceChildren.apply($("filters"), STATUSES.map(function (pair) {
      var count = pair[0] ? state.counts[pair[0]] || 0 : total;
      return el("button", {
        type: "button", "aria-pressed": String(state.status === pair[0]),
        onclick: function () { state.status = pair[0]; load(false).catch(report); }
      }, [pair[1], el("span", { class: "count", text: String(count) })]);
    }));
  }

  function drawList() {
    var list = $("list");
    if (!state.reports.length) {
      list.replaceChildren(el("p", { class: "empty", text: state.q || state.status ? "No reports match." : "No reports yet." }));
      return;
    }
    var rows = state.reports.map(function (r) {
      return el("button", { type: "button", class: "row", "aria-current": String(r.id === state.selected), onclick: function () { show(r.id); } }, [
        el("span", { class: "row-head" }, [el("span", { class: "mono", text: r.id }), pill(r.status)]),
        el("span", { class: "row-summary", text: r.summary }),
        el("span", { class: "row-meta", text: [r.version, r.platform, ago(r.receivedAt)].join(" · ") })
      ]);
    });
    if (state.next) rows.push(el("button", { type: "button", class: "more", text: "Show older reports", onclick: function () { load(true).catch(report); } }));
    list.replaceChildren.apply(list, rows);
  }

  function report(error) {
    if (error && error.message === "unauthorized") return;
    $("detail").replaceChildren(el("p", { class: "error", role: "alert", text: "Couldn't load: " + (error && error.message || error) }));
  }

  async function show(id) {
    state.selected = id;
    history.replaceState(null, "", "#" + id);
    drawList();
    var detail = $("detail");
    detail.replaceChildren(el("p", { class: "quiet-text", text: "Loading " + id + "…" }));
    try {
      var both = await Promise.all([api("/v1/owner/reports/" + id), api("/v1/owner/reports/" + id + "/bundle")]);
      if (state.selected === id) drawDetail(both[0], both[1]);
    } catch (error) { report(error); }
  }

  function drawDetail(r, bundle) {
    var status = el("select", { "aria-label": "Status" }, ["new", "investigating", "fixed", "wontfix"].map(function (s) {
      return el("option", { value: s, selected: s === r.status, text: NAMES[s] });
    }));
    var notes = el("textarea", { "aria-label": "Notes", placeholder: "Notes for yourself: what you found, the fix, a linked issue" });
    notes.value = r.notes;
    var saved = el("span", { class: "saved", role: "status" });
    var badge = pill(r.status);
    var save = el("button", { type: "button", class: "primary", text: "Save", onclick: async function () {
      save.disabled = true;
      try {
        var next = await api("/v1/owner/reports/" + r.id, { method: "PATCH", body: JSON.stringify({ status: status.value, notes: notes.value }) });
        saved.textContent = "Saved";
        var shown = pill(next.status);
        badge.replaceWith(shown);
        badge = shown;
        load(false, true).catch(report);
      } catch (error) { saved.textContent = "Couldn't save: " + error.message; }
      finally { save.disabled = false; }
    } });
    var remove = el("button", { type: "button", class: "danger", text: "Delete report", onclick: async function () {
      if (!confirm("Delete " + r.id + " and its diagnostics? This can't be undone.")) return;
      await api("/v1/owner/reports/" + r.id, { method: "DELETE" });
      state.selected = null;
      history.replaceState(null, "", location.pathname);
      load(false).catch(report);
    } });
    var download = el("button", { type: "button", class: "quiet", text: "Download JSON", onclick: function () {
      var url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
      var link = el("a", { href: url, download: r.id + ".json" });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } });
    $("detail").replaceChildren(
      el("div", { class: "title" }, [
        el("h2", { text: r.id }),
        badge,
        el("button", { type: "button", class: "quiet", text: "Copy ID", onclick: function (event) {
          navigator.clipboard.writeText(r.id).then(function () { event.target.textContent = "Copied"; });
        } }),
        download
      ]),
      el("div", { class: "facts" }, [
        el("span", { text: "Received " + when(r.receivedAt) }),
        el("span", { text: r.version + " (" + r.channel + ")" }),
        el("span", { text: r.platform }),
        el("span", { text: "from the " + (r.source === "cli" ? "command line" : "app") }),
        el("span", { class: "mono", title: "Installation", text: "install " + r.installId.slice(0, 8) }),
        el("span", { text: size(r.bytes) })
      ]),
      el("div", { class: "card" }, [
        el("h3", { text: "Summary" }),
        el("p", { class: "said", text: r.summary }),
        bundle.context ? el("p", { class: "quiet-text", text: "Reported from a " + bundle.context.kind + " problem" + (bundle.context.sessionId ? " in task " + bundle.context.sessionId : "") + (bundle.context.cellId ? " on computer " + bundle.context.cellId : "") }) : null,
        el("h3", { class: "spaced", text: "What happened" }),
        r.description ? el("p", { class: "said", text: r.description }) : el("p", { class: "quiet-text", text: "No description." })
      ]),
      el("div", { class: "card track" }, [el("div", { class: "track-head" }, [el("h3", { text: "Tracking" }), status]), notes, el("div", { class: "actions" }, [save, saved, remove])]),
      overview(bundle),
      checks(bundle),
      computers(bundle),
      tasks(bundle),
      logs(bundle)
    );
  }

  function grid(pairs) {
    return el("dl", { class: "grid" }, pairs.filter(function (p) { return p[1] !== undefined && p[1] !== null && p[1] !== ""; }).reduce(function (all, p) {
      return all.concat([el("dt", { text: p[0] }), el("dd", { text: String(p[1]) })]);
    }, []));
  }

  function overview(b) {
    var update = b.app.update;
    return el("div", { class: "card" }, [el("h3", { text: "This localDot" }), grid([
      ["Version", b.app.version + " · " + b.app.channel],
      ["Installed as", b.app.install],
      ["App", b.app.state + (b.app.uptimeSeconds !== undefined ? ", up " + Math.round(b.app.uptimeSeconds / 60) + " min" : "")],
      ["Updates", update ? update.phase + (update.available ? ", " + update.available + " available" : "") + (update.error ? ", " + update.error : "") : ""],
      ["System", b.host.os + " " + b.host.release + " · " + b.host.arch + " · " + b.host.cpus + " CPUs · " + b.host.memoryGB + " GB"],
      ["Node", b.host.node],
      ["Key service", b.services.keyd],
      ["Docker", b.services.docker],
      ["Remote access", b.services.remoteAccess ? (b.services.remoteAccess.enabled ? "on, " + b.services.remoteAccess.state : "off") : ""],
      ["Created", when(b.createdAt)]
    ])]);
  }

  function checks(b) {
    if (!b.doctor) return el("div", { class: "card" }, [el("h3", { text: "Checks" }), el("p", { class: "quiet-text", text: "Not run: the app wasn't answering." })]);
    var failed = b.doctor.filter(function (c) { return !c.ok; }).length;
    return el("div", { class: "card" }, [
      el("h3", { text: "Checks · " + (failed ? failed + " failed" : "all passed") }),
      el("ul", { class: "checks" }, b.doctor.map(function (c) {
        return el("li", {}, [el("span", { class: "mark " + (c.ok ? "ok" : "bad"), text: c.ok ? "✓" : "✗" }), el("span", { class: "mono", text: c.name }), el("span", { class: "detail-text", text: c.detail })]);
      }))
    ]);
  }

  function computers(b) {
    return el("div", { class: "card" }, [el("h3", { text: "Computers" })].concat(b.computers.length ? b.computers.map(function (c) {
      var br = c.browser;
      return grid([
        ["Computer", c.id + " · " + c.state + (c.flags.length ? " (" + c.flags.join(", ") + ")" : "")],
        ["Operation", c.operation],
        ["Error", c.error],
        ["Web browser", br ? br.state + (br.restarts ? ", restarted " + br.restarts + "×" : "") : ""],
        ["Browser problem", br && br.problem ? br.problem + (br.problemAt ? " (" + when(br.problemAt) + ")" : "") : ""],
        ["Last failure", br && br.lastFailure ? br.lastFailure.kind + ": " + br.lastFailure.detail + (br.lastFailure.recovered ? " (recovered)" : "") + " · " + when(br.lastFailure.at) : ""]
      ]);
    }) : [el("p", { class: "quiet-text", text: "None." })]));
  }

  function tasks(b) {
    return el("div", { class: "card" }, [el("h3", { text: "Recent tasks" })].concat(b.tasks.length ? b.tasks.map(function (t) {
      return el("div", { class: "task" }, [
        el("span", {}, [el("span", { class: "mono", text: t.id }), " · " + (t.ended || "running") + (t.startedAt ? " · " + when(t.startedAt) : "")]),
        el("span", { class: "quiet-text", text: [t.steps !== undefined ? t.steps + " steps" : "", t.failedSteps ? t.failedSteps + " failed" : "", t.models.join(", ")].filter(Boolean).join(" · ") }),
        t.request ? el("p", { class: "said", text: "Asked: " + t.request }) : null,
        t.states.length ? el("ul", {}, t.states.map(function (s) { return el("li", { text: s.state + (s.reason ? ": " + s.reason : "") + (s.detail ? " — " + s.detail : "") }); })) : null,
        t.retries.length ? el("ul", {}, t.retries.map(function (r) { return el("li", { text: "retry" + (r.status ? " " + r.status : "") + ": " + r.message }); })) : null
      ]);
    }) : [el("p", { class: "quiet-text", text: "None." })]));
  }

  function logs(b) {
    return el("div", { class: "card" }, [el("h3", { text: "Logs" })].concat(b.logs.length ? b.logs.map(function (log, i) {
      return el("details", { class: "log", open: i === 0 }, [
        el("summary", { text: log.name + " · " + log.lines.length + " lines" + (log.truncated ? ", older lines left out" : "") }),
        el("pre", { text: log.lines.join("\\n") })
      ]);
    }) : [el("p", { class: "quiet-text", text: "None." })]));
  }

  function start() {
    $("gate").hidden = true;
    $("app").hidden = false;
    load(false).catch(report);
  }

  document.addEventListener("DOMContentLoaded", function () {
    $("signin").addEventListener("submit", function (event) {
      event.preventDefault();
      state.token = $("token").value.trim();
      remember(state.token);
      $("token").value = "";
      start();
    });
    $("signout").addEventListener("click", function () { signOut(""); });
    $("search").addEventListener("input", function (event) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { state.q = event.target.value.trim(); load(false).catch(report); }, 250);
    });
    if (state.token) start(); else signOut("");
  });
})();
`;
