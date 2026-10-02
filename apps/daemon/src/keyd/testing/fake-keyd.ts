import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { HairpinGuard, KeydEvent, KeydOpened, KeydRecord } from "@localdot/protocol";

// A stand-in for keyd's admin API on a temporary Unix socket, for unit tests: it keeps secrets'
// records (never values: a sealed body is only recorded), cells and an event stream, and can be
// told to fail. The real keyd is exercised by the *.keyd.test.ts and *.docker.test.ts suites.

export interface FakeCell {
  cellId: string;
  role: string;
  port: number;
  secrets: string[];
  // The newest surrogate of each key.
  surrogates: Record<string, string>;
  // Every surrogate keyd still accepts for the cell: minting adds one, only a revoke ends them.
  valid: Set<string>;
  revoked: number;
}

export interface FakeCall {
  method: string;
  path: string;
  body: unknown;
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const base62 = (n: number) => Array.from(randomBytes(n), (b) => BASE62[b % 62]).join("");

export function fakeSurrogate(): string {
  return `ld_key_${base62(22)}_${base62(6)}`;
}

export const FAKE_SEAL_KEY =
  "BG2x8-BG3l6OwZSDEY2jv15f49mKcudyq5wvNeAMGomjt95F3U2ihX3pW1kqXeAogtDMs6rhGvlhvnCeU3XFwgM";
export const FAKE_CA_PEM =
  "-----BEGIN CERTIFICATE-----\nMIIBfakecellca\n-----END CERTIFICATE-----\n";

export class FakeKeyd {
  readonly calls: FakeCall[] = [];
  readonly records = new Map<string, KeydRecord>();
  readonly cells = new Map<string, FakeCell>();
  bootId = randomBytes(8).toString("hex");
  auditOk = true;
  hairpin: HairpinGuard = { state: "active", source: "nat-pmp", addresses: 1 };
  // Answers the next request whose "METHOD /path" starts with the key with this error.
  readonly failures = new Map<string, { status: number; code: string }>();
  readonly #streams = new Set<ServerResponse>();
  readonly #dir: string;
  readonly socketPath: string;
  #server: Server | undefined;

  constructor() {
    this.#dir = mkdtempSync("/tmp/ld-fake-keyd-");
    this.socketPath = join(this.#dir, "admin.sock");
  }

  async start(): Promise<this> {
    const server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((resolve) => server.listen(this.socketPath, resolve));
    // As keyd does: the daemon talks only to a private socket.
    chmodSync(this.socketPath, 0o600);
    this.#server = server;
    return this;
  }

  publish(event: KeydEvent): void {
    for (const res of this.#streams) res.write(`${JSON.stringify(event)}\n`);
  }

  get subscribers(): number {
    return this.#streams.size;
  }

  // keyd restarted: a new boot, every cell gone, every event stream ended.
  restart(): void {
    this.bootId = randomBytes(8).toString("hex");
    this.cells.clear();
    for (const res of this.#streams) res.end();
    this.#streams.clear();
  }

  async stop(): Promise<void> {
    for (const res of this.#streams) res.end();
    this.#streams.clear();
    await new Promise<void>((resolve) =>
      this.#server ? this.#server.close(() => resolve()) : resolve(),
    );
    this.#server = undefined;
  }

  async close(): Promise<void> {
    await this.stop();
    rmSync(this.#dir, { recursive: true, force: true });
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let text = "";
    for await (const chunk of req) text += chunk;
    const method = req.method ?? "";
    const path = new URL(req.url ?? "/", "http://keyd").pathname;
    const body = text ? (JSON.parse(text) as unknown) : undefined;
    this.calls.push({ method, path, body });
    for (const [key, failure] of this.failures) {
      if (`${method} ${path}`.startsWith(key)) {
        this.failures.delete(key);
        reply(res, failure.status, {
          error: { code: failure.code, message: `fake ${failure.code}` },
        });
        return;
      }
    }
    this.#route(method, path, body, res);
  }

  #route(method: string, path: string, body: unknown, res: ServerResponse): boolean {
    if (method === "GET" && path === "/v1/status") {
      return reply(res, 200, {
        bootId: this.bootId,
        version: "0.1.0",
        sealKey: FAKE_SEAL_KEY,
        cells: this.cells.size,
        secrets: this.records.size,
        limits: { perTaskUSD: 5, perDayUSD: 20 },
        day: { date: "2026-10-01", spentUSD: 0 },
        audit: this.auditOk ? { ok: true } : { ok: false, error: "disk full" },
        hairpin: this.hairpin,
      });
    }
    if (method === "GET" && path === "/v1/secrets")
      return reply(res, 200, { secrets: [...this.records.values()] });
    if (method === "GET" && path === "/v1/events") {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.flushHeaders();
      this.#streams.add(res);
      res.on("close", () => this.#streams.delete(res));
      return true;
    }
    const secret = /^\/v1\/secrets\/([^/]+)$/.exec(path);
    if (secret) {
      const id = decodeURIComponent(secret[1] ?? "");
      if (method === "DELETE") {
        if (!this.records.delete(id))
          return reply(res, 404, { error: { code: "not-found", message: "no such secret" } });
        return reply(res, 204);
      }
      if (method === "PUT") {
        const { sealed: _sealed, ...fields } = body as Record<string, unknown>;
        const now = new Date().toISOString();
        const record = {
          id,
          ...fields,
          createdAt: this.records.get(id)?.createdAt ?? now,
          updatedAt: now,
        } as KeydRecord;
        this.records.set(id, record);
        return reply(res, 200, record);
      }
    }
    if (method === "POST" && path === "/v1/cells") {
      const req = body as { cellId: string; role: string; port: number; secrets: string[] };
      if (this.cells.has(req.cellId))
        return reply(res, 409, { error: { code: "conflict", message: "cell is open" } });
      const unknown = req.secrets.find((id) => !this.records.has(id));
      if (unknown)
        return reply(res, 400, {
          error: { code: "bad-request", message: `unknown secret ${unknown}` },
        });
      const surrogates = Object.fromEntries(req.secrets.map((id) => [id, fakeSurrogate()]));
      this.cells.set(req.cellId, {
        ...req,
        surrogates,
        valid: new Set(Object.values(surrogates)),
        revoked: 0,
      });
      const opened: KeydOpened = {
        cellId: req.cellId,
        port: req.port,
        proxyToken: randomBytes(32).toString("base64url"),
        caCertPem: FAKE_CA_PEM,
        caPath: `/tmp/keyd/cells/${req.cellId}/ca.pem`,
        surrogates,
      };
      return reply(res, 201, opened);
    }
    const cell = /^\/v1\/cells\/([^/]+)(\/revoke|\/surrogates)?$/.exec(path);
    if (cell) {
      const id = decodeURIComponent(cell[1] ?? "");
      const found = this.cells.get(id);
      if (!found) return reply(res, 404, { error: { code: "not-found", message: "no such cell" } });
      if (method === "GET" && !cell[2]) {
        return reply(res, 200, {
          cellId: id,
          role: found.role,
          port: found.port,
          intercepts: [],
          surrogates: Object.keys(found.surrogates).map((secretId) => ({
            secretId,
            surrogateId: "0123456789ab",
          })),
        });
      }
      if (method === "DELETE" && !cell[2]) {
        this.cells.delete(id);
        return reply(res, 204);
      }
      if (method === "POST" && cell[2] === "/revoke") {
        const revoked = found.valid.size;
        found.surrogates = {};
        found.valid.clear();
        found.revoked += 1;
        return reply(res, 200, { revoked });
      }
      if (method === "POST" && cell[2] === "/surrogates") {
        const { secrets } = body as { secrets: string[] };
        const minted = Object.fromEntries(secrets.map((s) => [s, fakeSurrogate()]));
        found.surrogates = { ...found.surrogates, ...minted };
        for (const value of Object.values(minted)) found.valid.add(value);
        return reply(res, 200, { surrogates: minted });
      }
    }
    return reply(res, 404, {
      error: { code: "not-found", message: `fake keyd: no route ${method} ${path}` },
    });
  }
}

function reply(res: ServerResponse, status: number, body?: unknown): true {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return true;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
  return true;
}

export async function startFakeKeyd(): Promise<FakeKeyd> {
  return new FakeKeyd().start();
}
