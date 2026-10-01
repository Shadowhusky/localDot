// Raw little-endian 16-bit PCM bytes as they arrive, with an odd trailing byte kept for later.
export class PcmChunker {
  #leftover: number | null = null;

  push(bytes: Uint8Array): Int16Array {
    const joined = new Uint8Array(bytes.length + (this.#leftover === null ? 0 : 1));
    if (this.#leftover !== null) joined[0] = this.#leftover;
    joined.set(bytes, this.#leftover === null ? 0 : 1);
    const pcm = new Int16Array(Math.floor(joined.length / 2));
    const view = new DataView(joined.buffer);
    for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(i * 2, true);
    this.#leftover = joined.length % 2 ? (joined[joined.length - 1] ?? 0) : null;
    return pcm;
  }
}

export class NdjsonReader {
  readonly #decoder = new TextDecoder();
  #buffer = "";

  push(bytes: Uint8Array): unknown[] {
    this.#buffer += this.#decoder.decode(bytes, { stream: true });
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    return parseLines(lines);
  }

  flush(): unknown[] {
    const rest = this.#buffer;
    this.#buffer = "";
    return parseLines([rest]);
  }
}

function parseLines(lines: string[]): unknown[] {
  const out: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn or foreign line carries nothing we can use.
    }
  }
  return out;
}
