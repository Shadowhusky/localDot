import { lstatSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import {
  type KeydAsk,
  KeydAsks,
  KeydBudget,
  KeydCellInfo,
  KeydErrorBody,
  KeydEvent,
  KeydMinted,
  KeydOpened,
  KeydPushKey,
  KeydPushRequest,
  KeydPushSent,
  KeydRecord,
  KeydRevoked,
  type KeydRouteModel,
  KeydRouteModels,
  KeydSecrets,
  KeydStatus,
  KeydVault,
  ModelAdmissionSnapshot,
  ModelAdmissionWrite,
  type Sealed,
  type SecretBinding,
  type TaskPricing,
} from "@localdot/protocol";
import { z } from "zod";

export function keydSocketPath(home: string): string {
  return join(home, "keyd", "admin.sock");
}

export class KeydError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly path: string,
  ) {
    super(`keyd ${status || "unreachable"} ${code} on ${path}: ${detail}`);
    this.name = "KeydError";
  }
}

// keyd is not running, its socket is gone, or it did not answer in time: the key layer is offline.
export class KeydUnavailableError extends KeydError {
  constructor(detail: string, path: string) {
    super(0, "unavailable", detail, path);
    this.name = "KeydUnavailableError";
  }
}

// Whoever answers on this path receives sealed keys and hands the UI the key to seal them to, so
// the daemon talks only to a socket that this user owns and nobody else can reach: a socket of
// mode 0600 (no group or other bits) in a directory of this user with no group or other bits.
export function privateSocketProblem(socketPath: string): string | undefined {
  const uid = process.getuid?.();
  const check = (path: string, kind: "socket" | "directory") => {
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (!st) return kind === "socket" ? undefined : `${path} does not exist`;
    if (kind === "socket" ? !st.isSocket() : !st.isDirectory()) return `${path} is not a ${kind}`;
    if (uid !== undefined && st.uid !== uid) return `${path} belongs to another user`;
    if (st.mode & 0o077)
      return `${path} is open to other users (mode ${(st.mode & 0o777).toString(8)})`;
    return undefined;
  };
  try {
    return check(dirname(socketPath), "directory") ?? check(socketPath, "socket");
  } catch {
    return "keyd socket metadata could not be read";
  }
}

export type CellRole = "brain" | "desktop" | "browser" | "judge" | "connector";

export interface OpenCellRequest {
  cellId: string;
  role: CellRole;
  port: number;
  secrets: string[];
  // A desktop gate's credential for the connections it captures, kept for the cell's life.
  captureToken?: string;
}

interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

interface Reply {
  status: number;
  text: string;
}

const segment = (value: string) => encodeURIComponent(value);
const MAX_REPLY_BYTES = 1024 * 1024;
const MAX_EVENT_LINE_BYTES = 64 * 1024;

// HTTP/1.1 on keyd's 0600 admin socket (Part 4a, "Admin API"). Every reply is validated, and
// anything unexpected is an error, never a guess.
export class KeydClient {
  constructor(
    readonly socketPath: string,
    private readonly timeoutMs = 5000,
  ) {}

  status(): Promise<KeydStatus> {
    return this.#json("GET", "/v1/status", undefined, KeydStatus);
  }

  async login(origin: string): Promise<{ username: string; password: string } | undefined> {
    try {
      return await this.#json(
        "POST",
        "/v1/logins",
        { origin },
        z.strictObject({ username: z.string().max(2000), password: z.string().min(1).max(1000) }),
      );
    } catch (error) {
      if (error instanceof KeydError && error.status === 404) return undefined;
      throw new Error("Saved sign-in is unavailable.");
    }
  }

  async saveLogin(origin: string, username: string, password: string): Promise<void> {
    try {
      await this.#json(
        "PUT",
        "/v1/logins",
        { origin, username, password },
        z.strictObject({ ok: z.literal(true) }),
      );
    } catch {
      throw new Error("The sign-in could not be saved.");
    }
  }

  // The passphrase arrives sealed to keyd, so this daemon never reads it. A new vault takes the
  // first passphrase it receives as its own.
  unlockVault(sealed: Sealed): Promise<KeydVault> {
    return this.#json("POST", "/v1/vault/unlock", { sealed }, KeydVault);
  }

  async secrets(): Promise<KeydRecord[]> {
    return (await this.#json("GET", "/v1/secrets", undefined, KeydSecrets)).secrets ?? [];
  }

  // The binding goes to keyd exactly as the UI sealed it: keyd rebuilds the AAD from these fields,
  // so the daemon must not change, add or drop a single value.
  putSecret(binding: SecretBinding, sealed: Sealed): Promise<KeydRecord> {
    const { id, ...fields } = binding;
    return this.#json("PUT", `/v1/secrets/${segment(id)}`, { ...fields, sealed }, KeydRecord);
  }

  async deleteSecret(id: string): Promise<boolean> {
    const path = `/v1/secrets/${segment(id)}`;
    const reply = await this.#send("DELETE", path);
    if (reply.status === 404) return false;
    this.#check(reply, path);
    return true;
  }

  openCell(req: OpenCellRequest): Promise<KeydOpened> {
    return this.#json("POST", "/v1/cells", req, KeydOpened);
  }

  // The connections the cell's listener holds for the user's answer.
  async asks(cellId: string): Promise<KeydAsk[]> {
    return (
      (await this.#json("GET", `/v1/cells/${segment(cellId)}/asks`, undefined, KeydAsks)).asks ?? []
    );
  }

  // A held connection that keyd let go of meanwhile is answered with 404, which is not an error.
  async answerAsk(
    cellId: string,
    askId: string,
    decision: "allow" | "deny",
    app?: string,
  ): Promise<void> {
    const path = `/v1/cells/${segment(cellId)}/asks/${segment(askId)}`;
    const reply = await this.#send("POST", path, { decision, ...(app ? { app } : {}) });
    if (reply.status !== 404) this.#check(reply, path);
  }

  async cell(id: string): Promise<KeydCellInfo | undefined> {
    const path = `/v1/cells/${segment(id)}`;
    const reply = await this.#send("GET", path);
    if (reply.status === 404) return undefined;
    return this.#parse(reply, path, KeydCellInfo);
  }

  async closeCell(id: string): Promise<boolean> {
    const path = `/v1/cells/${segment(id)}`;
    const reply = await this.#send("DELETE", path);
    if (reply.status === 404) return false;
    this.#check(reply, path);
    return true;
  }

  // The kill switch: the cell's surrogates, task, upstream connections and tunnels end at once.
  async revoke(id: string): Promise<number> {
    return (await this.#json("POST", `/v1/cells/${segment(id)}/revoke`, undefined, KeydRevoked))
      .revoked;
  }

  async mint(id: string, secrets: string[]): Promise<Record<string, string>> {
    const path = `/v1/cells/${segment(id)}/surrogates`;
    return (await this.#json("POST", path, { secrets }, KeydMinted)).surrogates ?? {};
  }

  async beginTask(cellId: string, taskId: string, budgetUSD?: number): Promise<void> {
    checkTask(taskId, budgetUSD);
    const path = `/v1/cells/${segment(cellId)}/task`;
    this.#check(
      await this.#send("PUT", path, { taskId, ...(budgetUSD === undefined ? {} : { budgetUSD }) }),
      path,
    );
  }

  // New agent sessions must initialize immutable pricing; legacy beginTask remains available
  // only for explicit legacy/admin callers. Equal retries retain the server's raised ceiling.
  async beginPricedTask(
    cellId: string,
    taskId: string,
    pricing: TaskPricing,
    budgetUSD?: number,
  ): Promise<void> {
    checkTask(taskId, budgetUSD);
    const path = `/v1/cells/${segment(cellId)}/task`;
    this.#check(
      await this.#send("PUT", path, {
        taskId,
        pricing,
        ...(budgetUSD === undefined ? {} : { budgetUSD }),
      }),
      path,
    );
  }

  async modelAdmission(cellId: string): Promise<ModelAdmissionSnapshot> {
    return this.#json(
      "GET",
      `/v1/cells/${segment(cellId)}/model-admission`,
      undefined,
      ModelAdmissionSnapshot,
    );
  }
  async setModelAdmission(
    cellId: string,
    write: ModelAdmissionWrite,
  ): Promise<ModelAdmissionSnapshot> {
    return this.#json(
      "PUT",
      `/v1/cells/${segment(cellId)}/model-admission`,
      ModelAdmissionWrite.parse(write),
      ModelAdmissionSnapshot,
    );
  }
  async endTask(cellId: string): Promise<void> {
    const path = `/v1/cells/${segment(cellId)}/task`;
    const reply = await this.#send("DELETE", path);
    if (reply.status !== 404) this.#check(reply, path);
  }

  async routeModels(route: string): Promise<KeydRouteModel[]> {
    const path = `/v1/llm/routes/${segment(route)}/models`;
    const result = await this.#json("GET", path, undefined, KeydRouteModels);
    if (result.route !== route)
      throw new KeydError(200, "bad-reply", "route identity mismatch", path);
    return result.models ?? [];
  }

  async setRouteModels(route: string, models: KeydRouteModel[]): Promise<KeydRouteModel[]> {
    const path = `/v1/llm/routes/${segment(route)}/models`;
    const result = await this.#json("PUT", path, { models }, KeydRouteModels);
    if (result.route !== route)
      throw new KeydError(200, "bad-reply", "route identity mismatch", path);
    return result.models ?? [];
  }

  // keyd's Web Push key (the browsers' applicationServerKey). keyd makes it on first use.
  pushKey(): Promise<KeydPushKey> {
    return this.#json("GET", "/v1/push/key", undefined, KeydPushKey);
  }

  // keyd signs the VAPID token itself and sends the ciphertext to the push service named by the
  // endpoint; the daemon never holds the signing key or the token.
  async pushSend(request: KeydPushRequest): Promise<KeydPushSent> {
    return this.#json("POST", "/v1/push/send", KeydPushRequest.parse(request), KeydPushSent);
  }

  budget(): Promise<KeydBudget> {
    return this.#json("GET", "/v1/budget", undefined, KeydBudget);
  }

  // A limit of 0 is none.
  setBudget(perTaskUSD: number, perDayUSD: number): Promise<KeydBudget> {
    const limit = (usd: number) => Number.isFinite(usd) && usd >= 0 && usd <= 10_000;
    if (!limit(perTaskUSD) || !limit(perDayUSD) || (perDayUSD > 0 && perTaskUSD > perDayUSD))
      throw new RangeError("budget limits must be 0 (none) to 10000, per task within per day");
    return this.#json("PUT", "/v1/budget", { perTaskUSD, perDayUSD }, KeydBudget);
  }

  // Resolves when the stream ends (keyd stopped, or the signal aborted it). A line that is not a
  // known event is dropped: the stream is best effort and keyd's audit log is the record.
  events(onEvent: (event: KeydEvent) => void, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    const path = "/v1/events";
    const unsafe = privateSocketProblem(this.socketPath);
    if (unsafe) return Promise.reject(new KeydUnavailableError(`refusing ${unsafe}`, path));
    return new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        { socketPath: this.socketPath, method: "GET", path, headers: { host: "keyd" } },
        (res) => {
          clearTimeout(deadline);
          if (res.statusCode !== 200) {
            reject(
              new KeydError(res.statusCode ?? 0, "events", "the event stream was refused", path),
            );
            req.destroy();
            return;
          }
          let buffered = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            buffered += chunk;
            for (let nl = buffered.indexOf("\n"); nl >= 0; nl = buffered.indexOf("\n")) {
              if (signal.aborted) return;
              if (Buffer.byteLength(buffered.slice(0, nl)) > MAX_EVENT_LINE_BYTES) {
                reject(new KeydError(200, "bad-reply", "keyd's event line is too large", path));
                req.destroy();
                return;
              }
              const line = buffered.slice(0, nl).trim();
              buffered = buffered.slice(nl + 1);
              const parsed = KeydEvent.safeParse(safeJson(line));
              if (parsed.success) {
                try {
                  onEvent(parsed.data);
                } catch {
                  reject(new KeydError(200, "event-handler", "the key event handler failed", path));
                  req.destroy();
                  return;
                }
              }
            }
            if (Buffer.byteLength(buffered) > MAX_EVENT_LINE_BYTES) {
              reject(new KeydError(200, "bad-reply", "keyd's event line is too large", path));
              req.destroy();
            }
          });
          res.on("end", () => resolve());
          res.on("error", () => resolve());
        },
      );
      // Only the handshake has a deadline; a healthy event stream can be idle.
      const deadline = setTimeout(
        () => req.destroy(new Error(`no event handshake within ${this.timeoutMs} ms`)),
        this.timeoutMs,
      );
      const abort = () => req.destroy();
      signal.addEventListener("abort", abort, { once: true });
      req.on("close", () => {
        clearTimeout(deadline);
        signal.removeEventListener("abort", abort);
        resolve();
      });
      req.on("error", (err: NodeJS.ErrnoException) => {
        if (signal.aborted) resolve();
        else reject(new KeydUnavailableError(err.code ?? err.message, path));
      });
      if (signal.aborted) abort();
      req.end();
    });
  }

  async #json<T>(method: string, path: string, body: unknown, schema: Schema<T>): Promise<T> {
    return this.#parse(await this.#send(method, path, body), path, schema);
  }

  #parse<T>(reply: Reply, path: string, schema: Schema<T>): T {
    this.#check(reply, path);
    const parsed = schema.safeParse(safeJson(reply.text));
    if (!parsed.success) {
      throw new KeydError(reply.status, "bad-reply", "keyd answered something unexpected", path);
    }
    return parsed.data;
  }

  #check(reply: Reply, path: string): void {
    if (reply.status >= 200 && reply.status < 300) return;
    const body = KeydErrorBody.safeParse(safeJson(reply.text));
    const { code, message } = body.success
      ? body.data.error
      : { code: "internal", message: "keyd returned an invalid error reply" };
    throw new KeydError(reply.status, code, message, path);
  }

  #send(method: string, path: string, body?: unknown): Promise<Reply> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const unsafe = privateSocketProblem(this.socketPath);
    if (unsafe) return Promise.reject(new KeydUnavailableError(`refusing ${unsafe}`, path));
    return new Promise<Reply>((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: this.socketPath,
          method,
          path,
          headers: {
            host: "keyd",
            ...(payload === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(payload),
                }),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on("data", (c: Buffer) => {
            bytes += c.byteLength;
            if (bytes > MAX_REPLY_BYTES) {
              reject(
                new KeydError(res.statusCode ?? 0, "bad-reply", "keyd's reply is too large", path),
              );
              req.destroy();
              return;
            }
            chunks.push(c);
          });
          res.on("error", (err) => reject(new KeydUnavailableError(err.message, path)));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
          );
        },
      );
      // Socket inactivity timeouts can be extended forever by a trickling reply.
      const deadline = setTimeout(
        () => req.destroy(new Error(`no complete answer within ${this.timeoutMs} ms`)),
        this.timeoutMs,
      );
      req.once("close", () => clearTimeout(deadline));
      req.on("error", (err: NodeJS.ErrnoException) =>
        reject(new KeydUnavailableError(err.code ?? err.message, path)),
      );
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function checkTask(taskId: string, budgetUSD?: number): void {
  if (!taskId || Buffer.byteLength(taskId) > 128) throw new RangeError("invalid task identity");
  if (
    budgetUSD !== undefined &&
    (!Number.isFinite(budgetUSD) || budgetUSD < 0 || budgetUSD > 10_000)
  )
    throw new RangeError("invalid task budget");
}
