import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export interface StaticFile {
  body: Uint8Array<ArrayBuffer>;
  type: string;
}

// rel is resolved under dir, and so is the file it names once every symlink on the way is followed:
// a link inside dir that leads out of it is refused like "../".
export function readStatic(dir: string, rel: string): StaticFile | undefined {
  try {
    const root = realpathSync(dir);
    const file = realpathSync(resolve(root, `.${rel.startsWith("/") ? rel : `/${rel}`}`));
    if (!file.startsWith(root + sep)) return undefined;
    if (!statSync(file).isFile()) return undefined;
    return { body: readFileSync(file), type: TYPES[extname(file)] ?? "application/octet-stream" };
  } catch {
    return undefined;
  }
}
