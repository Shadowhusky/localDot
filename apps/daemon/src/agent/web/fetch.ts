import { type WebAccess, WebError } from "./cell.ts";
import { looksLikeChallenge } from "./engines.ts";
import { decodeText } from "./html.ts";
import { toJpeg } from "./picture.ts";
import { plainText, readable } from "./readable.ts";

const PAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_BYTES = 15 * 1024 * 1024;
const IMAGE_SIDE = 1024;
// A page this short that is a check for robots holds nothing else.
const CHALLENGE_CHARS = 1500;

export type Fetched =
  | {
      readonly kind: "page";
      readonly url: string;
      readonly title: string;
      readonly text: string;
      readonly truncated: boolean;
    }
  | {
      readonly kind: "image";
      readonly url: string;
      readonly data: Buffer;
      readonly width: number;
      readonly height: number;
    };

const TEXT = /^(?:text\/|application\/(?:json|ld\+json|xml|rss\+xml|atom\+xml|javascript))/;

// A page's readable text, or a picture: whatever the address holds, read through the web cell.
export async function webFetch(
  web: WebAccess,
  url: URL,
  maxChars: number,
  signal: AbortSignal,
): Promise<Fetched> {
  const reply = await web.get(url, {
    signal,
    accept:
      "text/html,application/xhtml+xml,text/plain;q=0.9,image/webp,image/png,image/jpeg;q=0.8,*/*;q=0.5",
    maxBytes: IMAGE_BYTES,
  });
  if (reply.status >= 400) throw new WebError(`The site answered ${reply.status}.`);
  const type = reply.contentType.split(";")[0]?.trim() ?? "";
  if (type.startsWith("image/")) {
    if (reply.truncated) throw new WebError("The picture is too large to look at.");
    const picture = await toJpeg(reply.body, IMAGE_SIDE).catch(() => {
      throw new WebError("The picture could not be read.");
    });
    return { kind: "image", url: reply.url.href, ...picture };
  }
  if (type === "application/pdf")
    throw new WebError(
      "This link is a PDF: in research mode read it with research op pdf; otherwise download it in the computer with the shell and read it there.",
    );
  const body = reply.body.subarray(0, PAGE_BYTES);
  const text = decodeText(body, reply.contentType);
  const html =
    type === "text/html" ||
    type === "application/xhtml+xml" ||
    (!type && /<html|<!doctype html/i.test(text.slice(0, 1024)));
  if (html) {
    const page = readable(text, reply.url.href, maxChars);
    if (!page) throw new WebError("The page could not be read.");
    if (page.text.length < CHALLENGE_CHARS && looksLikeChallenge(text))
      throw new WebError(
        "The site showed a check for robots instead of the page. Open it with browser_navigate instead.",
      );
    return {
      kind: "page",
      url: reply.url.href,
      title: page.title,
      text: page.text,
      truncated: page.truncated || reply.truncated || body.length < reply.body.length,
    };
  }
  if (TEXT.test(type)) {
    const plain = plainText(text, maxChars);
    return { kind: "page", url: reply.url.href, title: "", ...plain };
  }
  throw new WebError(
    `This link is a ${type || "file of an unknown kind"}, not a page or a picture: download it in the computer with the shell instead.`,
  );
}
