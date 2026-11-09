import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRoleChoice } from "@localdot/protocol";
import { z } from "zod";

export const ShareOptions = z.strictObject({
  label: z.string().trim().min(1).max(80),
  expiresInHours: z.number().int().min(1).max(87600).nullable(),
  replay: z.boolean().default(false),
  settings: z.boolean().default(false),
  chooseModel: z.boolean().default(false),
  maxTasks: z.number().int().min(1).max(10000).nullable(),
  taskBudgetUSD: z.number().min(0.01).max(10000).default(5),
  model: AgentRoleChoice,
  models: z.array(AgentRoleChoice).max(32).default([]),
});
const Grant = ShareOptions.omit({ expiresInHours: true }).extend({
  id: z.string().regex(/^[a-f0-9]{24}$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number(),
  expiresAt: z.number().nullable(),
  revoked: z.boolean(),
  tasks: z.number().int().nonnegative(),
  sessions: z.array(z.string()).max(10000),
});
export type RemoteGrant = z.infer<typeof Grant>;
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const TASK = /^\/api\/(?:agent\/)?(?:sessions|conversations)\/([^/]*)/;
const RECORDINGS =
  /^\/api\/sessions(?:\/[0-9A-Z]{26}(?:\/(?:card|recording|manifest|fragments|frames|thumbs|thumbnail|summary|events|history|replay)(?:\/[a-zA-Z0-9._-]+)*)?)?$/;
export const publicGrant = ({ digest: _secret, sessions: _sessions, ...grant }: RemoteGrant) =>
  grant;
declare module "hono" {
  interface ContextVariableMap {
    remoteGrant: RemoteGrant | undefined;
    remoteValid: (() => boolean) | undefined;
  }
}

// Persist only hashes. Revocation and quotas are committed before a request is admitted.
// Link recipients share this computer and its chat; this is not tenant/file isolation.
export class RemoteLinks {
  private rows: RemoteGrant[] = [];
  private listeners = new Set<(id: string) => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private file: string;
  private unreadable = false;
  private shown: () => readonly string[] = () => [];
  constructor(
    home: string,
    private now = Date.now,
  ) {
    this.file = join(home, "remote-links.json");
    try {
      if (existsSync(this.file))
        this.rows = z
          .array(Grant)
          .max(128)
          .parse(JSON.parse(readFileSync(this.file, "utf8")));
    } catch {
      this.unreadable = true;
      console.error("Shared link records could not be read; shared access is disabled.");
    }
    for (const row of this.rows) this.arm(row);
  }
  private save(rows: RemoteGrant[]) {
    if (this.unreadable)
      throw new Error("Shared link records need repair before they can be changed");
    const temp = `${this.file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(rows), { mode: 0o600, flag: "wx" });
      renameSync(temp, this.file);
      this.rows = rows;
    } finally {
      rmSync(temp, { force: true });
    }
  }
  private arm(row: RemoteGrant) {
    clearTimeout(this.timers.get(row.id));
    if (row.revoked || row.expiresAt === null) return;
    const remaining = row.expiresAt - this.now();
    if (remaining <= 0) {
      for (const fn of this.listeners) fn(row.id);
      return;
    }
    const timer = setTimeout(
      () => this.arm(this.rows.find((g) => g.id === row.id) ?? row),
      Math.min(remaining, 2147483647),
    );
    timer.unref();
    this.timers.set(row.id, timer);
  }
  valid(row: RemoteGrant) {
    return !row.revoked && (row.expiresAt === null || row.expiresAt > this.now());
  }
  active(id: string) {
    const row = this.rows.find((r) => r.id === id);
    return row && this.valid(row) ? row : undefined;
  }
  authenticate(token: string | undefined): RemoteGrant | undefined {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const row = this.rows.find((r) => r.digest === digest(token));
    return row && this.valid(row) ? row : undefined;
  }
  list() {
    return this.rows.map(publicGrant);
  }
  sessions(id: string) {
    return this.rows.find((r) => r.id === id)?.sessions ?? [];
  }
  create(input: unknown) {
    const options = ShareOptions.parse(input);
    if (this.rows.filter((r) => this.valid(r)).length >= 64)
      throw new Error("Too many active links");
    const token = randomBytes(32).toString("base64url");
    const { expiresInHours, ...rest } = options;
    const row = Grant.parse({
      ...rest,
      id: randomBytes(12).toString("hex"),
      digest: digest(token),
      createdAt: this.now(),
      expiresAt: expiresInHours === null ? null : this.now() + expiresInHours * 3600000,
      revoked: false,
      tasks: 0,
      sessions: [],
    });
    this.save([...this.rows.filter((r) => this.valid(r)).slice(-127), row]);
    this.arm(row);
    return { token, grant: publicGrant(row) };
  }
  revoke(id: string) {
    if (!this.rows.some((r) => r.id === id)) return false;
    this.save(this.rows.map((r) => (r.id === id ? { ...r, revoked: true } : r)));
    clearTimeout(this.timers.get(id));
    for (const fn of this.listeners) fn(id);
    return true;
  }
  onRevoke(fn: (id: string) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  close() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
  select(id: string, index: number) {
    const row = this.active(id);
    const model = row?.models[index];
    if (!row?.chooseModel || !model) throw new Error("Model is not allowed by this link");
    this.save(this.rows.map((r) => (r.id === id ? { ...r, model } : r)));
  }
  reserve(id: string) {
    const row = this.active(id);
    if (!row || (row.maxTasks !== null && row.tasks >= row.maxTasks))
      throw new Error("This link has reached its task limit or expired.");
    this.save(this.rows.map((r) => (r.id === id ? { ...r, tasks: r.tasks + 1 } : r)));
    let settled = false;
    return {
      model: row.model,
      budgetUSD: row.taskBudgetUSD,
      finish: (sessionId?: string) => {
        if (settled) return;
        settled = true;
        this.save(
          this.rows.map((r) =>
            r.id !== id
              ? r
              : sessionId
                ? { ...r, sessions: [...r.sessions.slice(-9999), sessionId] }
                : { ...r, tasks: Math.max(0, r.tasks - 1) },
          ),
        );
      },
    };
  }
  owns(id: string, session: string) {
    return !!this.active(id)?.sessions.includes(session);
  }
  // The tasks of the conversation the owner's app shows, which every link shares.
  showing(tasks: () => readonly string[]) {
    this.shown = tasks;
  }
  sees(id: string, session: string) {
    if (this.owns(id, session)) return true;
    try {
      return !!this.active(id) && this.shown().includes(session);
    } catch {
      return false;
    }
  }
  // A small explicit allowlist: new owner endpoints stay private by default. A path that names a
  // task answers for that task, whichever rule lets it through: a link changes only its own tasks
  // and reads those and the conversation the owner's app shows. Replay adds every task's recording.
  permits(row: RemoteGrant, method: string, path: string): boolean {
    if (!this.active(row.id)) return false;
    const task = TASK.exec(path)?.[1];
    if (method === "GET" || method === "HEAD") {
      if (row.replay && (RECORDINGS.test(path) || path === "/api/session-index")) return true;
      if (task !== undefined && !this.sees(row.id, task)) return false;
      return (
        /^\/api\/(whoami|clock|remote-session|cells|runtime|conversation)$/.test(path) ||
        /^\/api\/cells\/[0-9A-Z]{26}(?:\/(?:live|status))?$/.test(path) ||
        /^\/api\/browsers\/[0-9A-Z]{26}(?:\/status)?$/.test(path) ||
        /^\/api\/agent\/sessions\/[0-9A-Z]{26}$/.test(path) ||
        /^\/api\/sessions\/[0-9A-Z]{26}\/(?:events|history|stream|clock)$/.test(path)
      );
    }
    if (method !== "POST") return false;
    if (task !== undefined && !this.owns(row.id, task)) return false;
    if (path === "/api/remote-session/model") return row.chooseModel;
    return (
      /^\/api\/cells\/[0-9A-Z]{26}\/(?:agent|stream-ticket|browser-stream-ticket)$/.test(path) ||
      path === "/api/conversation/new" ||
      /^\/api\/agent\/sessions\/[0-9A-Z]{26}\/(?:messages|stop|answer)$/.test(path)
    );
  }
}
