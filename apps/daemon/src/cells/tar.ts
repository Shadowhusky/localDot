// A minimal ustar writer for Docker's archive endpoint: flat regular files only, owned by root.
// The daemon writes a cell's keyd files this way: never through a bind mount (the repo's path
// wedges Docker Desktop's file sharing), and never as `docker exec` arguments, which `ps` shows.

export interface TarFile {
  name: string;
  data: string | Uint8Array;
  mode?: number;
}

const BLOCK = 512;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function tar(files: TarFile[], mtimeSeconds = Math.floor(Date.now() / 1000)): Buffer {
  octal(mtimeSeconds, 11);
  const parts: Buffer[] = [];
  const names = new Set<string>();
  for (const file of files) {
    if (!NAME.test(file.name) || file.name === "." || file.name === "..") {
      throw new RangeError(`tar: ${JSON.stringify(file.name)} is not a plain file name`);
    }
    if (names.has(file.name)) throw new RangeError("tar: duplicate file name");
    names.add(file.name);
    const mode = file.mode ?? 0o644;
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
      throw new RangeError("tar: mode must contain permission bits only");
    }
    const data =
      typeof file.data === "string" ? Buffer.from(file.data, "utf8") : Buffer.from(file.data);
    parts.push(header(file.name, data.length, mode, mtimeSeconds), data, padding(data.length));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

// The bytes of the regular file `name` in an archive Docker sent, or undefined when it holds none.
// A malformed archive throws.
export function untar(archive: Buffer, name: string): Buffer | undefined {
  for (let offset = 0; offset + BLOCK <= archive.length; ) {
    const h = archive.subarray(offset, offset + BLOCK);
    if (h.every((byte) => byte === 0)) return undefined;
    const size = Number.parseInt(field(h, 124, 12), 8);
    const checksum = Number.parseInt(field(h, 148, 8), 8);
    let actual = 0;
    for (let i = 0; i < BLOCK; i++) actual += i >= 148 && i < 156 ? 32 : (h[i] ?? 0);
    if (
      checksum !== actual ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      offset + BLOCK + size > archive.length
    )
      throw new RangeError("tar: the archive is damaged or cut short");
    const type = h[156];
    if (field(h, 0, 100) === name && (type === 0x30 || type === 0))
      return archive.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return undefined;
}

const field = (h: Buffer, start: number, length: number) =>
  h
    .subarray(start, start + length)
    .toString()
    .replace(/\0.*$/s, "");

function header(name: string, size: number, mode: number, mtime: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, "ascii");
  h.write(octal(mode, 7), 100, "ascii");
  h.write(octal(0, 7), 108, "ascii");
  h.write(octal(0, 7), 116, "ascii");
  h.write(octal(size, 11), 124, "ascii");
  h.write(octal(mtime, 11), 136, "ascii");
  h.write("        ", 148, "ascii");
  h.write("0", 156, "ascii");
  h.write("ustar\u000000", 257, "ascii");
  h.write("root", 265, "ascii");
  h.write("root", 297, "ascii");
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, "0")}\u0000 `, 148, "ascii");
  return h;
}

function octal(value: number, digits: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("tar: header fields must be nonnegative safe integers");
  }
  const text = value.toString(8);
  if (text.length > digits)
    throw new RangeError(`tar: ${value} does not fit ${digits} octal digits`);
  return `${text.padStart(digits, "0")}\u0000`;
}

function padding(length: number): Buffer {
  return Buffer.alloc((BLOCK - (length % BLOCK)) % BLOCK);
}
