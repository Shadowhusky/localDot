import { readInstallToken } from "./install-token-reader.ts";

export interface OpenLinkOptions {
  home: string;
  port: number;
  signal: AbortSignal;
}
export interface OpenLinkIO {
  out(message: string): void;
  err(message: string): void;
  fetch?: typeof fetch;
}

/** Print a fresh one-use URL for the current daemon; never print reusable authority. */
export async function runOpenLink(options: OpenLinkOptions, io: OpenLinkIO): Promise<number> {
  const { home, port, signal } = options;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let interrupt!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    interrupt = () => {
      controller.abort();
      void reader?.cancel().catch(() => {});
      reject(new Error("interrupted"));
    };
  });
  // Install a rejection handler before any synchronous validation can throw.
  void cancelled.catch(() => {});
  try {
    signal.throwIfAborted();
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid port");
    const token = readInstallToken(home);
    timer = setTimeout(interrupt, 10_000);
    signal.addEventListener("abort", interrupt, { once: true });
    if (signal.aborted) interrupt();
    const response = await Promise.race([
      cancelled,
      (io.fetch ?? fetch)(`http://127.0.0.1:${port}/api/install-code`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      }),
    ]);
    if (response.status !== 200 || response.redirected || !response.body)
      throw new Error("link unavailable");
    reader = response.body.getReader();
    const data = new Uint8Array(256);
    let offset = 0;
    while (true) {
      const part = await Promise.race([cancelled, reader.read()]);
      if (part.done) break;
      if (offset + part.value.byteLength > data.length) throw new Error("invalid response");
      data.set(part.value, offset);
      offset += part.value.byteLength;
    }
    const result: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, offset)),
    );
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      Object.keys(result).length !== 2 ||
      !("code" in result) ||
      typeof result.code !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(result.code) ||
      result.code === token ||
      !("expiresAt" in result) ||
      typeof result.expiresAt !== "number" ||
      !Number.isSafeInteger(result.expiresAt) ||
      result.expiresAt <= Date.now() ||
      result.expiresAt > Date.now() + 60_000
    )
      throw new Error("invalid response");
    if (controller.signal.aborted || signal.aborted) throw new Error("interrupted");
    io.out(`http://127.0.0.1:${port}/#code=${result.code}`);
    return 0;
  } catch {
    io.err(
      signal.aborted
        ? "Sign-in link request interrupted."
        : "Could not create a sign-in link. Check the local daemon and private installation home, then try again.",
    );
    return signal.aborted ? 130 : 1;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", interrupt);
    controller.abort();
    void reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
