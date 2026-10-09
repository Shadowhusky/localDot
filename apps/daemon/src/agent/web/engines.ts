import type { WebSearchKind } from "@localdot/protocol";
import { siteOf } from "../research.ts";
import {
  absolute,
  attr,
  byClass,
  byTag,
  clean,
  type Element,
  find,
  findAll,
  hasClass,
  isElement,
  parseHtml,
  textOf,
} from "./html.ts";

export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly site: string;
  readonly snippet?: string;
  // images: the picture itself, and the engine's small copy of it.
  readonly image?: string;
  readonly thumbnail?: string;
  // news: who published it and when.
  readonly source?: string;
  readonly age?: string;
}

// A results page that is a CAPTCHA or another check for robots instead of results.
export class SearchBlocked extends Error {
  constructor() {
    super("the search engine asked for a CAPTCHA");
    this.name = "SearchBlocked";
  }
}

export interface Engine {
  readonly host: string;
  address(query: string): URL;
  read(body: string): SearchHit[];
}

const CHALLENGE =
  /captcha|anomaly-modal|anomaly\.js|bots use duckduckgo|challenge-form|cf-challenge|verify (?:that )?you are (?:a )?human|are you a robot|unusual traffic|botnet_challenge/i;
const TITLE = /<title[^>]*>([^<]*)<\/title>/i;

// A page that is a check for robots says so, in its title or its markup.
export function looksLikeChallenge(body: string): boolean {
  return CHALLENGE.test(TITLE.exec(body)?.[1] ?? "") || CHALLENGE.test(body);
}

// A results page with no results may be such a check.
function noneOrBlocked(body: string, hits: SearchHit[]): SearchHit[] {
  if (hits.length) return hits;
  if (looksLikeChallenge(body)) throw new SearchBlocked();
  return [];
}

function hit(fields: {
  title: string;
  url: URL | undefined;
  snippet?: string;
  image?: URL | undefined;
  thumbnail?: URL | undefined;
  source?: string;
  age?: string;
}): SearchHit | undefined {
  const title = clean(fields.title).slice(0, 300);
  if (!fields.url || !title) return undefined;
  const snippet = clean(fields.snippet ?? "").slice(0, 500);
  const source = clean(fields.source ?? "").slice(0, 100);
  const age = clean(fields.age ?? "").slice(0, 40);
  return {
    title,
    url: fields.url.href,
    site: siteOf(fields.url.href),
    ...(snippet ? { snippet } : {}),
    ...(fields.image ? { image: fields.image.href } : {}),
    ...(fields.thumbnail ? { thumbnail: fields.thumbnail.href } : {}),
    ...(source ? { source } : {}),
    ...(age ? { age } : {}),
  };
}

const present = <T>(value: T | undefined): value is T => value !== undefined;

// DuckDuckGo's page for browsers without scripts links each result through its redirect, which
// carries the address in uddg. Ads go through its ad redirect instead and are left out.
function duckLink(href: string | undefined): URL | undefined {
  const link = absolute(href, "https://html.duckduckgo.com/");
  if (!link) return undefined;
  const target = link.hostname.endsWith("duckduckgo.com") ? link.searchParams.get("uddg") : null;
  const url = target ? absolute(target, "https://duckduckgo.com/") : link;
  if (!url || url.hostname.endsWith("duckduckgo.com")) return undefined;
  return url;
}

export const duckDuckGo: Engine = {
  host: "html.duckduckgo.com",
  address: (query) => {
    const url = new URL("https://html.duckduckgo.com/html/");
    url.searchParams.set("q", query);
    return url;
  },
  read(body) {
    const page = parseHtml(body);
    if (!page) return [];
    const hits = findAll(page, (e) => hasClass(e, "result") && !hasClass(e, "result--ad"))
      .map((result) => {
        const link = find(result, byClass("result__a"));
        return link
          ? hit({
              title: textOf(link),
              url: duckLink(attr(link, "href")),
              snippet: textOf(find(result, byClass("result__snippet"))),
            })
          : undefined;
      })
      .filter(present);
    return noneOrBlocked(body, hits);
  },
};

// Bing links each result through /ck/a, whose u holds "a1" and the address in URL-safe base64.
function bingLink(href: string | undefined): URL | undefined {
  const link = absolute(href, "https://www.bing.com/");
  if (!link) return undefined;
  if (!/(?:^|\.)bing\.com$/.test(link.hostname)) return link;
  const coded = link.searchParams.get("u");
  if (!coded?.startsWith("a1")) return undefined;
  const url = absolute(Buffer.from(coded.slice(2), "base64url").toString("utf8"), link);
  return url && !/(?:^|\.)bing\.com$/.test(url.hostname) ? url : undefined;
}

export const bing: Engine = {
  host: "www.bing.com",
  address: (query) => {
    const url = new URL("https://www.bing.com/search");
    url.searchParams.set("q", query);
    return url;
  },
  read(body) {
    const page = parseHtml(body);
    if (!page) return [];
    const hits = findAll(page, byClass("b_algo"))
      .map((result) => {
        const heading = find(result, (e) => /^h[23]$/.test(e.tagName));
        const link = heading && find(heading, byTag("a"));
        const caption = find(result, byClass("b_caption"));
        return link
          ? hit({
              title: textOf(link),
              url: bingLink(attr(link, "href")),
              snippet: textOf(caption ? (find(caption, byTag("p")) ?? caption) : undefined),
            })
          : undefined;
      })
      .filter(present);
    return noneOrBlocked(body, hits);
  },
};

const tileOf = (raw: string | undefined) => {
  try {
    const value = JSON.parse(raw ?? "") as Record<string, unknown>;
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
};
const text = (value: unknown) => (typeof value === "string" ? value : undefined);

export const bingImages: Engine = {
  host: "www.bing.com",
  address: (query) => {
    const url = new URL("https://www.bing.com/images/search");
    url.searchParams.set("q", query);
    return url;
  },
  read(body) {
    const page = parseHtml(body);
    if (!page) return [];
    const hits = findAll(page, byClass("iusc"))
      .map((tile) => {
        const m = tileOf(attr(tile, "m"));
        if (!m) return undefined;
        return hit({
          title: text(m.t) ?? text(m.desc) ?? "",
          url: absolute(text(m.purl), "https://www.bing.com/"),
          image: absolute(text(m.murl), "https://www.bing.com/"),
          thumbnail: absolute(text(m.turl), "https://www.bing.com/"),
        });
      })
      .filter(present);
    return noneOrBlocked(body, hits);
  },
};

// Wikimedia Commons' open API: freely licensed pictures, with their own thumbnails.
export const commonsImages: Engine = {
  host: "commons.wikimedia.org",
  address: (query) => {
    const url = new URL("https://commons.wikimedia.org/w/api.php");
    url.search = new URLSearchParams({
      action: "query",
      format: "json",
      generator: "search",
      gsrnamespace: "6",
      gsrlimit: "20",
      gsrsearch: query,
      prop: "imageinfo",
      iiprop: "url|mime",
      iiurlwidth: "512",
    }).toString();
    return url;
  },
  read(body) {
    let pages: unknown;
    try {
      pages = (JSON.parse(body) as { query?: { pages?: unknown } }).query?.pages;
    } catch {
      return noneOrBlocked(body, []);
    }
    if (!pages || typeof pages !== "object") return noneOrBlocked(body, []);
    return Object.values(pages as Record<string, Record<string, unknown>>)
      .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
      .map((page) => {
        const info = (Array.isArray(page.imageinfo) ? page.imageinfo[0] : undefined) as
          | Record<string, unknown>
          | undefined;
        if (!info || !text(info.mime)?.startsWith("image/")) return undefined;
        return hit({
          title: (text(page.title) ?? "").replace(/^File:/, "").replace(/\.[a-z0-9]{2,5}$/i, ""),
          url: absolute(text(info.descriptionurl), "https://commons.wikimedia.org/"),
          image: absolute(text(info.url), "https://commons.wikimedia.org/"),
          thumbnail: absolute(text(info.thumburl), "https://commons.wikimedia.org/"),
        });
      })
      .filter(present);
  },
};

// "2 days ago" is the label of what holds the short "2d".
function newsAge(card: Element): string {
  const time = find(card, byClass("ns_sc_tm"));
  if (!time) return "";
  const holder = time.parentNode;
  return (holder && isElement(holder) && attr(holder, "aria-label")) || textOf(time);
}

export const bingNews: Engine = {
  host: "www.bing.com",
  address: (query) => {
    const url = new URL("https://www.bing.com/news/search");
    url.searchParams.set("q", query);
    return url;
  },
  read(body) {
    const page = parseHtml(body);
    if (!page) return [];
    const hits = findAll(page, byClass("news-card"))
      .map((card) => {
        const link = find(card, byClass("title"));
        return hit({
          title: attr(card, "data-title") ?? textOf(link),
          url: absolute(
            attr(card, "url") ?? attr(card, "data-url") ?? attr(link ?? card, "href"),
            "https://www.bing.com/",
          ),
          snippet: textOf(find(card, byClass("snippet"))),
          source: attr(card, "data-author") ?? "",
          age: newsAge(card),
        });
      })
      .filter(present);
    return noneOrBlocked(body, hits);
  },
};

// Yahoo links each result through its redirect, which carries the address as its RU segment.
function yahooLink(href: string | undefined): URL | undefined {
  const link = absolute(href, "https://news.search.yahoo.com/");
  if (!link) return undefined;
  if (!link.hostname.endsWith("yahoo.com")) return link;
  const coded = /\/RU=([^/]+)\//.exec(link.pathname)?.[1];
  if (!coded) return undefined;
  try {
    return absolute(decodeURIComponent(coded), link);
  } catch {
    return undefined;
  }
}

export const yahooNews: Engine = {
  host: "news.search.yahoo.com",
  address: (query) => {
    const url = new URL("https://news.search.yahoo.com/search");
    url.searchParams.set("p", query);
    return url;
  },
  read(body) {
    const page = parseHtml(body);
    if (!page) return [];
    const hits = findAll(page, byClass("NewsArticle"))
      .flatMap((article) => findAll(article, byTag("li")))
      .map((item) => {
        const heading = find(item, byClass("s-title"));
        const link = heading && find(heading, byTag("a"));
        return link
          ? hit({
              title: textOf(link),
              url: yahooLink(attr(link, "href")),
              snippet: textOf(find(item, byClass("s-desc"))),
              source: textOf(find(item, byClass("s-source"))),
              age: textOf(find(item, byClass("s-time"))).replace(/^·\s*/, ""),
            })
          : undefined;
      })
      .filter(present);
    return noneOrBlocked(body, hits);
  },
};

// Keyless engines, in the order they are tried: the next one fills in when one fails, shows a
// check for robots or has too few results.
export const ENGINES: Readonly<Record<WebSearchKind, readonly Engine[]>> = {
  web: [duckDuckGo, bing],
  images: [bingImages, commonsImages],
  news: [bingNews, yahooNews],
};

// Every address a search may open, for the safety checks: each carries the query.
export function searchAddresses(query: string, kind: WebSearchKind = "web"): URL[] {
  return ENGINES[kind].map((engine) => engine.address(query));
}

// Where an image search's own small copies of pictures are kept: the only hosts its pictures are
// fetched from, since those addresses come from the engine, never from what dot read.
const THUMBNAIL_HOST =
  /^(?:th\.bing\.com|ts\d*\.mm\.bing\.net|tse\d*\.mm\.bing\.net|upload\.wikimedia\.org|thumb\.wikimedia\.org)$/;

export function thumbnailUrl(raw: string | undefined): URL | undefined {
  const url = absolute(raw, "https://www.bing.com/");
  return url?.protocol === "https:" && THUMBNAIL_HOST.test(url.hostname) ? url : undefined;
}
