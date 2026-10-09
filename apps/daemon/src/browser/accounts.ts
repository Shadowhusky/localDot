import { isIP } from "node:net";
import { ULID_PATTERN } from "@localdot/protocol";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  type SignInSite,
  SignInSites,
  SignOutRequest,
} from "../../../../packages/protocol/src/accounts.ts";
import { abortable } from "../agent/session.ts";
import type { BrowserOrchestrator, ReadyBrowser } from "../cells/browser-orchestrator.ts";
import type { CellApi } from "../cells/orchestrator.ts";
import { siteOf } from "../sites.ts";
import { BrowserClient, type BrowserScope } from "./client.ts";

const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;

// Groups cookie domains into the sites a person recognises; local names and addresses are left
// out, as the web browser cannot open them.
export function signInSites(domains: { domain: string; count: number }[]): SignInSite[] {
  const sites = new Map<string, { hosts: Set<string>; cookies: number }>();
  for (const { domain, count } of domains) {
    const host = domain.replace(/^\./u, "").toLowerCase();
    if (!HOST.test(host) || isIP(host) !== 0 || host.length > 253) continue;
    const site = siteOf(host);
    const entry = sites.get(site) ?? { hosts: new Set<string>(), cookies: 0 };
    entry.hosts.add(host);
    entry.cookies += count;
    sites.set(site, entry);
  }
  return SignInSites.parse({
    sites: [...sites]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([site, { hosts, cookies }]) => ({
        site,
        hosts: [...hosts].sort().slice(0, 64),
        cookies,
      })),
  }).sites;
}

class StartFailed extends Error {}

export interface AccountsDeps {
  cells: Pick<CellApi, "get">;
  browser: Pick<BrowserOrchestrator, "start" | "endpoints" | "clearAccounts">;
  client?(endpoint: ReadyBrowser): Pick<BrowserClient, "cookieDomains" | "signOut" | "close">;
}

// Settings > Accounts. Mount behind the daemon's install-token middleware.
export function accountsRoutes(app: Hono, deps: AccountsDeps): void {
  const withBrowser = async <T>(
    parent: string,
    signal: AbortSignal,
    work: (
      client: Pick<BrowserClient, "cookieDomains" | "signOut">,
      scope: BrowserScope,
    ) => Promise<T>,
  ): Promise<T> => {
    // The start outlives the request: Settings closing or the request timing out only stops
    // the wait.
    const starting = deps.browser.start(parent);
    starting.catch(() => {});
    const endpoint = await abortable(starting, signal).catch((error: unknown) => {
      throw signal.aborted ? error : new StartFailed();
    });
    const client = deps.client?.(endpoint) ?? new BrowserClient(endpoint);
    try {
      return await work(client, {
        signal,
        check: () => {
          if (deps.browser.endpoints(parent)?.instance !== endpoint.instance)
            throw new Error("The web browser restarted.");
        },
      });
    } finally {
      client.close();
    }
  };
  const unavailable = (c: Context, error: unknown) =>
    error instanceof StartFailed
      ? c.text("the web browser couldn't start", 502)
      : c.text("the web browser is not ready yet", 503);
  const computerOn = (id: string) => {
    const cell = deps.cells.get(id);
    return cell?.state === "ready" && !cell.paused && !cell.fenced && !cell.replacementPending;
  };

  app.get("/api/cells/:id/accounts", async (c) => {
    const id = c.req.param("id");
    if (!ULID_PATTERN.test(id)) return c.text("invalid computer id", 400);
    if (!computerOn(id)) return c.text("the computer is off", 409);
    try {
      const domains = await withBrowser(id, c.req.raw.signal, (client, scope) =>
        client.cookieDomains(scope),
      );
      return c.json({ sites: signInSites(domains) });
    } catch (error) {
      return unavailable(c, error);
    }
  });

  app.post("/api/cells/:id/accounts/sign-out", bodyLimit({ maxSize: 1024 }), async (c) => {
    const id = c.req.param("id");
    if (!ULID_PATTERN.test(id)) return c.text("invalid computer id", 400);
    const request = SignOutRequest.safeParse(await c.req.json().catch(() => null));
    if (!request.success) return c.text("invalid site", 400);
    if (!computerOn(id)) return c.text("the computer is off", 409);
    try {
      const sites = await withBrowser(id, c.req.raw.signal, async (client, scope) => {
        const found = signInSites(await client.cookieDomains(scope));
        if (!found.some((entry) => entry.site === request.data.site)) return undefined;
        await client.signOut(request.data.site, scope);
        return signInSites(await client.cookieDomains(scope));
      });
      return sites ? c.json({ sites }) : c.text("no sign-ins for that site", 404);
    } catch (error) {
      return unavailable(c, error);
    }
  });

  app.post("/api/accounts/clear", async (c) => {
    try {
      await deps.browser.clearAccounts();
      return c.json({ sites: [] });
    } catch {
      return c.text("sign-ins could not be cleared; try again", 409);
    }
  });
}
