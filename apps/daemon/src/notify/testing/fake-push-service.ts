import { createPublicKey, verify } from "node:crypto";
import { createServer, type Server } from "node:http";

export interface PushDelivery {
  path: string;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

// A stand-in for a browser vendor's push service on 127.0.0.1 (port 0). Each path answers 201
// unless told otherwise: statuses.set("/gone-device", 410).
export interface FakePushService {
  url: string;
  received: PushDelivery[];
  statuses: Map<string, number>;
  close(): Promise<void>;
}

export async function startFakePushService(): Promise<FakePushService> {
  const received: PushDelivery[] = [];
  const statuses = new Map<string, number>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const path = req.url ?? "/";
      received.push({
        path,
        headers: {
          authorization: req.headers.authorization,
          "content-encoding": req.headers["content-encoding"],
          ttl: req.headers.ttl as string | undefined,
          urgency: req.headers.urgency as string | undefined,
          topic: req.headers.topic as string | undefined,
        },
        body: Buffer.concat(chunks),
      });
      res.writeHead(statuses.get(path) ?? 201);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    statuses,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// Checks an RFC 8292 "vapid t=…, k=…" header against the expected key; returns the claims.
export function verifyVapid(
  authorization: string | undefined,
  publicKey: string,
): Record<string, unknown> | null {
  const match = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(authorization ?? "");
  if (!match?.[1] || match[2] !== publicKey) return null;
  const [header, claims, signature] = match[1].split(".");
  if (!header || !claims || !signature) return null;
  const point = Buffer.from(publicKey, "base64url");
  const key = createPublicKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33).toString("base64url"),
    },
  });
  const ok = verify(
    "sha256",
    Buffer.from(`${header}.${claims}`),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"),
  );
  return ok
    ? (JSON.parse(Buffer.from(claims, "base64url").toString()) as Record<string, unknown>)
    : null;
}
