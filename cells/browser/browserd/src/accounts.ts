import { isIP } from "node:net";
import type { BrowserTargets } from "./targets.ts";

export const MAX_COOKIE_DOMAINS = 5000;
const HOST =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

export class BrowserAccountsError extends Error {
  constructor(readonly reason: "request" | "unavailable") {
    super(`Browser sign-ins refused: ${reason}`);
  }
}

const host = (domain: string) => domain.replace(/^\./u, "").toLowerCase();

export function isSiteName(value: unknown): value is string {
  return typeof value === "string" && HOST.test(value) && isIP(value) === 0;
}

// The sites the profile holds cookies for, by cookie domain, and signing out of one: its
// cookies and the storage of every host they were set for.
export class BrowserAccounts {
  constructor(
    private readonly targets: Pick<BrowserTargets, "cookies" | "tabs" | "documents" | "command">,
  ) {}

  async domains(): Promise<{ domain: string; count: number }[]> {
    const counts = new Map<string, number>();
    for (const cookie of await this.targets.cookies()) {
      const domain = host(cookie.domain);
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
    return [...counts]
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => a.domain.localeCompare(b.domain))
      .slice(0, MAX_COOKIE_DOMAINS);
  }

  async signOut(site: string): Promise<{ cookies: number }> {
    if (!isSiteName(site)) throw new BrowserAccountsError("request");
    const tab = this.targets.tabs().find((candidate) => candidate.ready);
    const document = tab && this.targets.documents(tab.id).find((candidate) => !candidate.frame);
    if (!document) throw new BrowserAccountsError("unavailable");
    const belongs = (domain: string) => domain === site || domain.endsWith(`.${site}`);
    const cookies = (await this.targets.cookies()).filter((cookie) => belongs(host(cookie.domain)));
    for (const cookie of cookies)
      await this.targets.command(document, "Network.deleteCookies", {
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
      });
    const hosts = new Set([site, `www.${site}`, ...cookies.map((cookie) => host(cookie.domain))]);
    for (const name of hosts) {
      if (!isSiteName(name)) continue;
      for (const scheme of ["https", "http"])
        await this.targets.command(document, "Storage.clearDataForOrigin", {
          origin: `${scheme}://${name}`,
          storageTypes: "all",
        });
    }
    return { cookies: cookies.length };
  }
}
