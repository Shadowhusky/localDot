import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const VERSION = "1.61.0";

function packageRoot(webDir) {
  const entry = createRequire(join(webDir, "package.json")).resolve("mediabunny");
  let candidate = dirname(entry);
  for (let depth = 0; depth < 8; depth++) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (pkg?.name === "mediabunny") {
      if (pkg.version !== VERSION || pkg.license !== "MPL-2.0") {
        throw new Error("The build notice requires unmodified mediabunny 1.61.0 under MPL-2.0");
      }
      return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error("Cannot locate the installed mediabunny package for its license notice");
}

export function writeNotices({ webDir, outDir }) {
  const pkg = packageRoot(resolve(webDir));
  const license = readFileSync(join(pkg, "LICENSE"));
  if (license.length === 0) throw new Error("The installed mediabunny license is empty");
  const header = Buffer.from(
    `mediabunny ${VERSION}\n` +
      "License: Mozilla Public License Version 2.0 (MPL-2.0)\n" +
      "Used unmodified in localDot.\n" +
      "Source Code Form for this exact version:\n" +
      `https://registry.npmjs.org/mediabunny/-/mediabunny-${VERSION}.tgz\n` +
      `https://github.com/Vanilagy/mediabunny/tree/v${VERSION}\n\n`,
  );
  const name = `licenses/mediabunny-${VERSION}.txt`;
  mkdirSync(join(outDir, "licenses"), { recursive: true });
  writeFileSync(join(outDir, name), Buffer.concat([header, license]));
  return { files: [name] };
}

const PDFJS = "6.3.289";

// pdf.js (Apache-2.0) draws PDFs in the file preview; its license ships beside the build.
export function writePdfNotice({ webDir, outDir }) {
  const pkg = dirname(
    createRequire(join(webDir, "package.json")).resolve("pdfjs-dist/package.json"),
  );
  const meta = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
  if (meta.version !== PDFJS || meta.license !== "Apache-2.0")
    throw new Error(`The build notice requires pdfjs-dist ${PDFJS} under Apache-2.0`);
  const license = readFileSync(join(pkg, "LICENSE"));
  if (license.length === 0) throw new Error("The installed pdfjs-dist license is empty");
  const header = Buffer.from(
    `pdfjs-dist ${PDFJS} (pdf.js, Mozilla Foundation)\n` +
      "License: Apache License 2.0 (Apache-2.0)\n" +
      "Used unmodified in localDot's file preview.\n" +
      `Source: https://github.com/mozilla/pdf.js/tree/v${PDFJS}\n\n`,
  );
  const name = `licenses/pdfjs-dist-${PDFJS}.txt`;
  mkdirSync(join(outDir, "licenses"), { recursive: true });
  writeFileSync(join(outDir, name), Buffer.concat([header, license]));
  return { files: [name] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = join(webDir, "dist/assets");
  const files = [writeNotices({ webDir, outDir }), writePdfNotice({ webDir, outDir })].flatMap(
    (receipt) => receipt.files,
  );
  console.log(`Shipped license notices: ${files.join(", ")}`);
}
