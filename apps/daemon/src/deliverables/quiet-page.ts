import {
  type DefaultTreeAdapterMap,
  defaultTreeAdapter,
  type DefaultTreeAdapterTypes as Html,
  parse,
  serialize,
  type TreeAdapter,
} from "parse5";
import { maskText } from "./excerpt.ts";

// A frame with no script parses as the browser does with scripting off: <noscript> holds markup.
const OPTIONS = { scriptingEnabled: false } as const;
// Browsers stop nesting at 512 levels and would then read the page differently from here, and
// parse5 scans the open elements on many tags, so a page costs more the deeper it may go.
const DEPTH = 128;
const XLINK = "http://www.w3.org/1999/xlink";
// Each holds a page of its own, which nothing here reads: WebKit acts on the hints in a srcdoc
// before the policy applies. The policy loads none of them anyway.
const FRAMES = new Set(["iframe", "frame", "object", "embed"]);

class TooMuch extends Error {}

// Reading stops once the page nests deeper than can be checked, as parsing slows with every level,
// or builds more elements than it could be written with: formatting left open in one paragraph is
// made again in every paragraph after it. A tag takes three bytes at least.
function read(html: string): Html.Document | undefined {
  let open = 0;
  let made = 0;
  const most = html.length / 3 + 16;
  const treeAdapter: TreeAdapter<DefaultTreeAdapterMap> = {
    ...defaultTreeAdapter,
    createElement: (tagName, namespaceURI, attrs) => {
      if (++made > most) throw new TooMuch();
      return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
    },
    onItemPush: () => {
      if (++open > DEPTH) throw new TooMuch();
    },
    onItemPop: () => {
      open--;
    },
  };
  try {
    return parse(html, { ...OPTIONS, treeAdapter });
  } catch (error) {
    if (error instanceof TooMuch) return undefined;
    throw error;
  }
}

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
// a stylesheet (preconnect, prefetch, preload, prerender…), a frame, object or embed, and where a
// link opens or reports a click. Counts what it took out; past the depth it can check, Infinity.
function quiet(node: Html.ParentNode, depth: number): number {
  if (depth > DEPTH) return Number.POSITIVE_INFINITY;
  let found = 0;
  const kept: Html.ChildNode[] = [];
  for (const child of node.childNodes) {
    if (!("tagName" in child)) {
      kept.push(child);
      continue;
    }
    if ((child.tagName === "link" && !stylesheet(child)) || FRAMES.has(child.tagName)) {
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
// Undefined when it cannot be served that way. The first tree is let go before the second is
// built, which halves the heap a page needs.
export function quietPage(html: string): string | undefined {
  const served = quieted(html);
  const again = served === undefined ? undefined : read(served);
  return again && quiet(again, 0) === 0 ? served : undefined;
}

function quieted(html: string): string | undefined {
  const page = read(html);
  if (!page || quiet(page, 0) === Number.POSITIVE_INFINITY) return undefined;
  return maskText(serialize(page, OPTIONS));
}
