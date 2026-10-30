import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { previewTarget } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import {
  bodyRewrite,
  deviceCookie,
  deviceHeader,
  pendingFrom,
  previewUrl,
  type Route,
  rewriteText,
  TextRewriter,
  viaOf,
} from "./rewrite.ts";

const FRONT = "100.91.187.75:4900";
const PREVIEW = `https://${FRONT}`;
const computer = { addresses: ["172.20.0.11", "3f2a9c1b7d4e"], ports: new Set([3000, 5173, 1355]) };

function route(address = "http://localhost:5173/", via?: string): Route {
  const target = previewTarget(address, computer.addresses);
  if (!target) throw new Error(`not in the computer: ${address}`);
  return { front: FRONT, target, computer, ...(via ? { via } : {}) };
}

describe("an address in a header", () => {
  it("opens the server's own address, by any of its names, at the preview", () => {
    for (const address of [
      "http://localhost:5173/login?next=%2F#top",
      "http://127.0.0.1:5173/login?next=%2F#top",
      "http://0.0.0.0:5173/login?next=%2F#top",
      "http://[::1]:5173/login?next=%2F#top",
      "http://172.20.0.11:5173/login?next=%2F#top",
      "http://3f2a9c1b7d4e:5173/login?next=%2F#top",
      "https://localhost:5173/login?next=%2F#top",
    ])
      expect(previewUrl(address, route()), address).toBe(`${PREVIEW}/login?next=%2F#top`);
    expect(previewUrl("ws://localhost:5173/hmr", route())).toBe(`wss://${FRONT}/hmr`);
  });

  it("sends another server listening in the computer through the via path", () => {
    expect(previewUrl("http://localhost:3000/auth/callback?code=1", route())).toBe(
      `${PREVIEW}/__localdot/to/http/localhost/3000/auth/callback?code=1`,
    );
    expect(previewUrl("https://127.0.0.1:3000/", route())).toBe(
      `${PREVIEW}/__localdot/to/https/127.0.0.1/3000/`,
    );
    expect(previewUrl("http://0.0.0.0:3000/x", route())).toBe(
      `${PREVIEW}/__localdot/to/http/localhost/3000/x`,
    );
  });

  it("keeps each *.localhost name a site of its own", () => {
    const portless = route("https://thema.localhost:1355/");
    expect(previewUrl("https://thema.localhost:1355/app", portless)).toBe(`${PREVIEW}/app`);
    expect(previewUrl("https://api.thema.localhost:1355/v1", portless)).toBe(
      `${PREVIEW}/__localdot/to/https/api.thema.localhost/1355/v1`,
    );
  });

  it("leaves what isn't a listening server in the computer alone", () => {
    for (const address of [
      "http://localhost:9999/",
      "https://accounts.example/auth?redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Fcb",
      "http://192.168.1.4:5173/",
      "http://user:pass@localhost:5173/",
      "ftp://localhost:5173/",
      "/relative",
    ])
      expect(previewUrl(address, route()), address).toBe(address);
  });

  it("rewrites redirects, refreshes, preload links and a page policy's sources", () => {
    expect(deviceHeader("location", "http://localhost:5173/home", route())).toBe(`${PREVIEW}/home`);
    expect(deviceHeader("refresh", "0; url=http://127.0.0.1:5173/next", route())).toBe(
      `0; url=${PREVIEW}/next`,
    );
    expect(
      deviceHeader(
        "link",
        "<http://localhost:5173/app.css>; rel=preload, <https://cdn.example/x.js>; rel=preload",
        route(),
      ),
    ).toBe(`<${PREVIEW}/app.css>; rel=preload, <https://cdn.example/x.js>; rel=preload`);
    expect(
      deviceHeader(
        "content-security-policy",
        "default-src 'self'; connect-src 'self' ws://localhost:5173 http://localhost:3000",
        route(),
      ),
    ).toBe(`default-src 'self'; connect-src 'self' wss://${FRONT} https://${FRONT}`);
    expect(deviceHeader("x-other", "http://localhost:5173/", route())).toBe(
      "http://localhost:5173/",
    );
  });

  it("keeps a root-relative redirect from a server on the via path on that path", () => {
    const via = route("http://localhost:5173/", "/__localdot/to/http/localhost/3000");
    expect(deviceHeader("location", "/login", via)).toBe(
      "/__localdot/to/http/localhost/3000/login",
    );
    expect(deviceHeader("location", "//cdn.example/x", via)).toBe("//cdn.example/x");
    expect(deviceHeader("location", "http://localhost:5173/", via)).toBe(`${PREVIEW}/`);
  });
});

describe("addresses in a body", () => {
  it("rewrites links, scripts and requests in HTML, JS, CSS and JSON", () => {
    expect(
      rewriteText(
        `<a href="http://localhost:5173/about">About</a><script src="http://127.0.0.1:5173/main.js"></script>`,
        route(),
      ),
    ).toBe(`<a href="${PREVIEW}/about">About</a><script src="${PREVIEW}/main.js"></script>`);
    expect(rewriteText(`fetch("http://localhost:3000/api/items")`, route())).toBe(
      `fetch("${PREVIEW}/__localdot/to/http/localhost/3000/api/items")`,
    );
    expect(rewriteText(`new WebSocket("ws://localhost:3000/socket")`, route())).toBe(
      `new WebSocket("wss://${FRONT}/__localdot/to/http/localhost/3000/socket")`,
    );
    expect(rewriteText(`url(http://localhost:5173/bg.png)`, route())).toBe(
      `url(${PREVIEW}/bg.png)`,
    );
    expect(rewriteText(`{"next":"http:\\/\\/localhost:3000\\/page"}`, route())).toBe(
      `{"next":"https:\\/\\/${FRONT}\\/__localdot\\/to\\/http\\/localhost\\/3000\\/page"}`,
    );
    expect(rewriteText(`<script src="//localhost:5173/livereload.js"></script>`, route())).toBe(
      `<script src="//${FRONT}/livereload.js"></script>`,
    );
  });

  it("leaves addresses that aren't the computer's servers, and a loopback name with no port", () => {
    for (const body of [
      `new URL(path, "http://localhost")`,
      `"http://localhost:9999/"`,
      `"http://localhost.evil.example:5173/"`,
      `"http://localhost:51730/"`,
      `"https://example.com/?u=http%3A%2F%2Flocalhost%3A5173"`,
      "// localhost:5173 is the dev server",
      "a//localhost:5173",
    ])
      expect(rewriteText(body, route()), body).toBe(body);
  });

  it("rewrites the same across any split of the body into chunks", async () => {
    const body = `<a href="http://localhost:5173/a">x</a> "http:\\/\\/localhost:3000\\/b" ws://127.0.0.1:5173/ws http://localhost:51730/`;
    const whole = rewriteText(body, route());
    for (let at = 0; at <= body.length; at++) {
      const rewriter = new TextRewriter(route());
      const out = text(
        Readable.from(
          [body.slice(0, at), body.slice(at)].map((part) => Buffer.from(part, "latin1")),
        ).pipe(rewriter),
      );
      expect(await out, `split at ${at}`).toBe(whole);
    }
  });

  it("holds back only what may still become an address", () => {
    expect(pendingFrom("<p>done</p></script>")).toBe(20);
    expect(pendingFrom("path")).toBe(4);
    const tail = `<a href="http://localh`;
    expect(pendingFrom(tail)).toBe(tail.indexOf("http"));
    expect(pendingFrom(`x http://localhost:5173`)).toBe(2);
    expect(pendingFrom(`x http://localhost:5173/`)).toBe(24);
    expect(pendingFrom("src=/")).toBe(4);
    expect(pendingFrom("a ws")).toBe(2);
  });

  it("keeps bytes that aren't ASCII as they were", async () => {
    const body = Buffer.concat([
      Buffer.from("héllo → "),
      Buffer.from("http://localhost:5173/x "),
      Buffer.from([0xff, 0xfe, 0x00]),
    ]);
    const parts: Buffer[] = [];
    const rewriter = new TextRewriter(route());
    rewriter.on("data", (chunk: Buffer) => parts.push(chunk));
    rewriter.end(body);
    await new Promise((resolve) => rewriter.on("end", resolve));
    expect(Buffer.concat(parts)).toEqual(
      Buffer.concat([
        Buffer.from("héllo → "),
        Buffer.from(`${PREVIEW}/x `),
        Buffer.from([0xff, 0xfe, 0x00]),
      ]),
    );
  });
});

describe("which bodies are rewritten", () => {
  const head = (type: string, more: Record<string, string> = {}) => ({
    "content-type": type,
    ...more,
  });

  it("rewrites pages, scripts, styles and JSON, decoding what the server compressed", () => {
    for (const type of [
      "text/html; charset=utf-8",
      "text/javascript",
      "application/javascript",
      "text/css",
      "application/json",
      "application/manifest+json",
      "application/ld+json",
      "image/svg+xml",
    ])
      expect(bodyRewrite("GET", 200, head(type)), type).toEqual({});
    for (const encoding of ["gzip", "br", "zstd"])
      expect(
        bodyRewrite("GET", 200, head("text/html", { "content-encoding": encoding }))?.decode,
        encoding,
      ).toBeTypeOf("function");
  });

  it("passes everything else through untouched", () => {
    expect(bodyRewrite("GET", 200, head("text/event-stream"))).toBeUndefined();
    expect(bodyRewrite("GET", 200, head("image/png"))).toBeUndefined();
    expect(bodyRewrite("GET", 200, head("application/octet-stream"))).toBeUndefined();
    expect(bodyRewrite("GET", 200, head("text/plain"))).toBeUndefined();
    expect(bodyRewrite("GET", 200, head("text/html; charset=utf-16"))).toBeUndefined();
    expect(
      bodyRewrite("GET", 200, head("text/html", { "content-encoding": "compress" })),
    ).toBeUndefined();
    expect(bodyRewrite("GET", 206, head("text/html"))).toBeUndefined();
    expect(
      bodyRewrite("GET", 200, head("text/html", { "content-range": "bytes 0-9/99" })),
    ).toBeUndefined();
    expect(bodyRewrite("HEAD", 200, head("text/html"))).toBeUndefined();
    expect(bodyRewrite("GET", 304, head("text/html"))).toBeUndefined();
  });
});

describe("a server's cookies", () => {
  it("are kept on the preview's host when they name the computer", () => {
    expect(deviceCookie("sid=1; Domain=localhost; Path=/; HttpOnly", computer)).toBe(
      "sid=1; Path=/; HttpOnly",
    );
    expect(deviceCookie("sid=1; domain=.app.localhost; Path=/", computer)).toBe("sid=1; Path=/");
    expect(deviceCookie("sid=1; Domain=172.20.0.11", computer)).toBe("sid=1");
    expect(deviceCookie("sid=1; Domain=example.com", computer)).toBe("sid=1; Domain=example.com");
  });

  it("are Secure when they're meant for cross-site use", () => {
    expect(deviceCookie("sid=1; SameSite=None", computer)).toBe("sid=1; SameSite=None; Secure");
    expect(deviceCookie("sid=1; SameSite=None; Secure", computer)).toBe(
      "sid=1; SameSite=None; Secure",
    );
    expect(deviceCookie("sid=1; SameSite=Lax", computer)).toBe("sid=1; SameSite=Lax");
  });
});

describe("the via path", () => {
  it("names a server, the path to ask it for and its own prefix", () => {
    expect(viaOf("/__localdot/to/http/localhost/3000/api/x?y=1")).toEqual({
      address: "http://localhost:3000/api/x?y=1",
      prefix: "/__localdot/to/http/localhost/3000",
    });
    expect(viaOf("/__localdot/to/https/[::1]/8443")).toEqual({
      address: "https://[::1]:8443/",
      prefix: "/__localdot/to/https/[::1]/8443",
    });
    for (const url of [
      "/__localdot/to/ftp/localhost/21/",
      "/__localdot/to/http/localhost/99999/",
      "/__localdot/to/http/evil.example@localhost/80/",
      "/__localdot/to/http/localhost/",
    ])
      expect(viaOf(url), url).toBeUndefined();
  });
});
