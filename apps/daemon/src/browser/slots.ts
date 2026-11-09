import { join } from "node:path";
import { ULID_PATTERN, ulid } from "@localdot/protocol";
import { z } from "zod";
import type { BrowserOrchestrator } from "../cells/browser-orchestrator.ts";
import { readPrivateJson, writePrivateJson } from "../dots/private-json.ts";

const GIB = 1024 ** 3;
// A loaded browser in the Nov 6 trial: about 1.0–1.3 GiB with real sites open.
const PER_BROWSER_BYTES = 1.25 * GIB;
// What the desktop, the main browser and Docker's own engine leave room for.
const BASE_BYTES = 4 * GIB;
export const MAX_EXTRA = 3;
// A conversation's browser none of whose tasks has been live this long is parked.
export const IDLE_PARK_MS = 10 * 60_000;
// One unused this long is removed with its slot.
export const ABANDON_MS = 24 * 60 * 60_000;
// The most slots a computer keeps on disk.
export const MAX_SLOTS = 6;
export const SWEEP_MS = 60_000;

// The browsers a computer may run beside its main one, from Docker's memory, unless set by hand.
export function extraBrowsers(memoryBytes: number | undefined, override?: string): number {
  if (override !== undefined && /^[0-9]+$/u.test(override))
    return Math.min(MAX_EXTRA, Number(override));
  if (!memoryBytes) return 0;
  return Math.max(
    0,
    Math.min(MAX_EXTRA, Math.floor((memoryBytes - BASE_BYTES) / PER_BROWSER_BYTES)),
  );
}

// The lane a browser's actions take turns on, apart from the desktop's.
export const browserLane = (key: string): string => `browser:${key}`;

const id = z.string().regex(ULID_PATTERN);
const Slot = z.strictObject({
  slot: id,
  parentCellId: id,
  // The conversation's first task.
  conversation: id,
  guest: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  usedAt: z.number().int().nonnegative(),
});
type Slot = z.infer<typeof Slot>;
const File = z.strictObject({ v: z.literal(1), slots: z.array(Slot).max(256) });

export interface SlotTask {
  readonly sessionId: string;
  readonly parentCellId: string;
  // The conversation's first task: its own id for a new conversation.
  readonly conversation: string;
  // A shared link's task: never the main browser.
  readonly guest: boolean;
}

export class NoBrowserRoom extends Error {
  constructor() {
    super(
      "Every web browser this computer can run is in use by other tasks. Try again when one of them finishes.",
    );
    this.name = "NoBrowserRoom";
  }
}

export interface BrowserSlotsDeps {
  home: string;
  browser: Pick<
    BrowserOrchestrator,
    "openSlot" | "stop" | "remove" | "endpoints" | "get" | "slots"
  >;
  // How many browsers a computer may run beside its main one now.
  extra(): number;
  // Whether a computer still exists.
  computer(parentCellId: string): boolean;
  // How many people watch a browser's stream.
  viewers?(key: string): number;
  report?(message: string): void;
  now?(): number;
}

// Which web browser each task uses. The first conversation to need it while no other conversation's
// task is using the computer's main browser gets the main one; another gets a browser of its own,
// on a slot copied from the main one, and keeps it for its follow-ups. A shared link's task always
// gets one of its own. Live browsers are bounded by `extra`; at the bound an unused conversation
// browser is parked, and with none to park the task shares the main browser, in a window of its own.
export class BrowserSlots {
  readonly #path: string;
  readonly #slots = new Map<string, Slot>();
  // What each live task uses: a computer's id for its main browser, else a slot.
  readonly #claims = new Map<string, { key: string; task: SlotTask }>();
  readonly #admitting = new Map<string, Promise<void>>();
  // The browser each recent task used, for viewers of a task that has ended.
  readonly #last = new Map<string, string>();

  constructor(private readonly deps: BrowserSlotsDeps) {
    this.#path = join(deps.home, "browser-slots.json");
    try {
      const parsed = File.safeParse(readPrivateJson(this.#path, 256 * 1024));
      for (const slot of parsed.success ? parsed.data.slots : []) {
        this.#slots.set(slot.slot, slot);
        deps.browser.openSlot(slot.parentCellId, slot.slot);
      }
    } catch {
      deps.report?.("the conversations' browsers couldn't be read; they start afresh");
    }
  }

  #now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  #save(): void {
    writePrivateJson(this.#path, { v: 1, slots: [...this.#slots.values()] });
  }

  keyOf(sessionId: string): string | undefined {
    return this.#claims.get(sessionId)?.key;
  }

  // The browser a task used, live or not, as long as it is remembered.
  lastKey(sessionId: string): string | undefined {
    return this.#claims.get(sessionId)?.key ?? this.#last.get(sessionId);
  }

  // The live tasks using a browser.
  sessionsOn(key: string): string[] {
    return [...this.#claims].filter(([, claim]) => claim.key === key).map(([id]) => id);
  }

  // The browser a conversation's tasks last used; its main one when it has none of its own.
  conversationKey(parentCellId: string, conversation: string, guest = false): string {
    return this.#slotOf(parentCellId, conversation, guest)?.slot ?? parentCellId;
  }

  #slotOf(parentCellId: string, conversation: string, guest: boolean): Slot | undefined {
    for (const slot of this.#slots.values())
      if (
        slot.parentCellId === parentCellId &&
        slot.conversation === conversation &&
        slot.guest === guest
      )
        return slot;
    return undefined;
  }

  #mainTakenFrom(task: SlotTask): boolean {
    for (const [sessionId, claim] of this.#claims)
      if (
        sessionId !== task.sessionId &&
        claim.key === task.parentCellId &&
        claim.task.conversation !== task.conversation
      )
        return true;
    return false;
  }

  // Decides at once which browser the task uses, so two tasks deciding together never both take
  // the main one. A task that already has one keeps it.
  claim(task: SlotTask): string {
    const held = this.#claims.get(task.sessionId);
    if (held) return held.key;
    // A shared link's sign-ins stay in its own browser, and the owner's in theirs.
    const own = this.#slotOf(task.parentCellId, task.conversation, task.guest);
    let key: string;
    if (own) {
      own.usedAt = this.#now();
      key = own.slot;
    } else if (!task.guest && !this.#mainTakenFrom(task)) key = task.parentCellId;
    else {
      const slot: Slot = {
        slot: ulid(),
        parentCellId: task.parentCellId,
        conversation: task.conversation,
        guest: task.guest,
        createdAt: this.#now(),
        usedAt: this.#now(),
      };
      this.deps.browser.openSlot(slot.parentCellId, slot.slot);
      this.#slots.set(slot.slot, slot);
      key = slot.slot;
    }
    this.#claims.set(task.sessionId, { key, task });
    this.#save();
    return key;
  }

  // The task shares the main browser instead, as when there's no room for its own. A shared link's
  // task has nothing to share.
  share(sessionId: string): string {
    const claim = this.#claims.get(sessionId);
    if (!claim || claim.task.guest) throw new NoBrowserRoom();
    claim.key = claim.task.parentCellId;
    return claim.key;
  }

  // The task is over: its browser stays, for its conversation's next task.
  release(sessionId: string): void {
    const claim = this.#claims.get(sessionId);
    if (!claim) return;
    this.#claims.delete(sessionId);
    this.#last.set(sessionId, claim.key);
    for (const old of this.#last.keys()) {
      if (this.#last.size <= 256) break;
      this.#last.delete(old);
    }
    const slot = this.#slots.get(claim.key);
    if (slot) {
      slot.usedAt = this.#now();
      this.#save();
    }
  }

  // Makes room for the browser of this key before it starts: past the computer's bound, the
  // conversation browser used longest ago that no live task uses is parked.
  admit(key: string): Promise<void> {
    const slot = this.#slots.get(key);
    if (!slot || this.deps.browser.endpoints(key)) return Promise.resolve();
    const previous = this.#admitting.get(slot.parentCellId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.#admit(slot));
    this.#admitting.set(slot.parentCellId, next);
    const settled = () => {
      if (this.#admitting.get(slot.parentCellId) === next)
        this.#admitting.delete(slot.parentCellId);
    };
    next.then(settled, settled);
    return next;
  }

  async #admit(slot: Slot): Promise<void> {
    if (this.deps.browser.endpoints(slot.slot)) return;
    const allowed = this.deps.extra();
    const live = this.#liveSlots(slot.parentCellId).filter((key) => key !== slot.slot);
    if (live.length < allowed) return;
    const used = new Set([...this.#claims.values()].map((claim) => claim.key));
    const parkable = live
      .filter((key) => !used.has(key))
      .map((key) => this.#slots.get(key))
      .filter((entry): entry is Slot => !!entry)
      .sort(
        (a, b) =>
          (this.deps.viewers?.(a.slot) ?? 0) - (this.deps.viewers?.(b.slot) ?? 0) ||
          a.usedAt - b.usedAt,
      );
    const room = live.length - allowed + 1;
    if (allowed === 0 || parkable.length < room) throw new NoBrowserRoom();
    for (const entry of parkable.slice(0, room)) {
      this.deps.report?.("a conversation's web browser was parked to make room for another");
      await this.deps.browser.stop(entry.slot);
    }
  }

  // Conversation browsers of a computer that are running or starting.
  #liveSlots(parentCellId: string): string[] {
    return [...this.#slots.values()]
      .filter((slot) => slot.parentCellId === parentCellId)
      .map((slot) => slot.slot)
      .filter((key) => {
        const state = this.deps.browser.get(key)?.state;
        return !!this.deps.browser.endpoints(key) || state === "starting";
      });
  }

  // Parks idle conversation browsers and removes slots nobody will use again: abandoned, beyond the
  // computer's count, or of a computer that is gone.
  async sweep(): Promise<void> {
    const now = this.#now();
    const used = new Set([...this.#claims.values()].map((claim) => claim.key));
    const removals: Slot[] = [];
    const byParent = new Map<string, Slot[]>();
    for (const slot of this.#slots.values()) {
      if (used.has(slot.slot)) continue;
      if (!this.deps.computer(slot.parentCellId) || now - slot.usedAt > ABANDON_MS) {
        removals.push(slot);
        continue;
      }
      const list = byParent.get(slot.parentCellId) ?? [];
      list.push(slot);
      byParent.set(slot.parentCellId, list);
    }
    for (const [parent, list] of byParent) {
      const kept = [...this.#slots.values()].filter(
        (slot) => slot.parentCellId === parent && !removals.includes(slot),
      ).length;
      list.sort((a, b) => a.usedAt - b.usedAt);
      removals.push(...list.slice(0, Math.max(0, kept - MAX_SLOTS)));
    }
    for (const slot of removals) {
      try {
        await this.deps.browser.remove(slot.slot);
        this.#slots.delete(slot.slot);
        this.#save();
      } catch {
        this.deps.report?.("a conversation's web browser couldn't be removed; it is tried again");
      }
    }
    for (const slot of this.#slots.values()) {
      if (
        used.has(slot.slot) ||
        now - slot.usedAt < IDLE_PARK_MS ||
        !this.deps.browser.endpoints(slot.slot) ||
        (this.deps.viewers?.(slot.slot) ?? 0) > 0
      )
        continue;
      await this.deps.browser.stop(slot.slot).catch(() => {});
    }
    for (const { key } of this.deps.browser.slots())
      if (!this.#slots.has(key) && !used.has(key))
        await this.deps.browser.remove(key).catch(() => {});
  }

  // Every conversation browser of a computer went with it (signing out of all sites, or the
  // computer removed): their records go too.
  forget(parentCellId?: string): void {
    for (const slot of [...this.#slots.values()])
      if (!parentCellId || slot.parentCellId === parentCellId) this.#slots.delete(slot.slot);
    this.#save();
  }

  watch(): () => void {
    const timer = setInterval(() => void this.sweep().catch(() => {}), SWEEP_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}
