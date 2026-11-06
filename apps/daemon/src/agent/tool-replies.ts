export interface Reply {
  status: number;
  headers: [string, string][];
  body: ArrayBuffer;
}

interface Taken {
  reply: Promise<Reply | undefined>;
  bytes?: number;
}

// While a brain's connection is down it keeps few calls open, so these bounds are far above what
// its reconnect window needs.
const KEPT_REPLIES = 256;
const KEPT_BYTES = 16 * 1024 * 1024;

// One brain generation's answers by request id. A brain whose connection dropped sends the same
// request again, with the same id, until it gets through: a request the daemon already took gets
// that request's own answer, once it has one, so nothing runs twice. A request that never got
// under way is forgotten, and the next copy of it runs.
export class Replies {
  readonly #taken = new Map<string, Taken>();
  #bytes = 0;

  get(id: string): Promise<Reply | undefined> | undefined {
    return this.#taken.get(id)?.reply;
  }

  // Settle with the answer, or with undefined when nothing of the request was done.
  take(id: string): (reply: Reply | undefined) => void {
    const { promise, resolve } = Promise.withResolvers<Reply | undefined>();
    const entry: Taken = { reply: promise };
    this.#taken.set(id, entry);
    return (reply) => {
      resolve(reply);
      if (this.#taken.get(id) !== entry) return;
      if (!reply) {
        this.#taken.delete(id);
        return;
      }
      entry.bytes = reply.body.byteLength;
      this.#bytes += entry.bytes;
      this.#trim();
    };
  }

  #trim(): void {
    for (const [id, entry] of this.#taken) {
      if (this.#taken.size <= KEPT_REPLIES && this.#bytes <= KEPT_BYTES) return;
      // Map order is arrival order; one still running has no answer to keep yet.
      if (entry.bytes === undefined) continue;
      this.#taken.delete(id);
      this.#bytes -= entry.bytes;
    }
  }
}
