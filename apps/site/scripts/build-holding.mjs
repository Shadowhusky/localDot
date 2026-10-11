import { copyFile, mkdir, rm } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const output = new URL("dist-holding/", root);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

// Explicitly allow only holding-page files. The full website stays in the local Vite build.
const files = [
  ["holding/index.html", "index.html"],
  ["holding/index.html", "404.html"],
  ["holding/holding.css", "holding.css"],
  ["holding/_headers", "_headers"],
  ["holding/robots.txt", "robots.txt"],
  ["public/chamber.webp", "chamber.webp"],
  ["public/favicon.svg", "favicon.svg"],
];

await Promise.all(
  files.map(([source, destination]) =>
    copyFile(new URL(source, root), new URL(destination, output)),
  ),
);

console.log("Built the coming-soon page in dist-holding. The full website remains local.");
