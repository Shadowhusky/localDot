import { describe, expect, it } from "vitest";
import { localUrl, localUrlsIn, mayBeComputer, mentionsPrivateAddress } from "./local-urls.ts";

const COMPUTER = ["172.20.0.11"];
const hrefs = (text: string, addresses: readonly string[] = [], limit?: number) =>
  localUrlsIn(text, addresses, limit).map((url) => url.href);

describe("addresses of servers in dot's computer", () => {
  it("names each by its host and any path beyond the root", () => {
    expect(localUrl("http://localhost:5173")).toMatchObject({
      href: "http://localhost:5173/",
      label: "localhost:5173",
    });
    expect(localUrl("https://thema.localhost:1355/app?tab=2")?.label).toBe(
      "thema.localhost:1355/app?tab=2",
    );
    expect(localUrl("http://[::1]:4173/")?.label).toBe("[::1]:4173");
    expect(localUrl("http://172.20.0.11:5173/", COMPUTER)?.label).toBe("172.20.0.11:5173");
    expect(localUrl("http://172.20.0.11:5173/")).toBeUndefined();
    expect(localUrl("https://example.com/")).toBeUndefined();
  });

  it("finds loopback, any-address, *.localhost and the computer's own addresses on any port", () => {
    expect(
      hrefs(
        "a http://localhost:5173/ b https://127.0.0.1:8443/x c http://0.0.0.0:8000 d http://[::1]:4173/ e https://api.thema.localhost:1355/",
      ),
    ).toEqual([
      "http://localhost:5173/",
      "https://127.0.0.1:8443/x",
      "http://0.0.0.0:8000/",
      "http://[::1]:4173/",
      "https://api.thema.localhost:1355/",
    ]);
    expect(hrefs("Network: http://172.20.0.11:3000/", COMPUTER)).toEqual([
      "http://172.20.0.11:3000/",
    ]);
  });

  it("counts a server once, whichever of its loopback names or address it printed", () => {
    const vite = [
      "  VITE v7.1.2  ready in 312 ms",
      "  ➜  Local:   http://localhost:5173/",
      "  ➜  Network: http://172.20.0.11:5173/",
      "  ➜  Also:    http://127.0.0.1:5173/ and http://0.0.0.0:5173",
    ].join("\n");
    expect(hrefs(vite, COMPUTER)).toEqual(["http://localhost:5173/"]);
    // Another scheme or port is another server; each *.localhost name is its own site.
    expect(
      hrefs(
        "http://localhost:5173 https://localhost:5173 http://localhost:5174 https://a.localhost:1355 https://b.localhost:1355 https://a.localhost:1355/x",
      ),
    ).toEqual([
      "http://localhost:5173/",
      "https://localhost:5173/",
      "http://localhost:5174/",
      "https://a.localhost:1355/",
      "https://b.localhost:1355/",
    ]);
  });

  it("leaves the punctuation around an address out of it", () => {
    expect(hrefs("Open it (at http://localhost:3000/).")).toEqual(["http://localhost:3000/"]);
    expect(hrefs("Ready: http://localhost:3000/docs, then reload!")).toEqual([
      "http://localhost:3000/docs",
    ]);
    expect(hrefs("[http://localhost:8080]")).toEqual(["http://localhost:8080/"]);
    expect(hrefs("│ http://localhost:4321/│")).toEqual(["http://localhost:4321/"]);
    expect(hrefs('href="http://localhost:9000/a"')).toEqual(["http://localhost:9000/a"]);
  });

  it("ignores every other address", () => {
    expect(
      hrefs(
        "https://example.com http://192.168.1.4:5173 http://10.0.0.2:80 http://localhost.example.com:3000 http://user:pw@localhost:3000 ftp://localhost:21",
        COMPUTER,
      ),
    ).toEqual([]);
  });

  it("keeps to a bounded search and a bounded count", () => {
    const many = Array.from({ length: 20 }, (_, i) => `http://localhost:${5000 + i}/`).join(" ");
    expect(hrefs(many)).toHaveLength(6);
    expect(hrefs(many, [], 2)).toEqual(["http://localhost:5000/", "http://localhost:5001/"]);
    expect(hrefs(`${"x".repeat(40_000)} http://localhost:3000/`)).toEqual([]);
  });

  it("tells when only the computer's status can say whether an address is its own", () => {
    expect(mayBeComputer("http://172.20.0.11:5173/")).toBe(true);
    expect(mayBeComputer("http://192.168.0.3/")).toBe(true);
    expect(mayBeComputer("http://8.8.8.8/")).toBe(false);
    expect(mayBeComputer("http://localhost:5173/")).toBe(false);
    expect(mayBeComputer("http://3f2a9c1b7d4e:8888/lab")).toBe(true);
    expect(localUrl("http://3f2a9c1b7d4e:8888/lab", [...COMPUTER, "3f2a9c1b7d4e"])?.label).toBe(
      "3f2a9c1b7d4e:8888/lab",
    );
    expect(mentionsPrivateAddress("Network: http://10.1.2.3:5173/")).toBe(true);
    expect(mentionsPrivateAddress("Local: http://localhost:5173/")).toBe(false);
  });
});
