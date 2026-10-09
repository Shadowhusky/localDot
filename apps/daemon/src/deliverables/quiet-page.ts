import { type DefaultTreeAdapterTypes as Html, parse, serialize } from "parse5";
import { maskText } from "./excerpt.ts";

// A frame with no script parses as the browser does with scripting off: <noscript> holds markup.
const OPTIONS = { scriptingEnabled: false } as const;
// Browsers stop nesting at 512 levels and would then read the page differently from here.
const DEPTH = 256;
const XLINK = "http://www.w3.org/1999/xlink";

function opensOrReports(attr: Html.Element["attrs"][number]): boolean {
  if (attr.namespace === XLINK) return attr.name === "show";
  return attr.name === "target" || attr.name === "formtarget" || attr.name === "ping";
}

function stylesheet(link: Html.Element): boolean {
  const rel = link.attrs.find((attr) => attr.name === "rel" && !attr.namespace)?.value ?? "";
  const kinds = rel
    .toLowerCase()
    .split(/[\t\n\f\r ]+/)
    .filter(Boolean);
  return kinds.length === 1 && kinds[0] === "stylesheet";
}

// Takes out what reaches a server before the page's policy applies in WebKit: a <link> that is not
// a stylesheet (preconnect, prefetch, preload, prerender…), and where a link opens or reports a
// click. Counts what it took out; past the depth it can check, Infinity.
function quiet(node: Html.ParentNode, depth: number): number {
  if (depth > DEPTH) return Number.POSITIVE_INFINITY;
  let found = 0;
  const kept: Html.ChildNode[] = [];
  for (const child of node.childNodes) {
    if (!("tagName" in child)) {
      kept.push(child);
      continue;
    }
    if (child.tagName === "link" && !stylesheet(child)) {
      found++;
      continue;
    }
    const attrs = child.attrs.filter((attr) => !opensOrReports(attr));
    found += child.attrs.length - attrs.length;
    child.attrs = attrs;
    found += quiet(child, depth + 1);
    if ("content" in child) found += quiet(child.content, depth + 1);
    kept.push(child);
  }
  node.childNodes = kept;
  return found;
}

// A page dot made as the preview serves it: quieted, keys masked, then read once more as the
// browser will read it, so neither the masking nor writing it out again brings anything back.
// Undefined when it cannot be served that way.
export function quietPage(html: string): string | undefined {
  const page = parse(html, OPTIONS);
  if (quiet(page, 0) === Number.POSITIVE_INFINITY) return undefined;
  const served = maskText(serialize(page, OPTIONS));
  return quiet(parse(served, OPTIONS), 0) === 0 ? served : undefined;
}
