import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOST_SUFFIX, SECRET } from "@localdot/protocol/remote";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { registerPublicOrigin } from "../guard.ts";
import type { InstallCodes } from "../install-codes.ts";
import { connectRemote } from "./connector.ts";

interface Saved {
  enabled: boolean;
  owner: string;
  access: string;
  domain: string;
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = () => randomBytes(32).toString("hex");
export function remoteDomain(value: string | undefined): string | null {
  if (!value) return null;
  const domain = value.toLowerCase();
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) ||
    domain.length > 200
  )
    throw new Error("Invalid remote access domain");
  return domain;
}
// The bundled relay is available on every platform, but no connection starts before opt-in.
// Explicit operator overrides take precedence, including an empty value that disables the service.
const DEFAULT_REMOTE_DOMAIN = "localdot.dev";
// Managed services use a clean environment. This operator-owned file also works in packaged apps.
export function configuredRemoteDomain(home: string): string | null {
  try {
    const file = join(home, "remote-service.json");
    const value =
      process.env.LOCALDOT_REMOTE_DOMAIN ??
      (existsSync(file)
        ? (JSON.parse(readFileSync(file, "utf8")) as { domain?: string }).domain
        : DEFAULT_REMOTE_DOMAIN);
    return remoteDomain(value);
  } catch {
    return null;
  }
}
export class RemoteAccess {
  private saved: Saved;
  private file: string;
  private stop?: () => void;
  private unregister?: () => void;
  private state: "off" | "connecting" | "online" | "offline" = "off";
  constructor(
    home: string,
    private port: number,
    private domain: string | null,
    private codes: InstallCodes,
  ) {
    this.file = join(home, "remote-access.json");
    this.saved = { enabled: false, owner: secret(), access: secret(), domain: domain ?? "" };
    if (existsSync(this.file)) {
      try {
        const v = JSON.parse(readFileSync(this.file, "utf8")) as Saved;
        if (
          !SECRET.test(v.owner) ||
          !SECRET.test(v.access) ||
          typeof v.enabled !== "boolean" ||
          typeof v.domain !== "string"
        )
          throw new Error("Invalid remote access configuration");
        this.saved = v;
        // An operator changing services cannot silently disclose this installation to a new one.
        if (v.domain !== domain) this.saved.enabled = false;
      } catch {
        // Fail closed without taking local access down if this optional configuration is corrupt.
      }
    }
  }
  private origin(): string {
    return `https://${hash(this.saved.owner).slice(0, 32)}${HOST_SUFFIX}.${this.domain}`;
  }
  snapshot() {
    return {
      supported: !!this.domain,
      enabled: this.saved.enabled,
      state: this.state,
      url: this.saved.enabled ? this.origin() : null,
      detail: this.domain
        ? "Remote connections pass through the localDot relay. Your computer must stay on."
        : "The custom relay address is missing or invalid. Correct remote-service.json in your localDot data folder, or remove the override to use localDot’s relay, then restart localDot.",
    };
  }
  start(): void {
    if (!this.saved.enabled || !this.domain || this.stop) return;
    this.unregister = registerPublicOrigin(this.origin());
    this.stop = connectRemote({
      origin: this.origin(),
      owner: this.saved.owner,
      accessHash: hash(this.saved.access),
      port: this.port,
      status: (state) => {
        this.state = state;
      },
    });
  }
  close(): void {
    this.stop?.();
    this.stop = undefined;
    this.unregister?.();
    this.unregister = undefined;
    this.state = "off";
  }
  configure(enabled: boolean): void {
    if (!this.domain) throw new Error("Remote access is not configured");
    if (enabled === this.saved.enabled && this.saved.domain === this.domain) return;
    const changedService = this.saved.domain !== this.domain;
    const next: Saved = {
      ...this.saved,
      enabled,
      domain: this.domain,
      owner: changedService ? secret() : this.saved.owner,
      access: changedService || !enabled ? secret() : this.saved.access,
    };
    // Persist the decision before changing a live connection. A failed save must not silently
    // re-enable remote access at the next launch. Exclusive temp creation preserves mode 0600.
    const temp = `${this.file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(next)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temp, this.file);
    } finally {
      rmSync(temp, { force: true });
    }
    this.close();
    this.saved = next;
    this.start();
  }
  link() {
    if (this.state !== "online") throw new Error("Wait until remote access is connected");
    const { code, expiresAt } = this.codes.issue();
    return {
      url: `${this.origin()}/_remote/pair#remote=${this.saved.access}&code=${code}`,
      expiresAt,
    };
  }
}
export function remoteRoutes(app: Hono, remote: RemoteAccess): void {
  app.use("/api/remote-access*", async (c, next) => {
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    await next();
  });
  app.get("/api/remote-access", (c) => c.json(remote.snapshot()));
  app.put("/api/remote-access", bodyLimit({ maxSize: 64 }), async (c) => {
    // This API accepts only a boolean; the browser cannot point the host at arbitrary servers.
    const raw = await c.req.text();
    if (raw.length > 64) return c.text("Invalid request", 400);
    try {
      const v = JSON.parse(raw) as { enabled?: boolean };
      if (typeof v.enabled !== "boolean" || Object.keys(v).length !== 1)
        return c.text("Invalid request", 400);
      remote.configure(v.enabled);
      return c.json(remote.snapshot());
    } catch {
      return c.text("Remote access could not be updated", 503);
    }
  });
  app.post("/api/remote-access/link", (c) => {
    try {
      return c.json(remote.link());
    } catch {
      return c.text("Remote access is not connected yet", 409);
    }
  });
}
