import {
  type ActionClass,
  type AlwaysOption,
  APPROVAL_FIELD_CHARS,
  APPROVAL_TIMEOUT_MS,
  ApprovalAnswer,
  type ApprovalCard,
  type ApprovalRequestDraft,
  ApprovalCard as CardSchema,
  ApprovalRequestDraft as DraftSchema,
  ulid,
} from "@localdot/protocol";

export interface ActionBinding {
  readonly sessionId: string;
  readonly cellId: string;
  readonly generation: number;
  readonly callId: string;
  readonly digest: string;
  readonly targetDigest: string;
}
export type ApprovalOutcome = "approve" | "deny" | "take_control" | "stale";
export interface ApprovalChecks {
  readonly signal: AbortSignal;
  check(binding: ActionBinding): void;
  revalidate(binding: ActionBinding): Promise<boolean>;
}
export interface ApprovalResolution {
  approvalId: string;
  decision: "approve" | "deny" | "take_control";
  by: "user" | "timeout";
  note?: string;
  // The card's own option the user chose, never one the answer described.
  always?: { readonly actionClass: ActionClass; readonly option: AlwaysOption };
  // The hosts an approved purpose card asked about.
  destinations?: readonly string[];
}
interface Pending {
  readonly binding: ActionBinding;
  readonly card: ApprovalCard;
  // Values longer than the card carries, by field, and the ones nobody has read in full yet.
  readonly whole: ReadonlyMap<number, string>;
  readonly unread: Set<number>;
  readonly signal: AbortSignal;
  readonly timer: ReturnType<typeof setTimeout>;
  abort(): void;
  finish(outcome: ApprovalOutcome, by: ApprovalResolution["by"], always?: AlwaysOption): void;
}

function cardFields(draft: ApprovalRequestDraft) {
  const whole = new Map<number, string>();
  const fields = draft.fields.map(([label, text], field): [string, string] => {
    if (text.length <= APPROVAL_FIELD_CHARS) return [label, text];
    whole.set(field, text);
    const last = text.charCodeAt(APPROVAL_FIELD_CHARS - 1);
    const end = last >= 0xd800 && last <= 0xdbff ? APPROVAL_FIELD_CHARS - 1 : APPROVAL_FIELD_CHARS;
    return [label, text.slice(0, end)];
  });
  const partial = [...whole].map(([field, text]) => ({ field, length: text.length }));
  return { fields, whole, ...(partial.length ? { partial } : {}) };
}

// Authority lives only in this daemon owner. Cards never contain permits or execution inputs.
export class ApprovalBroker {
  readonly #pending = new Map<string, Pending>();
  #revision = 0;
  constructor(
    private readonly now: () => number = Date.now,
    private readonly publishRequest: (card: ApprovalCard) => void = () => {},
    private readonly publishResolution: (resolution: ApprovalResolution) => void = () => {},
    private readonly ttlMs: number = APPROVAL_TIMEOUT_MS,
  ) {}
  pending(sessionId: string): ApprovalCard | undefined {
    const card = this.#pending.get(sessionId)?.card;
    return card ? structuredClone(card) : undefined;
  }
  // The full text of a value the card carries only in part; reading it is what lets Approve count.
  field(sessionId: string, approvalId: string, field: number): string | undefined {
    const pending = this.#pending.get(sessionId);
    if (pending?.card.approvalId !== approvalId) return undefined;
    const text = pending.whole.get(field);
    if (text !== undefined) pending.unread.delete(field);
    return text;
  }
  async request(
    binding: ActionBinding,
    draft: ApprovalRequestDraft,
    checks: ApprovalChecks,
  ): Promise<ApprovalOutcome> {
    checks.signal.throwIfAborted();
    checks.check(binding);
    if (this.#pending.has(binding.sessionId)) throw new Error("approval already pending");
    if (this.#revision >= Number.MAX_SAFE_INTEGER) throw new Error("approval owner exhausted");
    const privateBinding = Object.freeze(structuredClone(binding));
    const parsed = DraftSchema.parse(draft);
    const { whole, ...shown } = cardFields(parsed);
    const card = CardSchema.parse({
      ...parsed,
      ...shown,
      approvalId: ulid(),
      generation: binding.generation,
      revision: ++this.#revision,
      expiresAt: this.now() + this.ttlMs,
    });
    const outcome = await new Promise<ApprovalOutcome>((resolve) => {
      const finish = (
        result: ApprovalOutcome,
        by: ApprovalResolution["by"],
        always?: AlwaysOption,
      ) => {
        const pending = this.#pending.get(binding.sessionId);
        if (pending?.binding !== privateBinding) return;
        this.#pending.delete(binding.sessionId);
        clearTimeout(pending.timer);
        pending.signal.removeEventListener("abort", pending.abort);
        // Settle and discard authority synchronously, before any fallible journal callback.
        resolve(result);
        try {
          this.publishResolution({
            approvalId: card.approvalId,
            decision: result === "stale" ? "deny" : result,
            by,
            ...(result === "stale" ? { note: "Approval cancelled." } : {}),
            ...(always && result === "approve"
              ? { always: { actionClass: card.actionClass, option: always } }
              : {}),
            ...(card.destinations && result === "approve"
              ? { destinations: [...card.destinations] }
              : {}),
          });
        } catch {
          // A missing completion event cannot revive a consumed card.
        }
      };
      const abort = () => finish("stale", "timeout");
      const timer = setTimeout(() => finish("deny", "timeout"), this.ttlMs);
      timer.unref?.();
      this.#pending.set(binding.sessionId, {
        binding: privateBinding,
        card,
        whole,
        unread: new Set(whole.keys()),
        signal: checks.signal,
        timer,
        abort,
        finish,
      });
      checks.signal.addEventListener("abort", abort, { once: true });
      try {
        this.publishRequest(structuredClone(card));
      } catch {
        finish("stale", "timeout");
      }
      if (checks.signal.aborted) abort();
    });
    if (outcome !== "approve") return outcome;
    checks.signal.throwIfAborted();
    checks.check(privateBinding);
    if (!(await checks.revalidate(privateBinding))) return "stale";
    checks.signal.throwIfAborted();
    checks.check(privateBinding);
    return "approve";
  }
  answer(sessionId: string, value: unknown): boolean {
    const answer = ApprovalAnswer.safeParse(value);
    const pending = this.#pending.get(sessionId);
    if (
      !answer.success ||
      !pending ||
      answer.data.approvalId !== pending.card.approvalId ||
      answer.data.generation !== pending.card.generation ||
      answer.data.revision !== pending.card.revision ||
      (answer.data.decision === "approve" && pending.unread.size > 0)
    )
      return false;
    const scope = answer.data.always;
    const always = pending.card.always?.find((option) => option.scope === scope);
    if (scope !== undefined && !always) return false;
    if (this.now() >= pending.card.expiresAt) {
      pending.finish("deny", "timeout");
      return false;
    }
    pending.finish(answer.data.decision, "user", always);
    return true;
  }
  cancel(sessionId: string): void {
    this.#pending.get(sessionId)?.finish("stale", "timeout");
  }
}

// Consumed immediately before each exact effect it covers; never cached by action class or label.
export class CountedPermit {
  #left: number;
  constructor(
    private readonly digest: string,
    uses: number,
  ) {
    if (!Number.isSafeInteger(uses) || uses < 1) throw new Error("invalid permit count");
    this.#left = uses;
  }
  consume(digest: string): boolean {
    if (this.#left < 1 || digest !== this.digest) return false;
    this.#left--;
    return true;
  }
}
export class OncePermit extends CountedPermit {
  constructor(digest: string) {
    super(digest, 1);
  }
}
