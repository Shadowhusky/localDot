import { type Blocker, blockerSubject, type EventOf, ulid } from "@localdot/protocol";
import { blockerNote } from "@localdot/protocol/guidance";

export interface OpenBlocker {
  readonly blockerId: string;
  readonly blocker: Blocker;
  readonly required: boolean;
}
export type BlockerOutcome = EventOf<"blocker.clear">["data"]["outcome"];
export interface RaiseOptions {
  // Who noticed: localDot from the failure, or dot asking for it.
  by?: "localdot" | "dot";
  // dot can't go on without it, so there is no way out but the fix or Stop.
  required?: boolean;
  // dot hears of it as it is raised. Dot waiting on the card, or a model that has stopped, doesn't.
  tell?: boolean;
}

// One task's open blockers: one card per thing, for the journal to tell every viewer about, and
// what dot is told as each is raised and goes.
export class BlockerDesk {
  readonly #open = new Map<string, OpenBlocker>();
  readonly #told = new Set<string>();
  // Turned down by the user: not offered again until they speak.
  readonly #declined = new Set<string>();
  readonly #ended = new Map<string, BlockerOutcome>();

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
    if (!required && this.#declined.has(subject)) return undefined;
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
  // Dot is waiting on it itself, so its call's own result says when it ends.
  join(blockerId: string): void {
    for (const [subject, open] of this.#open)
      if (open.blockerId === blockerId) this.#told.delete(subject);
  }
  clear(
    matches: (blocker: Blocker) => boolean,
    movedTo?: EventOf<"blocker.clear">["data"]["movedTo"],
  ): OpenBlocker[] {
    const cleared: OpenBlocker[] = [];
    for (const [subject, open] of [...this.#open]) {
      if (!matches(open.blocker)) continue;
      this.#open.delete(subject);
      this.#ended.set(open.blockerId, "fixed");
      this.port.cleared({
        blockerId: open.blockerId,
        outcome: "fixed",
        ...(movedTo ? { movedTo } : {}),
      });
      cleared.push(open);
      if (this.#told.delete(subject)) this.port.tell(blockerNote(open.blocker, "fixed"), true);
    }
    if (cleared.length) this.port.changed();
    return cleared;
  }
  dismiss(blockerId: string): boolean {
    for (const [subject, open] of this.#open) {
      if (open.blockerId !== blockerId) continue;
      if (open.required) return false;
      this.#open.delete(subject);
      this.#told.delete(subject);
      this.#declined.add(subject);
      this.#ended.set(blockerId, "dismissed");
      this.port.cleared({ blockerId, outcome: "dismissed" });
      const note = blockerNote(open.blocker, "dismissed");
      if (note) this.port.tell(note, true);
      this.port.changed();
      return true;
    }
    return false;
  }
  userSpoke(): void {
    this.#declined.clear();
  }
}
