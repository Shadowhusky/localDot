import { ULID_PATTERN } from "@localdot/protocol";

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

// Calls open for every notification tap: a new window's fragment, a fragment change, or the
// service worker telling an already open window which task to show.
export function listenForSessionLinks(
  open: (sessionId: string) => void,
  host: SessionLinkHost & Pick<Window, "addEventListener" | "removeEventListener"> = window,
  worker:
    | Pick<ServiceWorkerContainer, "addEventListener" | "removeEventListener">
    | undefined = navigator.serviceWorker,
): () => void {
  const fromHash = () => {
    const id = takeSessionLink(host);
    if (id) open(id);
  };
  const fromWorker = (event: Event) => {
    const data = (event as MessageEvent).data as { type?: unknown; sessionId?: unknown } | null;
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
    host.removeEventListener("hashchange", fromHash);
    worker?.removeEventListener("message", fromWorker);
  };
}
