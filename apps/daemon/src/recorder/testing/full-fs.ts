import * as fs from "node:fs";
import type { RecordingFs } from "../writer.ts";

// A filesystem that runs out of space after `budget` bytes, as write(2) does with ENOSPC. A write
// that doesn't fit throws without writing; with `torn`, it first writes the part that fits (a short
// write followed by ENOSPC), which is what leaves a torn box on a real disk.
export function fullAfter(
  budget: number,
  opts: { torn?: boolean } = {},
): RecordingFs & { used(): number } {
  let used = 0;
  const enospc = () =>
    Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  const fit = (n: number): number => {
    if (used + n <= budget) {
      used += n;
      return n;
    }
    if (!opts.torn) throw enospc();
    const part = Math.max(0, budget - used);
    used += part;
    return part;
  };
  return {
    ...fs,
    used: () => used,
    writeSync: ((
      fd: number,
      data: Uint8Array,
      offset: number = 0,
      length: number = data.length - offset,
      position?: number | null,
    ) => {
      const n = fit(length);
      const wrote = n > 0 ? fs.writeSync(fd, data, offset, n, position) : 0;
      if (n < length) throw enospc();
      return wrote;
    }) as typeof fs.writeSync,
    appendFileSync: ((file: fs.PathOrFileDescriptor, data: string | Uint8Array) => {
      const bytes = typeof data === "string" ? Buffer.from(data) : data;
      const n = fit(bytes.length);
      if (n > 0) fs.appendFileSync(file, bytes.subarray(0, n));
      if (n < bytes.length) throw enospc();
    }) as typeof fs.appendFileSync,
  };
}
