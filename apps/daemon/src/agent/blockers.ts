import { type Blocker, blockerSubject, type EventOf, ulid } from "@localdot/protocol";
import { blockerNote } from "@localdot/protocol/guidance";

export interface OpenBlocker {
  readonly blockerId: string;
  readonly blocker: Blocker;
  readonly required: boolean;
}
export type BlockerOutcome = EventOf<"blocker.clear">["data"]["outcome"];
export interface ClearOptions {
  movedTo?: EventOf<"blocker.clear">["data"]["movedTo"];
  // worked: a call through it went through, which says nothing of what the user did.
  outcome?: "fixed" | "worked";
  // The card itself did this, as its model choice does.
  byCard?: boolean;
}
export interface ClearedBlocker extends OpenBlocker {
  // Fixed through this task's own card. Only that carries the task on by itself.
  readonly ownCard: boolean;
}
export interface RaiseOptions {
  // Who noticed: localDot from the failure, or dot asking for it.
  by?: "localdot" | "dot";
  // dot can't go on without it, so there is no way out but the fix or Stop.
  required?: boolean;
  // dot hears of it as it is raised. Dot waiting on the card, or a model that has stopped, doesn't.
  tell?: boolean;
}

export const RAISE_AGAIN_MS = 2 * 60_000;
// How long after the user starts a fix from a card a fix counts as that card's.
export const CARD_IN_USE_MS = 30 * 60_000;

// One task's open blockers: one card per thing, for the journal to tell every viewer about, and
// what dot is told as each is raised and goes.
export class BlockerDesk {
  readonly #open = new Map<string, OpenBlocker>();
  readonly #told = new Set<string>();
  // Turned down by the owner: not offered again until they speak.
  readonly #declined = new Set<string>();
  readonly #ended = new Map<string, BlockerOutcome>();
  // A card that ended with nothing fixed may come back once, if dot still needs it. After that only
  // after a while, longer each time, so no run of failures or asking becomes a run of notifications.
  readonly #unfixed = new Map<string, { times: number; at: number }>();
  // Cards the user has started a fix from, and until when that counts.
  readonly #inUse = new Map<string, number>();
  readonly #fixedElsewhere = new Set<string>();

  constructor(
    private readonly port: {
      raised(data: EventOf<"blocker.raise">["data"]): void;
      cleared(data: EventOf<"blocker.clear">["data"]): void;
      tell(text: string, wakes: boolean): void;
      changed(): void;
    },
  ) {}

  get open(): readonly OpenBlocker[] {
    return [...this.#open.values()];
  }
  // How a card ended, once it has.
  outcome(blockerId: string): BlockerOutcome | undefined {
    return this.#ended.get(blockerId);
  }
  isOpen(blockerId: string): boolean {
    return [...this.#open.values()].some((open) => open.blockerId === blockerId);
  }
  declined(blocker: Blocker): boolean {
    return this.#declined.has(blockerSubject(blocker));
  }
  raise(blocker: Blocker, options: RaiseOptions = {}): OpenBlocker | undefined {
    const { by = "localdot", required = false, tell = true } = options;
    const subject = blockerSubject(blocker);
    if (!required && (this.#declined.has(subject) || this.#tooSoon(subject))) return undefined;
    let open = this.#open.get(subject);
    if (!open || (required && !open.required)) {
      open = { blockerId: open?.blockerId ?? ulid(), blocker: open?.blocker ?? blocker, required };
      this.port.raised({
        blockerId: open.blockerId,
        blocker: open.blocker,
        by,
        ...(required ? { required: true } : {}),
      });
      this.#open.set(subject, open);
    }
    if (tell && !this.#told.has(subject)) {
      const note = blockerNote(open.blocker, "raised");
      if (note) {
        this.#told.add(subject);
        this.port.tell(note, false);
      }
    }
    return open;
  }
  // The user started a fix from this task's own card. A fix that follows wakes the task.
  use(blockerId: string): boolean {
    if (!this.isOpen(blockerId)) return false;
    this.#inUse.set(blockerId, Date.now() + CARD_IN_USE_MS);
    return true;
  }
  fixedElsewhere(blockerId: string): boolean {
    return this.#fixedElsewhere.has(blockerId);
  }
  // Dot is waiting on it itself, so its call's own result says when it ends.
  join(blockerId: string): void {
    for (const [subject, open] of this.#open)
      if (open.blockerId === blockerId) this.#told.delete(subject);
  }
  // Its wait ended with the card still up: dot hears when it goes, as it was told it would.
  leave(blockerId: string): void {
    for (const [subject, open] of this.#open)
      if (open.blockerId === blockerId && blockerNote(open.blocker, "fixed"))
        this.#told.add(subject);
  }
  clear(
    matches: (blocker: Blocker) => boolean,
    { movedTo, outcome = "fixed", byCard = false }: ClearOptions = {},
  ): ClearedBlocker[] {
    const cleared: ClearedBlocker[] = [];
    for (const [subject, open] of [...this.#open]) {
      if (!matches(open.blocker)) continue;
      const ownCard = byCard || (this.#inUse.get(open.blockerId) ?? 0) > Date.now();
      this.#open.delete(subject);
      this.#end(subject, open, outcome);
      this.port.cleared({
        blockerId: open.blockerId,
        outcome,
        ...(movedTo ? { movedTo } : {}),
      });
      if (outcome === "fixed" && !ownCard) this.#fixedElsewhere.add(open.blockerId);
      cleared.push({ ...open, ownCard });
      // Fixed from elsewhere, it restarts nothing: dot hears with the user's next word.
      const told = this.#told.delete(subject);
      if (told && outcome === "fixed") this.port.tell(blockerNote(open.blocker, "fixed"), ownCard);
    }
    if (cleared.length) this.port.changed();
    return cleared;
  }
  // The user's message moved on from them. Closed as not done, on every device; a fix that comes
  // later finds nothing to clear, so nothing resumes a task that has already moved on.
  moveOn(): void {
    if (!this.#open.size) return;
    for (const [subject, open] of [...this.#open]) {
      this.#open.delete(subject);
      this.#end(subject, open, "moved_on");
      this.port.cleared({ blockerId: open.blockerId, outcome: "moved_on" });
      if (!this.#told.delete(subject)) continue;
      const note = blockerNote(open.blocker, "movedOn");
      if (note) this.port.tell(note, false);
    }
    this.port.changed();
  }
  // dot finished without them: nothing waits on the user any more, and nobody needs telling.
  withdraw(): void {
    for (const [subject, open] of [...this.#open]) {
      this.#open.delete(subject);
      this.#told.delete(subject);
      this.#end(subject, open, "moot");
      this.port.cleared({ blockerId: open.blockerId, outcome: "moot" });
    }
  }
  dismiss(blockerId: string): boolean {
    for (const [subject, open] of this.#open) {
      if (open.blockerId !== blockerId) continue;
      if (open.required) return false;
      this.#open.delete(subject);
      this.#told.delete(subject);
      this.#declined.add(subject);
      this.#end(subject, open, "dismissed");
      this.port.cleared({ blockerId, outcome: "dismissed" });
      const note = blockerNote(open.blocker, "dismissed");
      if (note) this.port.tell(note, true);
      this.port.changed();
      return true;
    }
    return false;
  }
  ownerSpoke(): void {
    this.#declined.clear();
  }
  #end(subject: string, { blockerId }: OpenBlocker, outcome: BlockerOutcome): void {
    this.#ended.set(blockerId, outcome);
    this.#inUse.delete(blockerId);
    if (outcome === "fixed" || outcome === "moot") this.#unfixed.delete(subject);
    else
      this.#unfixed.set(subject, {
        times: (this.#unfixed.get(subject)?.times ?? 0) + 1,
        at: Date.now(),
      });
  }
  #tooSoon(subject: string): boolean {
    const last = this.#unfixed.get(subject);
    return (
      !!last && last.times > 1 && Date.now() - last.at < RAISE_AGAIN_MS * 2 ** (last.times - 2)
    );
  }
}
