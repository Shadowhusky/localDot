import type { AgentRoleChoice } from "@localdot/protocol";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n/index.ts";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { providerName } from "../settings/choices.ts";
import type { ModelNames } from "../settings/model-names.ts";
import { type ModelGroup, type ModelOption, optionId } from "../settings/model-options.ts";
import type { ShareLink } from "../settings/ShareLinkControls.tsx";

export type GuestGrant = ShareLink & {
  ownedSessions: string[];
  // What the computer's catalog calls the link's models.
  names?: { provider: string; model: string; name: string }[];
};

export interface Guest {
  grant: GuestGrant;
  // The link's task count, model and tasks changed: read them again.
  refresh(): Promise<void>;
  owns(sessionId: string | null | undefined): boolean;
}

const GuestContext = createContext<Guest | null>(null);
export const GuestProvider = GuestContext.Provider;
// The shared link this page was opened with; null for the owner.
export const useGuest = () => useContext(GuestContext);

const ID = "[0-9A-Z]{26}";
const READS = [
  /^\/api\/(?:whoami|clock|remote-session|cells|runtime|conversation|conversations)$/,
  new RegExp(`^/api/cells/${ID}(?:/(?:live|status))?$`),
  new RegExp(`^/api/agent/sessions/${ID}$`),
  new RegExp(`^/api/sessions/${ID}/(?:events|history|stream|clock)$`),
  new RegExp(`^/api/agent/sessions/${ID}/conversation-files$`),
  new RegExp(
    `^/api/agent/sessions/${ID}/files/[^/]+/(?:versions(?:/\\d+)?|preview|pages|text|table|compare)$`,
  ),
];
const BROWSER_READ = new RegExp(`^/api/browsers/${ID}(?:/status)?$`);
const RECORDINGS = new RegExp(
  `^/api/sessions(?:/${ID}(?:/(?:card|recording|manifest|fragments|frames|thumbs|thumbnail|summary|events|history|replay)(?:/[a-zA-Z0-9._-]+)*)?)?$`,
);
const WRITES = [
  new RegExp(`^/api/cells/${ID}/(?:agent|stream-ticket)$`),
  /^\/api\/conversation\/(?:new|continue)$/,
];
const BROWSER_WRITE = new RegExp(`^/api/cells/${ID}/browser-stream-ticket$`);
const OWN_TASK = new RegExp(
  `^/api/agent/sessions/(${ID})/(?:messages|stop|answer|preview-link|messages/${ID}/(?:steer|edit|cancel|move))$`,
);
const TASK = /^\/api\/(?:agent\/)?(?:sessions|conversations)\/([^/]*)/;

// What a model reads as: the name the computer's catalog gives it; a plan's "default" by its plan.
function modelName(grant: GuestGrant, provider: string, model: string): string {
  const named = grant.names?.find((each) => each.provider === provider && each.model === model);
  if (named) return named.name;
  return model === "default" ? t`Default · ${providerName(provider)}` : model;
}

export function guestModelName(grant: GuestGrant, choice: AgentRoleChoice): string {
  return modelName(grant, choice.provider, choice.model);
}

export function guestNames(grant: GuestGrant): ModelNames {
  return {
    provider: (route) => route,
    name: (route, model) =>
      grant.names?.find((each) => each.provider === route && each.model === model)?.name ??
      grant.names?.find((each) => each.model === model)?.name ??
      modelName(grant, route, model),
  };
}

// The link's models for the composer's model menu, under their providers' names.
export function guestModelGroups(grant: GuestGrant): ModelGroup[] {
  const groups = new Map<string, ModelOption[]>();
  for (const choice of grant.chooseModel ? grant.models : [grant.model]) {
    const label = providerName(choice.provider);
    groups.set(label, [
      ...(groups.get(label) ?? []),
      { id: optionId(choice), name: guestModelName(grant, choice), choice },
    ]);
  }
  return [...groups].map(([label, options]) => ({ label, options }));
}

// What the daemon lets a link do (`RemoteLinks.permits`), so the page asks for nothing it would be
// refused. The daemon still decides: this only keeps refused requests off the wire.
export function guestPermits(grant: GuestGrant, method: string, address: string): boolean {
  const path = address.split(/[?#]/)[0] ?? "";
  const task = TASK.exec(path)?.[1];
  const own = task === undefined || grant.ownedSessions.includes(task);
  if (method === "GET" || method === "HEAD")
    return (
      (grant.replay && (RECORDINGS.test(path) || path === "/api/session-index")) ||
      (own && ((grant.apps && BROWSER_READ.test(path)) || READS.some((rule) => rule.test(path))))
    );
  if (method !== "POST" || !own) return false;
  if (path === "/api/remote-session/model") return grant.chooseModel;
  if (OWN_TASK.test(path)) return true;
  return (grant.apps && BROWSER_WRITE.test(path)) || WRITES.some((rule) => rule.test(path));
}

const REFUSED = "This link does not allow that action";

// The owner's client with the link's limits in front of it.
export function guestApi(api: ApiClient, guest: () => Guest | null): ApiClient {
  const allowed = async (method: string, path: string) => {
    const now = guest();
    if (!now) return false;
    if (guestPermits(now.grant, method, path)) return true;
    // A task this link just started may not be on its list yet.
    if (!TASK.test(path.split(/[?#]/)[0] ?? "")) return false;
    await now.refresh().catch(() => {});
    const again = guest();
    return !!again && guestPermits(again.grant, method, path);
  };
  const guard = async (method: string, path: string) => {
    if (!(await allowed(method, path))) throw new ApiError(403, REFUSED);
  };
  return {
    ...api,
    permits: (method, path) => {
      const now = guest();
      return !!now && guestPermits(now.grant, method, path);
    },
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request ? request.url : String(input), window.location.href);
      const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
      if (url.pathname.startsWith("/api/") && !(await allowed(method, url.pathname)))
        return new Response(REFUSED, { status: 403 });
      return api.fetch(input, init);
    },
    get: async (path, options) => {
      await guard("GET", path);
      return api.get(path, options);
    },
    post: async (path, body) => {
      await guard("POST", path);
      return api.post(path, body);
    },
    put: async (path, body) => {
      await guard("PUT", path);
      return api.put(path, body);
    },
    del: async (path) => {
      await guard("DELETE", path);
      return api.del(path);
    },
  };
}

const POLL_MS = 5000;

// The link's grant, read before the app opens and again as it is used.
export function useGuestLink(api: ApiClient): { guest: Guest | null; api: ApiClient } {
  const [grant, setGrant] = useState<GuestGrant | null>(null);
  const latest = useRef<Guest | null>(null);
  const read = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    let busy: Promise<void> | null = null;
    const load = () => {
      busy ??= api
        .get<GuestGrant>("/api/remote-session", { signal: abort.signal })
        .then((value) => {
          // Unchanged, it stays the same object, so nothing draws again for a poll.
          if (!abort.signal.aborted)
            setGrant((was) => (was && JSON.stringify(was) === JSON.stringify(value) ? was : value));
        })
        .finally(() => {
          busy = null;
        });
      return busy;
    };
    read.current = load;
    void load().catch(() => {});
    const timer = setInterval(() => {
      if (!document.hidden) void load().catch(() => {});
    }, POLL_MS);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [api]);
  const guest = useMemo<Guest | null>(
    () =>
      grant && {
        grant,
        refresh: () => read.current?.() ?? Promise.resolve(),
        owns: (sessionId) => !!sessionId && grant.ownedSessions.includes(sessionId),
      },
    [grant],
  );
  latest.current = guest;
  const limited = useMemo(() => guestApi(api, () => latest.current), [api]);
  return { guest, api: limited };
}
