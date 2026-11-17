import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserAccounts, isSiteName } from "./accounts.ts";
import { CdpRefused, guardCdpCommand } from "./cdp-guard.ts";
import { BrowserControl } from "./control.ts";
import { BrowserHttp } from "./http.ts";
import type { BrowserCookie, BrowserDocument } from "./targets.ts";

const document: BrowserDocument = { tabId: "t", revision: 1, frame: false };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function targets(cookies: BrowserCookie[], ready = true) {
  const command = vi.fn(async () => ({}));
  return {
    command,
    value: {
      cookies: vi.fn(async () => cookies),
      tabs: () => [{ id: "t", ready }],
      documents: () => [document, { ...document, frame: true }],
      command,
    },
  };
}

const jar: BrowserCookie[] = [
  { name: "SID", domain: ".google.com", path: "/" },
  { name: "HSID", domain: ".google.com", path: "/" },
  { name: "LSID", domain: "accounts.google.com", path: "/" },
  { name: "x", domain: "notgoogle.com", path: "/" },
  { name: "stel_ssid", domain: "web.telegram.org", path: "/a" },
];

describe("sign-ins in the shared browser", () => {
  it("lists cookie domains with counts and nothing else", async () => {
    const f = targets(jar);
    expect(await new BrowserAccounts(f.value).domains()).toEqual([
      { domain: "accounts.google.com", count: 1 },
      { domain: "google.com", count: 2 },
      { domain: "notgoogle.com", count: 1 },
      { domain: "web.telegram.org", count: 1 },
    ]);
  });

  it("signs out of one site: its cookies on every subdomain, then each host's storage", async () => {
    const f = targets(jar);
    expect(await new BrowserAccounts(f.value).signOut("google.com")).toEqual({ cookies: 3 });
    const calls = f.command.mock.calls as unknown as [BrowserDocument, string, unknown][];
    expect(calls.every(([used]) => used === document)).toBe(true);
    expect(
      calls.filter(([, method]) => method === "Network.deleteCookies").map(([, , p]) => p),
    ).toEqual([
      { name: "SID", domain: ".google.com", path: "/" },
      { name: "HSID", domain: ".google.com", path: "/" },
      { name: "LSID", domain: "accounts.google.com", path: "/" },
    ]);
    expect(
      calls
        .filter(([, method]) => method === "Storage.clearDataForOrigin")
        .map(([, , p]) => (p as { origin: string }).origin),
    ).toEqual([
      "https://google.com",
      "http://google.com",
      "https://www.google.com",
      "http://www.google.com",
      "https://accounts.google.com",
      "http://accounts.google.com",
    ]);
  });

  it("deletes a partitioned cookie inside its partition", async () => {
    const partitionKey = { topLevelSite: "https://news.test", hasCrossSiteAncestor: false };
    const f = targets([{ name: "chat", domain: "chat.google.com", path: "/", partitionKey }]);
    await new BrowserAccounts(f.value).signOut("google.com");
    expect(f.command).toHaveBeenCalledWith(document, "Network.deleteCookies", {
      name: "chat",
      domain: "chat.google.com",
      path: "/",
      partitionKey,
    });
  });

  it("refuses an address that is not a site name, and works only with an open page", async () => {
    for (const site of ["google", "1.2.3.4", "https://google.com", "a..com", "GOOGLE.com"])
      expect(isSiteName(site)).toBe(false);
    await expect(new BrowserAccounts(targets(jar).value).signOut("google")).rejects.toThrow(
      "request",
    );
    await expect(
      new BrowserAccounts(targets(jar, false).value).signOut("google.com"),
    ).rejects.toThrow("unavailable");
  });

  it("lets only the browser's own pages delete cookies and clear site storage", () => {
    const capabilities = {
      downloadDir: "/downloads",
      uploadDir: "/tmp/uploads",
      ownsTarget: () => true,
      ownsSession: (id: string) => id === "owned",
      ownsWindow: () => true,
      ownsNode: () => true,
      ownsDownload: () => true,
      allowsUpload: () => true,
    };
    expect(guardCdpCommand("Storage.getCookies", {}, capabilities).method).toBe(
      "Storage.getCookies",
    );
    const refused = (method: string, params: unknown, session?: string) =>
      expect(() => guardCdpCommand(method, params, capabilities, session)).toThrow(CdpRefused);
    const cookie = { name: "SID", domain: ".google.com", path: "/" };
    refused("Network.deleteCookies", cookie);
    refused("Network.deleteCookies", cookie, "foreign");
    expect(guardCdpCommand("Network.deleteCookies", cookie, capabilities, "owned").sessionId).toBe(
      "owned",
    );
    for (const partitionKey of [
      "https://news.test",
      { topLevelSite: "https://news.test", hasCrossSiteAncestor: true },
    ])
      expect(
        guardCdpCommand("Network.deleteCookies", { ...cookie, partitionKey }, capabilities, "owned")
          .method,
      ).toBe("Network.deleteCookies");
    refused("Network.deleteCookies", { ...cookie, partitionKey: { topLevelSite: 1 } }, "owned");
    refused("Network.getAllCookies", {}, "owned");
    refused("Storage.setCookies", { cookies: [] });
    const clear = (origin: string) => ({ origin, storageTypes: "all" });
    expect(
      guardCdpCommand(
        "Storage.clearDataForOrigin",
        clear("https://a.google.com"),
        capabilities,
        "owned",
      ).method,
    ).toBe("Storage.clearDataForOrigin");
    for (const origin of ["https://a.google.com/x", "file:///etc", "https://10.0.0.1", "*"])
      refused("Storage.clearDataForOrigin", clear(origin), "owned");
    refused("Storage.clearDataForOrigin", clear("https://google.com"));
  });

  it("answers over the authenticated service with domains and counts only", async () => {
    const control = new BrowserControl({
      browserCellId: "01K6NZAGJT44QM01BDMEMSHP25",
      parentCellId: "01K6NZAGJT44QM01BDMEMSHP26",
      instance: "54ca7ee3-bff0-40eb-a8c6-08ca30443067",
      clearSelections: async () => {},
      secretPages: async () => [],
      reload: async () => {},
    });
    const signOut = vi.fn(async () => ({ cookies: 3 }));
    const service = new BrowserHttp({
      config: {
        browserCellId: "01K6NZAGJT44QM01BDMEMSHP25",
        parentCellId: "01K6NZAGJT44QM01BDMEMSHP26",
        serviceToken: "a".repeat(43),
        streamToken: "b".repeat(43),
        gateAddress: "10.0.0.2",
        scale: 2,
        fullcolor: false,
      },
      instance: "54ca7ee3-bff0-40eb-a8c6-08ca30443067",
      control,
      targets: { tabs: () => [] },
      input: { inject: vi.fn(), type: vi.fn() },
      observation: { observe: vi.fn() },
      accounts: { domains: async () => [{ domain: "google.com", count: 2 }], signOut },
      ready: () => true,
      fence: () => {},
      stop: async () => {},
      retirement: () => undefined,
    });
    service.server.listen(0, "127.0.0.1");
    await once(service.server, "listening");
    cleanups.push(() => service.close());
    const address = service.server.address();
    if (!address || typeof address === "string") throw new Error("fixture address missing");
    const base = `http://127.0.0.1:${address.port}`;
    const authorization = `Bearer ${"a".repeat(43)}`;
    expect((await fetch(`${base}/accounts/cookies`)).status).toBe(401);
    const listed = await fetch(`${base}/accounts/cookies`, { headers: { authorization } });
    expect(await listed.json()).toEqual({ domains: [{ domain: "google.com", count: 2 }] });
    const post = (body: unknown) =>
      fetch(`${base}/accounts/sign-out`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post({ site: "google" })).status).toBe(400);
    expect((await post({ site: "google.com", extra: 1 })).status).toBe(400);
    const done = await post({ site: "google.com" });
    expect(await done.json()).toEqual({ cookies: 3 });
    expect(signOut).toHaveBeenCalledWith("google.com");
  });
});
