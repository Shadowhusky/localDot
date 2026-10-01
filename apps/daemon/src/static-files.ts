import { readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export interface StaticFile {
  body: Uint8Array<ArrayBuffer>;
  type: string;
}

export function readStatic(dir: string, rel: string): StaticFile | undefined {
  const root = resolve(dir);
  const file = resolve(root, `.${rel.startsWith("/") ? rel : `/${rel}`}`);
  if (file !== root && !file.startsWith(root + sep)) return undefined;
  try {
    if (!statSync(file).isFile()) return undefined;
    return { body: readFileSync(file), type: TYPES[extname(file)] ?? "application/octet-stream" };
  } catch {
    return undefined;
  }
}
