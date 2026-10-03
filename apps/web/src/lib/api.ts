export const WS_PROTOCOL = "localdot.v1";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClient {
  readonly token: string;
  fetch: typeof fetch;
  authorization(): string;
  get<T>(path: string, options?: { signal?: AbortSignal }): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  del(path: string): Promise<void>;
  socketUrl(path: string): string;
  socketProtocols(): string[];
}

export interface ApiOptions {
  fetchImpl?: typeof fetch;
  onUnauthorized?: () => void;
  origin?: string;
}

export function createApi(token: string, opts: ApiOptions = {}): ApiClient {
  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  const origin = opts.origin ?? window.location.origin;

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await fetchImpl(`${origin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    });
    if (res.status === 401) {
      opts.onUnauthorized?.();
      throw new ApiError(401, "unauthorized");
    }
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, text || res.statusText);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    token,
    fetch: fetchImpl,
    authorization: () => `Bearer ${token}`,
    get: (path, options) => call("GET", path, undefined, options?.signal),
    post: (path, body) => call("POST", path, body),
    del: async (path) => {
      await call("DELETE", path);
    },
    socketUrl: (path) => `${origin.replace(/^http/, "ws")}${path}`,
    socketProtocols: () => [WS_PROTOCOL, `localdot.token.${token}`],
  };
}
