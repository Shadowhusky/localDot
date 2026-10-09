// Whether a page asks for pictures, stylesheets, fonts or media from the web: an absolute or
// protocol-relative address in a resource attribute, a stylesheet link, url() or @import. The
// preview blocks every one of them; this only decides whether to say so. Links are not resources.
const FROM_WEB =
  /\b(?:src|srcset|poster|data|background)\s*=\s*["']?\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\/|@import\s+(?:url\()?\s*["']?\s*(?:https?:)?\/\/|<link\b[^>]*?\bhref\s*=\s*["']?\s*(?:https?:)?\/\//i;

export function loadsFromWeb(html: string): boolean {
  return FROM_WEB.test(html);
}
