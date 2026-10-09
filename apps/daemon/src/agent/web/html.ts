import {
  type DefaultTreeAdapterMap,
  defaultTreeAdapter,
  type DefaultTreeAdapterTypes as Html,
  parse,
  type TreeAdapter,
} from "parse5";

export type Element = Html.Element;
export type Parent = Html.ParentNode;

// Pages nest deeper than the deliverables' previews, but every walk here recurses, so a page that
// nests past this, or builds far more elements than its size could write, is not read.
const DEPTH = 256;
const SKIPPED = new Set(["script", "style", "noscript", "template", "svg", "math", "head"]);

class TooMuch extends Error {}

export function parseHtml(html: string): Html.Document | undefined {
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
    return parse(html, { scriptingEnabled: false, treeAdapter });
  } catch (error) {
    if (error instanceof TooMuch) return undefined;
    throw error;
  }
}

export const isElement = (node: Html.ChildNode | Html.ParentNode): node is Element =>
  "tagName" in node;

export function attr(element: Element, name: string): string | undefined {
  return element.attrs.find((a) => a.name === name && !a.namespace)?.value;
}

export function classes(element: Element): string[] {
  return (attr(element, "class") ?? "").split(/\s+/).filter(Boolean);
}

export const hasClass = (element: Element, name: string) => classes(element).includes(name);

function childrenOf(node: Parent): Html.ChildNode[] {
  return node.childNodes;
}

// Every element under root that matches, in document order; a match's own descendants too.
export function findAll(root: Parent, match: (element: Element) => boolean): Element[] {
  const found: Element[] = [];
  const walk = (node: Parent) => {
    for (const child of childrenOf(node)) {
      if (!isElement(child)) continue;
      if (match(child)) found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

export function find(root: Parent, match: (element: Element) => boolean): Element | undefined {
  for (const child of childrenOf(root)) {
    if (!isElement(child)) continue;
    if (match(child)) return child;
    const inner = find(child, match);
    if (inner) return inner;
  }
  return undefined;
}

export const byClass = (name: string) => (element: Element) => hasClass(element, name);
export const byTag = (tag: string) => (element: Element) => element.tagName === tag;

// The text a reader sees, on one line.
export function textOf(node: Parent | undefined): string {
  if (!node) return "";
  let out = "";
  const walk = (parent: Parent) => {
    for (const child of childrenOf(parent)) {
      if (child.nodeName === "#text") out += (child as Html.TextNode).value;
      else if (isElement(child) && !SKIPPED.has(child.tagName)) {
        if (child.tagName === "br") out += " ";
        walk(child);
      }
    }
  };
  walk(node);
  return clean(out);
}

export function clean(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// An address as written on a page, made absolute; only http and https ones.
export function absolute(href: string | undefined, base: string | URL): URL | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href.trim(), base);
    return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export const SKIPPED_TAGS: ReadonlySet<string> = SKIPPED;

// A response's text in the charset it declares, in its header or its markup; UTF-8 otherwise.
export function decodeText(body: Buffer, contentType: string): string {
  const declared =
    /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(body.subarray(0, 2048).toString("latin1"))?.[1];
  try {
    return new TextDecoder(declared ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}
