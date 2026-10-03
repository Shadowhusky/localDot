import { ProxyAgent, fetch as undiciFetch } from "undici";

export type ProxyFetch = typeof fetch & { close(): Promise<void> };

// keyd's brain listener receives plain HTTP in absolute form. The proxy credential belongs to
// the dispatcher, never to an upstream request header. This dispatcher keeps its normal LLM
// timeouts; only ToolClient disables implicit timeouts for long-lived user/tool waits.
export function proxyFetch(proxyUrl: string, proxyToken: string): ProxyFetch {
  const url = new URL(proxyUrl);
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid model proxy URL");
  if (!/^[A-Za-z0-9_-]{43}$/.test(proxyToken)) throw new Error("Invalid model proxy token");
  const dispatcher = new ProxyAgent({
    uri: url.origin,
    token: `Basic ${Buffer.from(`brain:${proxyToken}`).toString("base64")}`,
    proxyTunnel: false,
  });
  const closed = new AbortController();
  let closing: Promise<void> | undefined;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (
      target.protocol !== "http:" ||
      target.hostname !== "llm.ldot" ||
      target.port ||
      target.username ||
      target.password ||
      target.hash
    )
      throw new Error("Model request must use the keyd gateway");
    const requestSignal =
      init?.signal ?? (typeof input === "object" && "signal" in input ? input.signal : undefined);
    const headers = new Headers(
      init?.headers ??
        (typeof input === "object" && "headers" in input ? input.headers : undefined),
    );
    headers.delete("proxy-authorization");
    const request = typeof input === "object" && "method" in input ? input : undefined;
    return undiciFetch(target.toString(), {
      ...(request
        ? {
            method: request.method,
            body: request.body as never,
            duplex: "half" as const,
          }
        : {}),
      ...(init as Parameters<typeof undiciFetch>[1]),
      headers: Object.fromEntries(headers),
      dispatcher,
      redirect: "error",
      signal: AbortSignal.any([closed.signal, ...(requestSignal ? [requestSignal] : [])]),
    }) as unknown as Promise<Response>;
  }) as ProxyFetch;
  fetch.close = () => {
    closed.abort();
    closing ??= dispatcher.destroy();
    return closing;
  };
  return fetch;
}
