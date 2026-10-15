import {
  WEB_SEARCH_DEFAULT_COUNT,
  WEB_SEARCH_PICTURES,
  type WebSearchInput,
  type WebSearchKind,
} from "@localdot/protocol";
import { type WebAccess, WebError } from "./cell.ts";
import { ENGINES, type Engine, SearchBlocked, type SearchHit, thumbnailUrl } from "./engines.ts";
import { decodeText } from "./html.ts";
import { toJpeg } from "./picture.ts";

const PAGE_BYTES = 3 * 1024 * 1024;
const PICTURE_BYTES = 4 * 1024 * 1024;
const PICTURE_SIDE = 512;
// A few more pictures are asked for than shown, so one that fails is made up for.
const PICTURE_TRIES = WEB_SEARCH_PICTURES + 2;

export interface ResultPicture {
  // The result it belongs to, numbered from 1.
  readonly n: number;
  readonly url: string;
  readonly data: Buffer;
}
export interface SearchOutcome {
  readonly hits: SearchHit[];
  readonly pictures: ResultPicture[];
  // Why the engines that gave nothing gave nothing, for dot.
  readonly problems: string[];
}

class NoResults extends Error {}

function why(error: unknown): string {
  if (error instanceof SearchBlocked) return "showed a check for robots (a CAPTCHA)";
  if (error instanceof NoResults || error instanceof WebError) return error.message;
  return "could not be reached";
}

async function ask(
  web: WebAccess,
  engine: Engine,
  query: string,
  signal: AbortSignal,
): Promise<SearchHit[]> {
  const reply = await web.get(engine.address(query), {
    signal,
    accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    maxBytes: PAGE_BYTES,
  });
  if (reply.status !== 200) throw new NoResults(`answered ${reply.status}`);
  const found = engine.read(decodeText(reply.body, reply.contentType));
  if (!found.length) throw new NoResults("found nothing");
  return found;
}

// Results from the first engine that answers, filled in from the next while there are too few;
// for images, the first results' pictures as well.
export async function webSearch(
  web: WebAccess,
  input: WebSearchInput,
  signal: AbortSignal,
  engines: Readonly<Record<WebSearchKind, readonly Engine[]>> = ENGINES,
): Promise<SearchOutcome> {
  const kind = input.kind ?? "web";
  const want = input.count ?? WEB_SEARCH_DEFAULT_COUNT;
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const engine of engines[kind]) {
    if (hits.length >= want) break;
    let found: SearchHit[];
    try {
      found = await ask(web, engine, input.query, signal);
    } catch (error) {
      signal.throwIfAborted();
      problems.push(`${engine.host} ${why(error)}`);
      continue;
    }
    for (const hit of found) {
      const key = hit.url.replace(/#.*$/, "").replace(/\/$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(hit);
    }
  }
  const kept = hits.slice(0, want);
  return {
    hits: kept,
    pictures: kind === "images" ? await picturesOf(web, kept, signal) : [],
    problems,
  };
}

async function picturesOf(
  web: WebAccess,
  hits: readonly SearchHit[],
  signal: AbortSignal,
): Promise<ResultPicture[]> {
  const tries = hits
    .flatMap((hit, i) => {
      const url = thumbnailUrl(hit.thumbnail);
      return url ? [{ n: i + 1, url }] : [];
    })
    .slice(0, PICTURE_TRIES);
  const got = await Promise.all(
    tries.map(async ({ n, url }) => {
      try {
        const reply = await web.get(url, {
          signal,
          accept: "image/webp,image/png,image/jpeg",
          maxBytes: PICTURE_BYTES,
        });
        if (reply.status !== 200 || reply.truncated || !reply.contentType.startsWith("image/"))
          return undefined;
        return { n, url: url.href, data: (await toJpeg(reply.body, PICTURE_SIDE)).data };
      } catch {
        signal.throwIfAborted();
        return undefined;
      }
    }),
  );
  return got
    .filter((picture): picture is ResultPicture => picture !== undefined)
    .slice(0, WEB_SEARCH_PICTURES);
}
