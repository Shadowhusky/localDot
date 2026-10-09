// localDot's service worker: it shows phone notifications and opens the task on a tap. It caches
// nothing and never holds the sign-in token. COPY must match NOTIFY_COPY in
// packages/protocol/src/notify.ts (sw.test.ts checks).
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
      icon: "/icons/icon-192.png",
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
