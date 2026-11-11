import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRoleChoice, ModelOptions } from "@localdot/protocol";
import { z } from "zod";

export const ShareOptions = z.strictObject({
  label: z.string().trim().min(1).max(80),
  expiresInHours: z.number().int().min(1).max(87600).nullable(),
  replay: z.boolean().default(false),
  settings: z.boolean().default(false),
  chooseModel: z.boolean().default(false),
  // The owner's connected apps, saved keys and signed-in web browser, for the link's tasks.
  apps: z.boolean().default(false),
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

interface ConversationChains {
  has(sessionId: string): boolean;
  latest(sessionId: string): string;
  snapshotOf(sessionId: string | null): { sessions: string[]; more: boolean };
}

// The tasks of a link's conversation on show, oldest first: the one it chose or, with none chosen,
// its latest. From its own first task on: a link made before links kept to their own conversations
// may have continued the owner's, which stays out. A later task that joined some other way, as a
// model switch at a plan's limit does, is the link's too.
export function linkConversation(
  links: RemoteLinks,
  conversations: ConversationChains,
  id: string,
): { sessions: string[]; more: boolean } {
  const chosen = links.shown(id);
  if (chosen === null) return { sessions: [], more: false };
  const latest = chosen ?? links.sessions(id).findLast((task) => conversations.has(task));
  const whole = conversations.snapshotOf(latest ? conversations.latest(latest) : null);
  const from = whole.sessions.findIndex((task) => links.owns(id, task));
  if (from < 0) return { sessions: [], more: false };
  const sessions = whole.sessions.slice(from);
  sessions.forEach((task, index) => {
    const previous = sessions[index - 1];
    if (previous) links.inherit(previous, task);
  });
  return { sessions, more: from === 0 && whole.more };
}

// Persist only hashes. Revocation and quotas are committed before a request is admitted.
// Link recipients share this computer and its chat; this is not tenant/file isolation.
export class RemoteLinks {
  private rows: RemoteGrant[] = [];
  private listeners = new Set<(id: string) => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private file: string;
  private unreadable = false;
  // Each link's own conversation on show: the task it continues, or null for a new one. Kept for
  // as long as the daemon runs; after a restart a link lands in its latest conversation.
  private current = new Map<string, string | null>();
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
  // What the link's tasks may run on: the model it was made with and, while it allows switching,
  // the models it was made with and those the owner has configured now, so a link made before a
  // model was added (or one made with only its own) still offers them.
  choices(row: RemoteGrant, configured: readonly AgentRoleChoice[] = []): AgentRoleChoice[] {
    if (!row.chooseModel) return [row.model];
    const seen = new Set<string>();
    return [row.model, ...row.models, ...configured]
      .map(({ off: _off, ...choice }) => choice)
      .filter((choice) => {
        const key = [choice.provider, choice.model, choice.key ?? ""].join("\0");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 32);
  }
  // options: the guest's own thinking and speed for an offered model; null is the model's default.
  select(
    id: string,
    index: number,
    configured: readonly AgentRoleChoice[] = [],
    options?: unknown,
  ) {
    const row = this.active(id);
    const offered = row && this.choices(row, configured)[index];
    if (!row?.chooseModel || !offered) throw new Error("Model is not allowed by this link");
    const { options: _, ...plain } = offered;
    const model =
      options === undefined
        ? offered
        : options === null
          ? plain
          : AgentRoleChoice.parse({ ...plain, options: ModelOptions.parse(options) });
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
                ? r.sessions.includes(sessionId)
                  ? r
                  : { ...r, sessions: [...r.sessions.slice(-9999), sessionId] }
                : { ...r, tasks: Math.max(0, r.tasks - 1) },
          ),
        );
      },
    };
  }
  // A task that continues a link's task is in the link's conversation, so it is the link's too.
  inherit(previous: string, next: string) {
    if (this.unreadable || previous === next) return;
    const heirs = this.rows.filter(
      (row) => this.valid(row) && row.sessions.includes(previous) && !row.sessions.includes(next),
    );
    if (!heirs.length) return;
    this.save(
      this.rows.map((row) =>
        heirs.includes(row) ? { ...row, sessions: [...row.sessions.slice(-9999), next] } : row,
      ),
    );
  }
  owns(id: string, session: string) {
    return !!this.active(id)?.sessions.includes(session);
  }
  // The link's conversation on show, by a task in it; null for a new one, undefined for none chosen.
  shown(id: string): string | null | undefined {
    return this.current.get(id);
  }
  show(id: string, session: string | null) {
    if (session !== null && !this.owns(id, session)) return false;
    this.current.set(id, session);
    return true;
  }
  // A small explicit allowlist: new owner endpoints stay private by default. A path that names a
  // task answers for that task, whichever rule lets it through: a link reads and changes only its
  // own tasks. Replay adds every task's recording.
  permits(row: RemoteGrant, method: string, path: string): boolean {
    if (!this.active(row.id)) return false;
    const task = TASK.exec(path)?.[1];
    if (method === "GET" || method === "HEAD") {
      if (row.replay && (RECORDINGS.test(path) || path === "/api/session-index")) return true;
      if (task !== undefined && !this.owns(row.id, task)) return false;
      return (
        /^\/api\/(whoami|clock|remote-session|cells|runtime|conversation|conversations)$/.test(
          path,
        ) ||
        /^\/api\/cells\/[0-9A-Z]{26}(?:\/(?:live|status))?$/.test(path) ||
        (row.apps && /^\/api\/browsers\/[0-9A-Z]{26}(?:\/status)?$/.test(path)) ||
        /^\/api\/agent\/sessions\/[0-9A-Z]{26}$/.test(path) ||
        /^\/api\/sessions\/[0-9A-Z]{26}\/(?:events|history|stream|clock)$/.test(path)
      );
    }
    if (method !== "POST") return false;
    if (task !== undefined && !this.owns(row.id, task)) return false;
    if (path === "/api/remote-session/model") return row.chooseModel;
    return (
      /^\/api\/cells\/[0-9A-Z]{26}\/(?:agent|stream-ticket)$/.test(path) ||
      // The web browser is signed in as the owner.
      (row.apps && /^\/api\/cells\/[0-9A-Z]{26}\/browser-stream-ticket$/.test(path)) ||
      path === "/api/conversation/new" ||
      path === "/api/conversation/continue" ||
      /^\/api\/agent\/sessions\/[0-9A-Z]{26}\/(?:messages|stop|answer)$/.test(path)
    );
  }
}
