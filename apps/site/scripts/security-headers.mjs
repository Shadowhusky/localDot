import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

// Allow only the exact structured data shipped in this build, without weakening script-src.
const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
const hashes = blocks.map(
  (match) => `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`,
);
const headersURL = new URL("../dist/_headers", import.meta.url);
const headers = await readFile(headersURL, "utf8");
await writeFile(
  headersURL,
  headers.replace("script-src 'self';", `script-src 'self' ${hashes.join(" ")};`),
);
