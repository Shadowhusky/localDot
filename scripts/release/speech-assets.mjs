#!/usr/bin/env node
// Keeps the speech program and models pinned in apps/daemon/src/voice/speech-catalog.ts honest.
//
//   pin <archive> <url> <root> <file>...   Prints the pins for a downloaded archive, for the catalog.
//   check [--full]                         Every source still answers with the pinned size; with
//                                          --full, its bytes and unpacked files match their pins.
//   mirror <new-dir>                       Repacks every source as .tar.gz with the same files, for
//                                          our own release, and prints the entries to add.
//
import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(nodeExecFile);
export const MIRROR_BASE =
  "https://github.com/Shadowhusky/localdot-downloads/releases/download/speech-assets-1";

export async function sha256Of(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function pinArchive(archive, url, root, files) {
  const dir = await mkdtemp(join(tmpdir(), "speech-pin-"));
  try {
    await exec("tar", [
      "-xf",
      archive,
      "-C",
      dir,
      "--strip-components=1",
      ...files.map((file) => `${root}/${file}`),
    ]);
    const pins = {};
    for (const file of files) {
      const found = await stat(join(dir, file));
      pins[file] = { sha256: await sha256Of(join(dir, file)), bytes: found.size };
    }
    const { size } = await stat(archive);
    return { files: pins, sources: [{ url, sha256: await sha256Of(archive), bytes: size, root }] };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function bundlesOf(catalog) {
  return [
    ...Object.entries(catalog.engine.targets).map(([target, bundle]) => ({
      name: `engine-${catalog.engine.version}-${target}`,
      bundle,
    })),
    ...catalog.tiers.map((tier) => ({ name: `model-${tier.id}`, bundle: tier })),
  ];
}

// Every problem the catalog's shape can hold, without fetching anything.
export function catalogProblems(catalog) {
  const problems = [];
  const hex = /^[0-9a-f]{64}$/;
  for (const { name, bundle } of bundlesOf(catalog)) {
    if (!bundle.sources.length) problems.push(`${name} has no source`);
    for (const source of bundle.sources) {
      if (!source.url.startsWith("https://")) problems.push(`${name}: ${source.url} isn't https`);
      if (!hex.test(source.sha256)) problems.push(`${name}: ${source.url} has no SHA-256`);
      if (!(source.bytes > 0)) problems.push(`${name}: ${source.url} has no size`);
      if (!source.root) problems.push(`${name}: ${source.url} names no archive folder`);
    }
    for (const [path, pin] of Object.entries(bundle.files)) {
      if (path.includes("..") || path.startsWith("/")) problems.push(`${name}: bad path ${path}`);
      if (!hex.test(pin.sha256)) problems.push(`${name}: ${path} has no SHA-256`);
      if (!(pin.bytes > 0)) problems.push(`${name}: ${path} has no size`);
    }
  }
  return problems;
}

async function download(url, to) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`${url}: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(to));
}

// Slow networks time out now and then, so one failure doesn't call a file gone.
async function sizeOf(url, tries = 3) {
  try {
    const answer = await fetch(url, { headers: { range: "bytes=0-0" }, redirect: "follow" });
    await answer.body?.cancel();
    return {
      status: answer.status,
      total: Number(answer.headers.get("content-range")?.split("/")[1]),
    };
  } catch (error) {
    if (tries <= 1) return { status: String(error?.cause?.code ?? error?.message), total: 0 };
    return sizeOf(url, tries - 1);
  }
}

export async function check(catalog, full) {
  const problems = catalogProblems(catalog);
  for (const { name, bundle } of bundlesOf(catalog)) {
    for (const source of bundle.sources) {
      const answer = await sizeOf(source.url);
      if (answer.status !== 206 || answer.total !== source.bytes)
        problems.push(`${name}: ${source.url} answers ${answer.status} with ${answer.total} bytes`);
      else console.log(`ok ${name} ${basename(new URL(source.url).pathname)}`);
      if (!full || problems.length) continue;
      const dir = await mkdtemp(join(tmpdir(), "speech-check-"));
      try {
        const archive = join(dir, "archive");
        await download(source.url, archive);
        if ((await sha256Of(archive)) !== source.sha256)
          problems.push(`${name}: ${source.url} doesn't match its SHA-256`);
        const pins = await pinArchive(archive, source.url, source.root, Object.keys(bundle.files));
        for (const [path, pin] of Object.entries(bundle.files))
          if (pins.files[path].sha256 !== pin.sha256)
            problems.push(`${name}: ${path} doesn't match its SHA-256`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }
  return problems;
}

export async function mirror(catalog, out) {
  if (existsSync(out)) throw new Error(`${out} already exists`);
  await mkdir(out, { recursive: true });
  const entries = {};
  for (const { name, bundle } of bundlesOf(catalog)) {
    const source = bundle.sources.at(-1);
    const dir = await mkdtemp(join(tmpdir(), "speech-mirror-"));
    try {
      const archive = join(dir, "archive");
      await download(source.url, archive);
      if ((await sha256Of(archive)) !== source.sha256)
        throw new Error(`${source.url} doesn't match its SHA-256`);
      await exec("tar", [
        "-xf",
        archive,
        "-C",
        dir,
        ...Object.keys(bundle.files).map((file) => `${source.root}/${file}`),
      ]);
      for (const [path, pin] of Object.entries(bundle.files))
        if ((await sha256Of(join(dir, source.root, path))) !== pin.sha256)
          throw new Error(`${name}: ${path} doesn't match its SHA-256`);
      const file = `${name}.tar.gz`;
      await exec(
        "tar",
        ["-czf", join(out, file), ...Object.keys(bundle.files).map((p) => `${source.root}/${p}`)],
        { cwd: dir, env: { ...process.env, COPYFILE_DISABLE: "1", GZIP: "-n" } },
      );
      const { size } = await stat(join(out, file));
      entries[name] = {
        url: `${MIRROR_BASE}/${file}`,
        sha256: await sha256Of(join(out, file)),
        bytes: size,
        root: source.root,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const notice = fileURLToPath(new URL("../../THIRD-PARTY.md", import.meta.url));
  await copyFile(notice, join(out, "THIRD-PARTY.md"));
  await writeFile(join(out, "sources.json"), `${JSON.stringify(entries, null, 2)}\n`);
  return entries;
}

async function shippedCatalog() {
  const { SPEECH_CATALOG } = await import("../../apps/daemon/src/voice/speech-catalog.ts");
  return SPEECH_CATALOG;
}

async function main([command, ...rest]) {
  if (command === "pin") {
    const [archive, url, root, ...files] = rest;
    console.log(JSON.stringify(await pinArchive(archive, url, root, files), null, 2));
    return;
  }
  if (command === "check") {
    const problems = await check(await shippedCatalog(), rest.includes("--full"));
    for (const problem of problems) console.error(problem);
    if (problems.length) process.exitCode = 1;
    return;
  }
  if (command === "mirror") {
    const entries = await mirror(await shippedCatalog(), rest[0]);
    console.log(JSON.stringify(entries, null, 2));
    console.log(
      `\nThen: gh release create speech-assets-1 --repo Shadowhusky/localdot-downloads ${rest[0]}/*.tar.gz ${rest[0]}/THIRD-PARTY.md`,
    );
    console.log("and put each entry first in its bundle's sources in speech-catalog.ts.");
    return;
  }
  console.error("usage: speech-assets.mjs pin|check|mirror (see the top of this file)");
  process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  await main(process.argv.slice(2));
