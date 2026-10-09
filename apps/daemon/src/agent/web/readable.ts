import {
  absolute,
  attr,
  byTag,
  clean,
  type Element,
  find,
  findAll,
  isElement,
  type Parent,
  parseHtml,
  SKIPPED_TAGS,
  textOf,
} from "./html.ts";

export interface ReadablePage {
  readonly title: string;
  readonly text: string;
  readonly truncated: boolean;
}

// What surrounds an article rather than being it: the site's menus, sidebars, footers, forms and
// anything hidden.
const AROUND = new Set([
  ...SKIPPED_TAGS,
  "nav",
  "footer",
  "aside",
  "form",
  "button",
  "input",
  "select",
  "textarea",
  "iframe",
  "canvas",
  "video",
  "audio",
  "object",
  "embed",
  "dialog",
]);
const AROUND_ROLES = new Set([
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "search",
  "dialog",
  "menu",
  "menubar",
]);
const AROUND_NAMES =
  /(?:^|[-_\s])(?:nav|navbar|navigation|menu|footer|sidebar|breadcrumbs?|cookies?|consent|advert|advertisement|ads|promo|share|social|newsletter|subscribe|popup|modal|skip-link|noprint|editsection)(?:[-_\s]|$)/i;
const BLOCKS = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "header",
  "figure",
  "figcaption",
  "details",
  "summary",
  "dl",
  "dt",
  "dd",
  "address",
  "center",
]);
const HEADING = /^h([1-6])$/;
const MAX_LINKS = 30;
const MAX_IMAGES = 20;
const MAX_CELL = 300;

function around(element: Element): boolean {
  if (AROUND.has(element.tagName)) return true;
  if (attr(element, "hidden") !== undefined || attr(element, "aria-hidden") === "true") return true;
  const role = attr(element, "role");
  if (role && AROUND_ROLES.has(role)) return true;
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(attr(element, "style") ?? "")) return true;
  return (
    AROUND_NAMES.test(attr(element, "class") ?? "") || AROUND_NAMES.test(attr(element, "id") ?? "")
  );
}

// The article itself: the page's main element, else its longest article, else its body.
function mainOf(page: Parent): Parent {
  const main = find(page, (e) => e.tagName === "main" || attr(e, "role") === "main");
  if (main && textOf(main).length >= 200) return main;
  const article = findAll(page, byTag("article"))
    .map((element) => ({ element, length: textOf(element).length }))
    .sort((a, b) => b.length - a.length)[0];
  if (article && article.length >= 200) return article.element;
  return find(page, byTag("body")) ?? page;
}

interface Context {
  readonly base: URL;
  readonly links: Map<string, string>;
  images: number;
}

function inline(node: Parent, context: Context): string {
  return clean(render(node, context, 0));
}

function list(element: Element, context: Context, depth: number): string {
  const ordered = element.tagName === "ol";
  let n = 0;
  let out = "";
  for (const child of element.childNodes) {
    if (!isElement(child) || child.tagName !== "li" || around(child)) continue;
    n += 1;
    const nested = child.childNodes.filter(
      (c) => isElement(c) && (c.tagName === "ul" || c.tagName === "ol"),
    );
    const own = { ...child, childNodes: child.childNodes.filter((c) => !nested.includes(c)) };
    const line = inline(own, context);
    if (line) out += `${"  ".repeat(depth)}${ordered ? `${n}.` : "-"} ${line}\n`;
    for (const sub of nested) out += list(sub as Element, context, depth + 1);
  }
  return out;
}

function tableOf(row: Element): Parent | null {
  let node = row.parentNode;
  while (node && isElement(node) && node.tagName !== "table") node = node.parentNode;
  return node;
}

function table(element: Element, context: Context): string {
  const rows = findAll(element, byTag("tr")).filter(
    (row) => tableOf(row) === element && !around(row),
  );
  let out = "\n\n";
  for (const [i, row] of rows.entries()) {
    const cells = row.childNodes.filter(
      (c): c is Element => isElement(c) && (c.tagName === "td" || c.tagName === "th"),
    );
    if (!cells.length) continue;
    out += `| ${cells.map((cell) => cellText(inline(cell, context))).join(" | ")} |\n`;
    if (i === 0 && cells.every((cell) => cell.tagName === "th"))
      out += `|${" --- |".repeat(cells.length)}\n`;
  }
  return `${out}\n`;
}

// A cell within its size, never cut inside a picture's link.
function cellText(text: string): string {
  let kept = text;
  if (kept.length > MAX_CELL) {
    kept = kept.slice(0, MAX_CELL);
    const picture = kept.lastIndexOf("![");
    if (picture >= 0 && !kept.slice(picture).includes(")")) kept = kept.slice(0, picture);
  }
  return kept.trim().replaceAll("|", "/");
}

function image(element: Element, context: Context): string {
  if (context.images >= MAX_IMAGES) return "";
  const width = Number(attr(element, "width"));
  if (Number.isFinite(width) && width > 0 && width < 48) return "";
  const src = absolute(attr(element, "src"), context.base);
  if (!src) return "";
  for (const name of [...src.searchParams.keys()])
    if (name.startsWith("utm_")) src.searchParams.delete(name);
  context.images += 1;
  return ` ![${clean(attr(element, "alt") ?? "").replace(/[[\]]/g, "")}](${src.href}) `;
}

function link(element: Element, context: Context): string {
  const text = textOf(element);
  const href = absolute(attr(element, "href"), context.base);
  const samePage =
    href && href.origin === context.base.origin && href.pathname === context.base.pathname;
  if (text && href && !samePage && context.links.size < MAX_LINKS && !context.links.has(href.href))
    context.links.set(href.href, text.slice(0, 120));
  return render(element, context, 0);
}

function render(node: Parent, context: Context, depth: number): string {
  let out = "";
  for (const child of node.childNodes) {
    if (child.nodeName === "#text") {
      out += (child as { value: string }).value.replace(/\s+/g, " ");
      continue;
    }
    if (!isElement(child) || around(child)) continue;
    const tag = child.tagName;
    const heading = HEADING.exec(tag);
    if (heading) out += `\n\n${"#".repeat(Number(heading[1]))} ${inline(child, context)}\n\n`;
    else if (tag === "br") out += "\n";
    else if (tag === "hr") out += "\n\n---\n\n";
    else if (tag === "ul" || tag === "ol") out += `\n\n${list(child, context, depth)}\n`;
    else if (tag === "pre") out += `\n\n\`\`\`\n${textBlock(child)}\n\`\`\`\n\n`;
    else if (tag === "code") out += `\`${textOf(child)}\``;
    else if (tag === "blockquote")
      out += `\n\n${clean(render(child, context, depth))
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n`;
    else if (tag === "table") out += table(child, context);
    else if (tag === "img") out += image(child, context);
    else if (tag === "a") out += link(child, context);
    else if (tag === "li") out += `\n- ${inline(child, context)}\n`;
    else if (BLOCKS.has(tag))
      out += `${tag === "div" ? "\n" : "\n\n"}${render(child, context, depth)}${tag === "div" ? "\n" : "\n\n"}`;
    else out += render(child, context, depth);
  }
  return out;
}

// A preformatted block as written, its lines kept.
function textBlock(element: Element): string {
  let out = "";
  const walk = (parent: Parent) => {
    for (const child of parent.childNodes) {
      if (child.nodeName === "#text") out += (child as { value: string }).value;
      else if (isElement(child) && !SKIPPED_TAGS.has(child.tagName)) {
        if (child.tagName === "br") out += "\n";
        walk(child);
      }
    }
  };
  walk(element);
  return out.replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "");
}

// Spaces collapsed and lines trimmed, but a nested list item keeps its indent.
function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const indent = /^( +)(?:-|\d+\.) /.exec(line)?.[1] ?? "";
      return indent + line.replace(/[ \t\u00a0]+/g, " ").trim();
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Cut by code points, never inside a character.
function cut(text: string, max: number): { text: string; truncated: boolean } {
  const chars = [...text];
  return chars.length <= max
    ? { text, truncated: false }
    : { text: chars.slice(0, max).join(""), truncated: true };
}

// A page's text as Markdown: headings, paragraphs, lists, tables, pictures and code, without the
// site around it, then the links it holds. Undefined when the page cannot be read.
export function readable(html: string, url: string, maxChars: number): ReadablePage | undefined {
  const page = parseHtml(html);
  if (!page) return undefined;
  const base = new URL(url);
  const head = find(page, byTag("head"));
  const ogTitle = head
    ? findAll(head, byTag("meta")).find((m) => attr(m, "property") === "og:title")
    : undefined;
  const title = clean(
    textOf(find(page, byTag("title"))) ||
      (ogTitle && attr(ogTitle, "content")) ||
      textOf(find(page, byTag("h1"))),
  ).slice(0, 300);
  const context: Context = { base, links: new Map(), images: 0 };
  const body = tidy(render(mainOf(page), context, 0));
  const room = Math.floor(maxChars * 0.2);
  let links = "";
  for (const [href, text] of context.links) {
    const line = `\n- ${text}: ${href}`;
    if (links.length + line.length > room) break;
    links += line;
  }
  const kept = cut(body, maxChars - (links ? links.length + 8 : 0));
  return {
    title,
    text: `${kept.text}${kept.truncated ? "\n(page text cut)" : ""}${links ? `\n\nLinks:${links}` : ""}`,
    truncated: kept.truncated,
  };
}

// Plain text, JSON or CSV as it came, within the size.
export function plainText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const kept = cut(text.replace(/\r\n?/g, "\n"), maxChars);
  return { text: `${kept.text}${kept.truncated ? "\n(text cut)" : ""}`, truncated: kept.truncated };
}
