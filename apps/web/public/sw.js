// localDot's service worker: it shows phone notifications and opens the task on a tap, and answers
// a page load while localDot is restarting. It caches nothing and never holds the sign-in token.
// COPY must match NOTIFY_COPY in packages/protocol/src/notify.ts (sw.test.ts checks).
const COPY = {
  needs_you: { title: "dot needs you", body: "Open localDot to answer." },
  blocked: { title: "Task paused: budget reached", body: "Open localDot to raise it or stop." },
  done: { title: "Task done", body: "Open localDot to see the result." },
  failed: { title: "Task failed", body: "Open localDot to see what happened." },
  routine: { title: "Routine update", body: "Open localDot to see the result." },
  test: { title: "Notifications are on", body: "This is a test from localDot." },
};
const UNKNOWN = { title: "localDot", body: "Open localDot to see what's new." };
const SESSION = /^[0-9A-HJKMNP-TV-Z]{26}$/;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// What a front such as Tailscale Serve or the relay answers while localDot is down.
const DOWN = new Set([502, 503, 504]);
const WAITING_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>localDot</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100dvh; display: grid; place-content: center; padding: 16px;
    font: 15px/1.45 system-ui, sans-serif; text-align: center; background: Canvas; color: CanvasText; }
  h1 { margin: 0 0 6px; font-size: 20px; font-weight: 600; }
  p { margin: 0; opacity: .72; }
</style>
<h1 id="title">localDot is restarting</h1>
<p id="line">This page reconnects by itself.</p>
<script>
  try {
    const version = localStorage.getItem("localdot.app-update");
    if (version) document.getElementById("title").textContent = "Updating localDot to " + version;
  } catch {}
  const started = Date.now();
  const ask = async () => {
    try {
      const answer = await fetch("/healthz", { cache: "no-store" });
      if (answer.ok) return location.reload();
    } catch {}
    if (Date.now() - started > 300000)
      document.getElementById("line").textContent =
        "localDot hasn't come back. On the computer running it, run localdot up. This page keeps trying.";
    setTimeout(ask, 2000);
  };
  ask();
</script>
</html>`;
const waitingPage = () =>
  new Response(WAITING_PAGE, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).then(
      (response) => (DOWN.has(response.status) ? waitingPage() : response),
      () => waitingPage(),
    ),
  );
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = (event.data ? event.data.json() : {}) ?? {};
  } catch {
    payload = {};
  }
  const kind =
    typeof payload.kind === "string" && Object.hasOwn(COPY, payload.kind) ? payload.kind : null;
  const copy = kind ? COPY[kind] : UNKNOWN;
  const sessionId =
    typeof payload.sessionId === "string" && SESSION.test(payload.sessionId)
      ? payload.sessionId
      : null;
  const title =
    typeof payload.title === "string" && payload.title ? payload.title.slice(0, 80) : null;
  event.waitUntil(
    self.registration.showNotification(copy.title, {
      body: title ?? copy.body,
      tag: `${kind ?? "other"}:${sessionId ?? "none"}`,
      icon: "/icons/icon-192.png?v=mascot-1",
      data: { sessionId },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = event.notification.data?.sessionId ?? null;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        open.postMessage({ type: "open-session", sessionId });
        return;
      }
      await self.clients.openWindow(sessionId ? `/#session=${sessionId}` : "/");
    })(),
  );
});
