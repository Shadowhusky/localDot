import type { HairpinGuard, KeydVault } from "@localdot/protocol";
import type { KeydClient } from "./client.ts";

export interface KeydHealth {
  online: boolean;
  bootId?: string;
  sealKey?: string;
  // keyd swaps no secret while its audit log cannot be written (Part 4a, P4a-R17).
  audit?: { ok: boolean; error?: string };
  // Whether keyd knows the public address it denies (hairpin NAT); a keyd that does not say is
  // reported as unknown, never as active.
  hairpin?: HairpinGuard;
  // How many keys need entering again (their stored values are gone or unreadable as stored).
  reenter?: number;
  // How many keys were changed outside localDot after their values were stored.
  rebound?: number;
  // Off macOS: where saved keys live, and whether they wait for localdot unlock.
  vault?: KeydVault;
  error?: string;
}

export type KeydHealthListener = (now: KeydHealth, before: KeydHealth) => void;

const OFFLINE: KeydHealth = { online: false, error: "not checked yet" };

// Watches keyd's status so the UI can say "Key layer offline" and the daemon can rewire its
// cells when keyd comes back with a new boot (every cell's listener, CA and surrogates are gone).
export class KeydMonitor {
  #health: KeydHealth = OFFLINE;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #generation = 0;
  #pending: Promise<KeydHealth> | undefined;
  readonly #listeners = new Set<KeydHealthListener>();

  constructor(
    private readonly client: Pick<KeydClient, "status">,
    private readonly everyMs = 2000,
  ) {}

  get health(): KeydHealth {
    return this.#health;
  }

  refresh(): Promise<KeydHealth> {
    if (this.#pending) return this.#pending;
    const pending = this.#read(this.#generation);
    this.#pending = pending;
    const clear = () => {
      if (this.#pending === pending) this.#pending = undefined;
    };
    void pending.then(clear, clear);
    return pending;
  }

  async #read(generation: number): Promise<KeydHealth> {
    let next: KeydHealth;
    try {
      const s = await this.client.status();
      next = {
        online: true,
        bootId: s.bootId,
        sealKey: s.sealKey,
        audit: s.audit,
        hairpin: s.hairpin ?? { state: "unknown", addresses: 0 },
        reenter: s.reenter ?? 0,
        rebound: s.rebound ?? 0,
        ...(s.vault ? { vault: s.vault } : {}),
      };
    } catch (err) {
      next = { online: false, error: err instanceof Error ? err.message : String(err) };
    }
    // A stopped poll must neither notify shutdown listeners nor overwrite a newer poll after
    // start(). The request itself has the client's bounded deadline.
    if (generation !== this.#generation) return next;
    const before = this.#health;
    this.#health = next;
    if (healthState(next) !== healthState(before)) {
      for (const listener of this.#listeners) {
        if (generation !== this.#generation) break;
        try {
          // Also isolate async listeners; their errors can contain sensitive request details.
          void Promise.resolve(listener(next, before)).catch(listenerFailed);
        } catch {
          listenerFailed();
        }
      }
    }
    return next;
  }

  subscribe(listener: KeydHealthListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const generation = this.#generation;
    const tick = async () => {
      await this.refresh();
      if (!this.#running || generation !== this.#generation) return;
      this.#timer = setTimeout(tick, this.everyMs);
      this.#timer.unref();
    };
    void tick();
  }

  stop(): void {
    this.#running = false;
    this.#generation += 1;
    this.#pending = undefined;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

function listenerFailed(): void {
  console.error("keyd health listener failed");
}

function healthState(health: KeydHealth): string {
  // A changed check timestamp alone should not trigger cell rewiring or UI notifications.
  const { checkedAt: _checkedAt, ...hairpin } = health.hairpin ?? {};
  return JSON.stringify([
    health.online,
    health.bootId,
    health.sealKey,
    health.audit?.ok,
    health.audit?.error,
    health.error,
    hairpin,
  ]);
}

// keyd appeared, or came back as a new process: either way its cells must be checked.
export function cameUp(now: KeydHealth, before: KeydHealth): boolean {
  return now.online && (!before.online || now.bootId !== before.bootId);
}
