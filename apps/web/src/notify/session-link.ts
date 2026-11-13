import { ULID_PATTERN } from "@localdot/protocol";
import { isStandalone } from "./this-device.ts";

export interface SessionLinkHost {
  location: { hash: string; pathname: string; search: string };
  history: { replaceState(data: unknown, unused: string, url?: string): void };
}

// "#session=<id>" from a notification tap. Read it once and remove it from the address.
export function takeSessionLink(host: SessionLinkHost = window): string | null {
  const params = new URLSearchParams(host.location.hash.replace(/^#/, ""));
  const id = params.get("session");
  if (id === null) return null;
  host.history.replaceState(null, "", `${host.location.pathname}${host.location.search}`);
  return ULID_PATTERN.test(id) ? id : null;
}

interface LaunchQueue {
  setConsumer(consumer: (params: { targetURL?: string }) => void): void;
}

// The task a link names, as "#session=<id>".
function sessionOf(link: string): string | null {
  if (!URL.canParse(link)) return null;
  const id = new URLSearchParams(new URL(link).hash.replace(/^#/, "")).get("session");
  return id !== null && ULID_PATTERN.test(id) ? id : null;
}

// Calls open for every notification tap: a new window's fragment, a fragment change, the service
// worker telling an already open window which task to show, or a link from this Mac's banner that
// the installed app takes in its open window. Tells the worker, when it asks, whether this window is
// the installed app's, which a tap goes to first.
export function listenForSessionLinks(
  open: (sessionId: string) => void,
  host: SessionLinkHost & Pick<Window, "addEventListener" | "removeEventListener"> = window,
  worker:
    | Pick<ServiceWorkerContainer, "addEventListener" | "removeEventListener">
    | undefined = navigator.serviceWorker,
  launches: LaunchQueue | undefined = (window as { launchQueue?: LaunchQueue }).launchQueue,
  standalone: () => boolean = isStandalone,
): () => void {
  let listening = true;
  launches?.setConsumer(({ targetURL }) => {
    const id = listening && targetURL ? sessionOf(targetURL) : null;
    if (id) open(id);
  });
  const fromHash = () => {
    const id = takeSessionLink(host);
    if (id) open(id);
  };
  const fromWorker = (event: Event) => {
    const message = event as MessageEvent;
    const data = message.data as { type?: unknown; sessionId?: unknown } | null;
    if (data?.type === "display-mode") {
      message.ports[0]?.postMessage({ standalone: standalone() });
      return;
    }
    if (
      data?.type === "open-session" &&
      typeof data.sessionId === "string" &&
      ULID_PATTERN.test(data.sessionId)
    )
      open(data.sessionId);
  };
  host.addEventListener("hashchange", fromHash);
  worker?.addEventListener("message", fromWorker);
  fromHash();
  return () => {
    listening = false;
    host.removeEventListener("hashchange", fromHash);
    worker?.removeEventListener("message", fromWorker);
  };
}
