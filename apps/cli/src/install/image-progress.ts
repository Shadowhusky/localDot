export interface ImagePullProgress {
  phase: "pulling" | "downloading" | "extracting" | "verifying";
  layer?: string;
  currentBytes?: number;
  totalBytes?: number;
}
const fail = () => new Error("Docker image pull returned invalid progress.");

/** Bounded NDJSON parser. Docker can report errors inside an HTTP 200 stream. No response text
 * is forwarded: output is a fixed phase plus validated layer/counters only. Final image inspect,
 * never a progress/status message, determines whether the requested image is present.
 */
export async function readImagePullProgress(
  stream: AsyncIterable<Buffer>,
  signal: AbortSignal,
  report: (progress: ImagePullProgress) => void,
) {
  const line = Buffer.alloc(64 * 1024);
  let used = 0,
    total = 0,
    lines = 0,
    records = 0,
    lastReport = -Infinity;
  function consume() {
    if (++lines > 32768) throw fail();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(line.subarray(0, used)).trim();
    used = 0;
    if (!text) return;
    const doc: unknown = JSON.parse(text);
    if (
      !doc ||
      typeof doc !== "object" ||
      Array.isArray(doc) ||
      "error" in doc ||
      "errorDetail" in doc
    )
      throw fail();
    records++;
    const value = doc as Record<string, unknown>;
    const phase: ImagePullProgress["phase"] =
      value.status === "Downloading"
        ? "downloading"
        : value.status === "Extracting"
          ? "extracting"
          : value.status === "Verifying Checksum"
            ? "verifying"
            : "pulling";
    const progress: ImagePullProgress = { phase };
    if (typeof value.id === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value.id))
      progress.layer = value.id;
    const detail = value.progressDetail;
    if (
      detail &&
      typeof detail === "object" &&
      !Array.isArray(detail) &&
      "current" in detail &&
      "total" in detail &&
      typeof detail.current === "number" &&
      typeof detail.total === "number" &&
      Number.isSafeInteger(detail.current) &&
      Number.isSafeInteger(detail.total) &&
      detail.current >= 0 &&
      detail.total >= detail.current
    ) {
      progress.currentBytes = detail.current;
      progress.totalBytes = detail.total;
    }
    if (Date.now() - lastReport >= 250) {
      report(Object.freeze(progress));
      lastReport = Date.now();
    }
  }
  for await (const chunk of stream) {
    signal.throwIfAborted();
    if (!Buffer.isBuffer(chunk)) throw fail();
    total += chunk.length;
    if (total > 16 * 1024 * 1024) throw fail();
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset),
        stop = end === -1 ? chunk.length : end;
      if (used + stop - offset > line.length) throw fail();
      chunk.copy(line, used, offset, stop);
      used += stop - offset;
      offset = stop + (end === -1 ? 0 : 1);
      if (end !== -1) consume();
    }
  }
  signal.throwIfAborted();
  if (used) consume();
  if (!records) throw fail();
}
