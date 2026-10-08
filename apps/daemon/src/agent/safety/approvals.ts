import {
  APPROVAL_TIMEOUT_MS,
  ApprovalAnswer,
  type ApprovalCard,
  type ApprovalCardDraft,
  ApprovalCard as CardSchema,
  ApprovalCardDraft as DraftSchema,
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
}
interface Pending {
  readonly binding: ActionBinding;
  readonly card: ApprovalCard;
  readonly signal: AbortSignal;
  readonly timer: ReturnType<typeof setTimeout>;
  abort(): void;
  finish(outcome: ApprovalOutcome, by: ApprovalResolution["by"]): void;
}

// Authority lives only in this daemon owner. Cards never contain permits or execution inputs.
export class ApprovalBroker {
  readonly #pending = new Map<string, Pending>();
  #revision = 0;
  constructor(
    private readonly now: () => number = Date.now,
    private readonly publishRequest: (card: ApprovalCard) => void = () => {},
    private readonly publishResolution: (resolution: ApprovalResolution) => void = () => {},
  ) {}
  pending(sessionId: string): ApprovalCard | undefined {
    const card = this.#pending.get(sessionId)?.card;
    return card ? structuredClone(card) : undefined;
  }
  async request(
    binding: ActionBinding,
    draft: ApprovalCardDraft,
    checks: ApprovalChecks,
  ): Promise<ApprovalOutcome> {
    checks.signal.throwIfAborted();
    checks.check(binding);
    if (this.#pending.has(binding.sessionId)) throw new Error("approval already pending");
    if (this.#revision >= Number.MAX_SAFE_INTEGER) throw new Error("approval owner exhausted");
    const privateBinding = Object.freeze(structuredClone(binding));
    const card = CardSchema.parse({
      ...DraftSchema.parse(draft),
      approvalId: ulid(),
      generation: binding.generation,
      revision: ++this.#revision,
      expiresAt: this.now() + APPROVAL_TIMEOUT_MS,
    });
    const outcome = await new Promise<ApprovalOutcome>((resolve) => {
      const finish = (result: ApprovalOutcome, by: ApprovalResolution["by"]) => {
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
          });
        } catch {
          // A missing completion event cannot revive a consumed card.
        }
      };
      const abort = () => finish("stale", "timeout");
      const timer = setTimeout(() => finish("deny", "timeout"), APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      this.#pending.set(binding.sessionId, {
        binding: privateBinding,
        card,
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
      answer.data.revision !== pending.card.revision
    )
      return false;
    if (this.now() >= pending.card.expiresAt) {
      pending.finish("deny", "timeout");
      return false;
    }
    pending.finish(answer.data.decision, "user");
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
