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
