import { type ClientRequest, request as httpRequest } from "node:http";

// Engine 29.2 serves 1.53 and accepts 1.44+; 1.47 (Engine 27) is the oldest this code is written against.
export const DOCKER_API = "v1.47";

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
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
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
  const path = host?.startsWith("unix://") ? host.slice("unix://".length) : "";
  return path || "/var/run/docker.sock";
}

export class DockerClient {
  constructor(readonly socketPath: string = dockerSocketPath()) {
    // Node ignores an empty socketPath and connects to localhost:80, so whatever listens there
    // would get the request, cell tokens included.
    if (socketPath === "") throw new RangeError("the Docker socket path is empty");
  }

  request<T = undefined>(req: DockerRequest): Promise<T> {
    return this.#send<T>(`/${DOCKER_API}`, req);
  }

  #send<T>(prefix: string, req: DockerRequest): Promise<T> {
    const query = req.query ? `?${new URLSearchParams(req.query)}` : "";
    const path = `${prefix}${req.path}${query}`;
    return new Promise<T>((resolve, reject) => {
      const unreachable = (err: NodeJS.ErrnoException) =>
        reject(
          new DockerError(0, `${err.code ?? err.message}; is Docker Desktop running?`, req.path),
        );
      let body: string | undefined;
      let r: ClientRequest;
      // An unserialisable body or a path Node refuses throws here, before anything is sent.
      try {
        body = req.body === undefined ? undefined : JSON.stringify(req.body);
        r = httpRequest(
          {
            socketPath: this.socketPath,
            method: req.method,
            path,
            headers: {
              host: "docker",
              ...(body === undefined
                ? {}
                : {
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(body),
                  }),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            // Node reports a reply cut off mid-body only to an "error" listener; without one, this
            // promise never settles.
            res.on("error", unreachable);
            res.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              const status = res.statusCode ?? 0;
              // 304: the container was already started or stopped, so there was nothing to do.
              if (status === 304) {
                resolve(undefined as T);
                return;
              }
              if (status >= 300) {
                reject(new DockerError(status, messageOf(text), req.path));
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
