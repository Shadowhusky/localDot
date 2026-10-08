// Synthetic archive bytes only. No fixture executes a lifecycle script or archive member.
export interface TarEntry {
  name: string;
  body?: Buffer;
  type?: number;
  mode?: number;
  prefix?: string;
  size?: number;
}
export function tarChecksum(header: Buffer) {
  header.fill(32, 148, 156);
  const sum = header.reduce((total, value) => total + value, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
}
export function tarBytes(entries: TarEntry[]) {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0),
      header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    header.write(`${(entry.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(`${(entry.size ?? body.length).toString(8).padStart(11, "0")}\0`, 124, "ascii");
    header.write("00000000000\0", 136, "ascii");
    header[156] = entry.type ?? 48;
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    if (entry.prefix) header.write(entry.prefix, 345, 155, "utf8");
    tarChecksum(header);
    chunks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
export function paxLine(key: string, value: string) {
  let length = Buffer.byteLength(` ${key}=${value}\n`) + 1;
  for (;;) {
    const actual = Buffer.byteLength(`${length} ${key}=${value}\n`);
    if (actual === length) return Buffer.from(`${length} ${key}=${value}\n`);
    length = actual;
  }
}
