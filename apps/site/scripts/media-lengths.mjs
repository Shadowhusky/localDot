// Records each of the site's own videos' lengths in dist/media-lengths.json, for the Worker to cut
// byte ranges from a binding response that comes without Content-Length.
import { readdir, stat, writeFile } from "node:fs/promises";
import { OWNED_VIDEO } from "../src/worker.ts";

const dist = new URL("../dist/", import.meta.url);
const lengths = {};
for (const file of await readdir(dist, { recursive: true })) {
  const path = `/${file.split("\\").join("/")}`;
  if (OWNED_VIDEO.test(path)) lengths[path] = (await stat(new URL(file, dist))).size;
}
await writeFile(new URL("media-lengths.json", dist), `${JSON.stringify(lengths, null, 2)}\n`);
console.log(`Recorded the lengths of ${Object.keys(lengths).length} videos.`);
