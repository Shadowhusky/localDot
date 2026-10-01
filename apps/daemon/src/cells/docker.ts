import { request as httpRequest } from "node:http";

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

export function dockerSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.DOCKER_HOST;
  if (host?.startsWith("unix://")) return host.slice("unix://".length);
  return "/var/run/docker.sock";
}

export class DockerClient {
  constructor(readonly socketPath: string = dockerSocketPath()) {}

  request<T = undefined>(req: DockerRequest): Promise<T> {
    const query = req.query ? `?${new URLSearchParams(req.query)}` : "";
    const body = req.body === undefined ? undefined : JSON.stringify(req.body);
    const path = `/${DOCKER_API}${req.path}${query}`;
    return new Promise<T>((resolve, reject) => {
      const unreachable = (err: NodeJS.ErrnoException) =>
        reject(
          new DockerError(0, `${err.code ?? err.message}; is Docker Desktop running?`, req.path),
        );
      const r = httpRequest(
        {
          socketPath: this.socketPath,
          method: req.method,
          path,
          headers: {
            host: "docker",
            ...(body === undefined
              ? {}
              : { "content-type": "application/json", "content-length": Buffer.byteLength(body) }),
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
            if (status >= 400) {
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
      r.on("error", unreachable);
      if (body !== undefined) r.write(body);
      r.end();
    });
  }

  version(): Promise<DockerVersion> {
    return this.request<DockerVersion>({ method: "GET", path: "/version" });
  }
}

function messageOf(text: string): string {
  try {
    return (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    return text || "no message";
  }
}
