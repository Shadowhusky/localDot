import { execFileSync, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createGunzip, createZstdDecompress } from "node:zlib";

// Google's terms bar us from distributing Chrome, so it must not be in an image we publish, in any
// layer: a file a later layer deletes still ships. These are the paths its package installs or
// configures, and Widevine, which comes with it.
const FORBIDDEN = [
  /^opt\/google(\/|$)/,
  /^usr\/bin\/google-chrome/,
  /^etc\/apt\/sources\.list\.d\/google-chrome/,
  /^etc\/apt\/trusted\.gpg\.d\/google-chrome/,
  /^usr\/share\/keyrings\/google-chrome/,
  /^etc\/cron\.daily\/google-chrome/,
  /^etc\/default\/google-chrome/,
  /^var\/lib\/dpkg\/info\/google-chrome/,
  /^usr\/share\/(applications|appdata|doc|gnome-control-center|man\/man1|menu)\/.*google-chrome/,
  /(^|\/)google-chrome[^/]*\.deb$/,
  /(^|\/)WidevineCdm(\/|$)/,
  /(^|\/)libwidevinecdm\.so$/,
];

export function forbiddenPath(path) {
  const name = path.replace(/^(\.\/)+/, "").replace(/\/$/, "");
  return FORBIDDEN.some((pattern) => pattern.test(name));
}

// What the bytes at the start of a saved blob are: a layer in one of the forms Docker saves, or not.
function layerKind(start) {
  if (start.length >= 2 && start[0] === 0x1f && start[1] === 0x8b) return "gzip";
  if (start.length >= 4 && start.readUInt32LE(0) === 0xfd2fb528) return "zstd";
  if (start.length >= 262 && start.toString("latin1", 257, 262) === "ustar") return "tar";
  return undefined;
}

async function listLayer(kind, chunks, visit) {
  const lister = spawn("tar", ["-tf", "-"], { stdio: ["pipe", "pipe", "ignore"] });
  const finished = new Promise((done, fail) => {
    lister.once("error", fail);
    lister.once("close", (code) =>
      code === 0 ? done() : fail(new Error("tar couldn't read an image layer.")),
    );
  });
  let partial = "";
  lister.stdout.setEncoding("utf8");
  lister.stdout.on("data", (chunk) => {
    const lines = `${partial}${chunk}`.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) visit(line);
  });
  // GNU tar stops reading at the archive's end marker and closes its input; what's left is padding.
  lister.stdin.on("error", () => {});
  const bytes = Readable.from(chunks, { objectMode: false });
  const decode =
    kind === "gzip" ? [createGunzip()] : kind === "zstd" ? [createZstdDecompress()] : [];
  const fed = pipeline(bytes, ...decode, lister.stdin).then(
    () => undefined,
    (error) => error,
  );
  const [error] = await Promise.all([fed, finished]);
  if (error && error.code !== "ERR_STREAM_PREMATURE_CLOSE" && error.code !== "EPIPE") throw error;
  if (partial) visit(partial);
}

function blockReader(stream) {
  const source = stream[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  const more = async () => {
    const { value, done } = await source.next();
    if (done) return false;
    pending = pending.length ? Buffer.concat([pending, value]) : value;
    return true;
  };
  const truncated = () => new Error("The saved image ended early.");
  return {
    async read(size) {
      while (pending.length < size)
        if (!(await more())) {
          if (!pending.length) return undefined;
          throw truncated();
        }
      const out = pending.subarray(0, size);
      pending = pending.subarray(size);
      return out;
    },
    async *take(size) {
      for (let left = size; left > 0; ) {
        if (!pending.length && !(await more())) throw truncated();
        const out = pending.subarray(0, Math.min(left, pending.length));
        pending = pending.subarray(out.length);
        left -= out.length;
        yield out;
      }
    },
    // What is left of the stream, to its end.
    async *rest() {
      for (;;) {
        if (pending.length) yield pending;
        pending = Buffer.alloc(0);
        if (!(await more())) return;
      }
    },
  };
}

const headerText = (header, offset, length) => {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.toString("utf8", 0, end < 0 ? length : end);
};

/** Every layer of an image, read from the stream `docker image save` writes, with nothing kept on
 * disk. manifest.json says what the layers are; one it lists that wasn't read fails the scan. */
export async function scanSavedImage(stream) {
  const reader = blockReader(stream);
  const scanned = new Set();
  const found = [];
  let entries = 0;
  let listed;
  for (;;) {
    const header = await reader.read(512);
    if (!header || header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(headerText(header, 124, 12).trim() || "0", 8);
    const padding = (512 - (size % 512)) % 512;
    const prefix = headerText(header, 345, 155);
    const name = `${prefix ? `${prefix}/` : ""}${headerText(header, 0, 100)}`.replace(
      /^(\.\/)+/,
      "",
    );
    const regular = header[156] === 0 || header[156] === 0x30;
    if (regular && name === "manifest.json") {
      const manifest = JSON.parse((await reader.read(size)).toString("utf8"));
      listed = Array.isArray(manifest) ? manifest.flatMap((image) => image.Layers ?? []) : [];
    } else if (regular && size > 0) {
      const start = await reader.read(Math.min(size, 512));
      const kind = layerKind(start);
      let taken = start.length;
      if (!kind && start.length === 512 && start.every((byte) => byte === 0)) {
        // A build step that changes no files leaves an empty layer: a tar of nothing but its
        // end-of-archive blocks. It holds no files, so it is scanned once it is all zeros.
        let empty = true;
        for await (const chunk of reader.take(size - start.length)) {
          taken += chunk.length;
          empty &&= chunk.every((byte) => byte === 0);
        }
        if (empty) scanned.add(name);
      } else if (kind) {
        scanned.add(name);
        await listLayer(
          kind,
          (async function* () {
            yield start;
            for await (const chunk of reader.take(size - start.length)) {
              taken += chunk.length;
              yield chunk;
            }
          })(),
          (path) => {
            entries++;
            if (forbiddenPath(path)) found.push(path);
          },
        );
      }
      // Whatever the lister left unread still belongs to this layer.
      for await (const _ of reader.take(size - taken));
    } else {
      for await (const _ of reader.take(size));
    }
    if (padding) await reader.read(padding);
  }
  // An end that is never read never comes: the stream stays open, and so does the wait for what
  // wrote it. After an archive's last file come only the empty blocks that close it.
  for await (const chunk of reader.rest())
    if (!chunk.every((byte) => byte === 0))
      throw new Error("The saved image has data after its end.");
  if (!listed?.length) throw new Error("The saved image lists no layers.");
  for (const layer of listed)
    if (!scanned.has(layer))
      throw new Error(`An image layer isn't in a format this check can read: ${layer}`);
  return { layers: new Set(listed).size, entries, found };
}

/** Scans the image as Docker holds it. A published pin is pulled first, so this is its exact bytes. */
export async function scanImage(reference) {
  const saver = spawn("docker", ["image", "save", reference], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const saved = new Promise((done, fail) => {
    saver.once("error", fail);
    saver.once("close", (code) =>
      code === 0 ? done() : fail(new Error(`docker image save failed for ${reference}`)),
    );
  });
  try {
    const [result] = await Promise.all([scanSavedImage(saver.stdout), saved]);
    return result;
  } finally {
    saver.kill();
  }
}

/** The images in a release's catalog pins that haven't been scanned clean: none, or it can't ship. */
export function unprovenImages(pins, evidence) {
  const scanned = evidence?.v === 1 && evidence.images ? evidence.images : {};
  return Object.values(pins ?? {})
    .flatMap((roles) => Object.values(roles ?? {}))
    .filter((reference) => {
      const entry = Object.hasOwn(scanned, reference) ? scanned[reference] : undefined;
      return !(entry?.clean === true && entry.layers > 0 && entry.entries > 0);
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [outFlag, out, ...references] = process.argv.slice(2);
  if (outFlag !== "--out" || !out || !references.length)
    throw new Error(
      "Usage: no-chrome.mjs --out evidence.json image-or-publish-input.json [image...]",
    );
  const images = [];
  for (const reference of references) {
    if (reference.endsWith(".json"))
      images.push(
        ...Object.values(JSON.parse(await readFile(reference, "utf8")).images).flatMap((roles) =>
          Object.values(roles),
        ),
      );
    else images.push(reference);
  }
  const results = {};
  for (const reference of new Set(images)) {
    if (reference.includes("@sha256:"))
      execFileSync("docker", ["pull", "--quiet", reference], { stdio: "inherit" });
    const { layers, entries, found } = await scanImage(reference);
    results[reference] = { clean: found.length === 0, layers, entries };
    console.log(
      found.length
        ? `CHROME FOUND in ${reference}:\n  ${found.slice(0, 20).join("\n  ")}`
        : `No Chrome in ${reference}: ${layers} layers, ${entries} entries.`,
    );
  }
  await writeFile(out, `${JSON.stringify({ v: 1, images: results }, null, 2)}\n`, { flag: "wx" });
  if (Object.values(results).some((result) => !result.clean)) process.exit(1);
}
