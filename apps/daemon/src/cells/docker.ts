import { type ClientRequest, request as httpRequest } from "node:http";
import { isAbsolute, normalize } from "node:path";

// Engine 29.2 serves 1.53 and accepts 1.44+; 1.47 (Engine 27) is the oldest this code is written against.
export const DOCKER_API = "v1.47";
export const DOCKER_TIMEOUT_MS = 30_000;

const DOCKER_APP = process.platform === "darwin" ? "Docker Desktop" : "Docker";

export class DockerError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly path: string,
  ) {
    super(`docker ${status || "unreachable"} on ${path}: ${message}`);
    this.name = "DockerError";
  }
}

export interface DockerRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  // Bounded binary replies for archives and multiplexed helper logs.
  response?: "buffer";
  // Binary archive uploads never pass through JSON or UTF-8 encoding.
  raw?: { contentType: string; data: Buffer };
}

export interface DockerVersion {
  Version: string;
  ApiVersion: string;
  MinAPIVersion: string;
  Os: string;
  Arch: string;
}

// API versions compare as [major, minor] integers: read as decimals, 1.100 would sort below 1.47.
export function compareApiVersions(a: string, b: string): number {
  const [aMajor = Number.NaN, aMinor = Number.NaN] = a.replace(/^v/, "").split(".").map(Number);
  const [bMajor = Number.NaN, bMinor = Number.NaN] = b.replace(/^v/, "").split(".").map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

export function dockerSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.DOCKER_HOST;
  if (host === undefined) return "/var/run/docker.sock";
  if (!host.startsWith("unix:///")) throw new Error("DOCKER_HOST must select a local Unix socket");
  const path = host.slice("unix://".length);
  if (
    path === "/" ||
    path.length > 1024 ||
    !isAbsolute(path) ||
    normalize(path) !== path ||
    /[?#]/.test(path) ||
    [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new Error("DOCKER_HOST contains an invalid local Unix socket path");
  return path;
}

export class DockerClient {
  constructor(
    readonly socketPath: string = dockerSocketPath(),
    readonly timeoutMs = DOCKER_TIMEOUT_MS,
  ) {
    // Node ignores an empty socketPath and connects to localhost:80, so whatever listens there
    // would get the request, cell tokens included.
    if (socketPath === "") throw new RangeError("the Docker socket path is empty");
  }

  request<T = undefined>(req: DockerRequest): Promise<T> {
    return this.#send<T>(`/${DOCKER_API}`, req);
  }

  #send<T>(prefix: string, req: DockerRequest): Promise<T> {
    const timeoutMs = req.timeoutMs ?? this.timeoutMs;
    const query = req.query ? `?${new URLSearchParams(req.query)}` : "";
    const path = `${prefix}${req.path}${query}`;
    return new Promise<T>((resolve, reject) => {
      const unreachable = (err: NodeJS.ErrnoException) =>
        reject(
          err.name === "AbortError"
            ? new DockerError(
                0,
                `no reply within ${timeoutMs} ms; is ${DOCKER_APP} responding?`,
                req.path,
              )
            : new DockerError(0, `${err.code ?? err.message}; is ${DOCKER_APP} running?`, req.path),
        );
      let body: string | Buffer | undefined;
      let r: ClientRequest;
      // An unserialisable body or a path Node refuses throws here, before anything is sent.
      try {
        if (req.raw && req.body !== undefined) throw new TypeError("choose JSON or raw data");
        body = req.raw?.data ?? (req.body === undefined ? undefined : JSON.stringify(req.body));
        r = httpRequest(
          {
            socketPath: this.socketPath,
            method: req.method,
            path,
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
              host: "docker",
              ...(body === undefined
                ? {}
                : {
                    "content-type": req.raw?.contentType ?? "application/json",
                    "content-length": Buffer.byteLength(body),
                  }),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            let received = 0;
            res.on("data", (c: Buffer) => {
              received += c.length;
              if (req.response === "buffer" && received > 256 * 1024 * 1024) {
                res.destroy(new Error("Docker archive exceeded the migration limit"));
                return;
              }
              chunks.push(c);
            });
            // Node reports a reply cut off mid-body only to an "error" listener; without one, this
            // promise never settles.
            res.on("error", unreachable);
            res.on("end", () => {
              const buffer = Buffer.concat(chunks);
              const status = res.statusCode ?? 0;
              const text = req.response === "buffer" && status < 300 ? "" : buffer.toString("utf8");
              // 304: the container was already started or stopped, so there was nothing to do.
              if (status === 304) {
                resolve(undefined as T);
                return;
              }
              if (status >= 300) {
                reject(new DockerError(status, messageOf(text), req.path));
                return;
              }
              if (req.response === "buffer") {
                resolve(buffer as T);
                return;
              }
              const isJson = (res.headers["content-type"] ?? "").includes("application/json");
              if (!isJson || text.length === 0) {
                resolve(undefined as T);
                return;
              }
              try {
                resolve(JSON.parse(text) as T);
              } catch {
                reject(new DockerError(status, "malformed JSON reply", req.path));
              }
            });
          },
        );
      } catch (err) {
        reject(new DockerError(0, `request not sent: ${(err as Error).message}`, req.path));
        return;
      }
      r.on("error", unreachable);
      if (body !== undefined) r.write(body);
      r.end();
    });
  }

  version(): Promise<DockerVersion> {
    return this.request<DockerVersion>({ method: "GET", path: "/version" });
  }

  // Docker extracts this into a stopped or running container, without a host mount or exec args.
  putArchive(container: string, dir: string, archive: Buffer): Promise<void> {
    return this.request({
      method: "PUT",
      path: `/containers/${encodeURIComponent(container)}/archive`,
      query: { path: dir },
      raw: { contentType: "application/x-tar", data: archive },
    });
  }

  // Unversioned, so an engine that refuses DOCKER_API still says which API versions it serves.
  engineVersion(): Promise<DockerVersion> {
    return this.#send<DockerVersion>("", { method: "GET", path: "/version" });
  }
}

function messageOf(text: string): string {
  try {
    return (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    return text || "no message";
  }
}
