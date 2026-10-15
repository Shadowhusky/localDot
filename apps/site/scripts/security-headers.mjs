import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

// Allow only the exact inline scripts shipped in this build (the first script, which picks the
// page's language before it is drawn, and any structured data) without weakening script-src.
const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
const hashes = blocks.map(
  (match) => `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`,
);
const headersURL = new URL("../dist/_headers", import.meta.url);
const headers = await readFile(headersURL, "utf8");
await writeFile(
  headersURL,
  headers.replace("script-src 'self';", `script-src 'self' ${hashes.join(" ")};`),
);
