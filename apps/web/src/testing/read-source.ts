// Reads a source file in Vitest's Node runtime. The web tsconfig carries browser types only, and
// Vitest blanks a ?raw import of CSS, so the module is named through a variable.
const FS = "node:fs/promises";

export async function readSource(url: URL): Promise<string> {
  const fs = (await import(/* @vite-ignore */ FS)) as {
    readFile(path: URL, encoding: "utf8"): Promise<string>;
  };
  return fs.readFile(url, "utf8");
}
