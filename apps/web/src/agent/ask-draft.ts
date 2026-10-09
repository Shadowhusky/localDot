import { type KeyMatch, type QuestionAnswerRequest, scanKeyLike } from "@localdot/protocol";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  type AskField,
  answerRequest,
  askFields,
  type Draft,
  type DraftValue,
  emptyDraft,
  OTHER,
} from "./ask-form.ts";
import type { AgentQuestion } from "./model.ts";
import type { KeyNotice } from "./useKeyGuard.ts";

export interface AskState {
  readonly draft: Draft;
  // Fields left at least once: their problems show from then on, as they are typed.
  readonly left: ReadonlySet<string>;
  // Fields a key was taken out of, and where the keys were: never the keys themselves.
  readonly keys: ReadonlySet<string>;
  readonly found: KeyNotice | null;
  // Sending, and once sent until the question closes, so nothing goes twice.
  readonly sending: "answer" | "decline" | null;
  readonly failed: string | null;
}

const NOT_SENT = "Your answer didn't reach dot. Check the task, then try again.";

// One question's answer while it is filled in, shared by every surface that shows the question,
// so moving between the thread, the island and a phone's sheet keeps what was typed. Only the
// fields that render read it, so typing redraws nothing else. A secret stays here only until the
// answer is sent.
export class AskDraft {
  readonly fields: readonly AskField[];
  #state: AskState;
  readonly #listeners = new Set<() => void>();

  constructor(readonly question: AgentQuestion) {
    this.fields = askFields(question);
    this.#state = {
      draft: emptyDraft(this.fields),
      left: new Set(),
      keys: new Set(),
      found: null,
      sending: null,
      failed: null,
    };
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  state = () => this.#state;

  #set(next: Partial<AskState>) {
    this.#state = { ...this.#state, ...next };
    for (const listener of this.#listeners) listener();
  }

  #secret = (id: string) => this.fields.some((field) => field.id === id && field.kind === "secret");

  // Keys taken out of the fields wait here, never in the draft, until moved to Keys or discarded.
  #taken: string[] = [];

  // The text with any recognisable key taken out, and the field marked as having held one.
  #withoutKeys(id: string, text: string): { text: string; keys: Set<string> } {
    const keys = new Set(this.#state.keys);
    const scan = scanKeyLike(text);
    if (!scan.overflow && !scan.matches.length) {
      keys.delete(id);
      return { text, keys };
    }
    keys.add(id);
    let clean = "";
    let found: KeyNotice = { kind: "overflow", candidates: [] };
    this.#taken = [];
    if (!scan.overflow) {
      clean = text;
      for (const match of [...scan.matches].reverse())
        clean = clean.slice(0, match.start) + clean.slice(match.end);
      this.#taken = scan.matches.map((match) => text.slice(match.start, match.end));
      found = { kind: "found", candidates: scan.matches };
    }
    this.#state = { ...this.#state, found };
    return { text: clean, keys };
  }

  set(id: string, value: DraftValue) {
    if (this.#state.sending) return;
    let next = value;
    let keys = this.#state.keys;
    if (typeof value === "string" && !this.#secret(id))
      ({ text: next, keys } = this.#withoutKeys(id, value));
    this.#set({
      draft: { ...this.#state.draft, values: { ...this.#state.draft.values, [id]: next } },
      keys,
      failed: null,
    });
  }

  // Moves a key taken out of a field into Keys, through the same hand-over as the composer's.
  moveKey = (
    index: number,
    receive: (source: HTMLInputElement, provider?: KeyMatch["provider"]) => boolean,
  ): boolean => {
    const candidate = this.#state.found?.candidates[index];
    const key = this.#taken[index];
    if (!candidate || key === undefined || this.#state.found?.kind !== "found") return false;
    const scan = scanKeyLike(key);
    const whole =
      !scan.overflow && scan.matches[0]?.start === 0 && scan.matches[0]?.end === key.length;
    let received = false;
    const source = document.createElement("input");
    source.value = whole && scan.matches.length === 1 ? key : "";
    try {
      received = !!source.value && receive(source, candidate.provider) === true;
    } catch {
      received = false;
    } finally {
      source.value = "";
    }
    this.#taken = [];
    this.#set({ found: received ? null : { kind: "transfer_failed", candidates: [] } });
    return received;
  };

  discardKeys = () => {
    this.#taken = [];
    if (this.#state.found) this.#set({ found: null });
  };

  // Text in a choice's "Something else…" row, which picks that row while it has any.
  setOther(id: string, text: string) {
    if (this.#state.sending) return;
    const { text: clean, keys } = this.#withoutKeys(id, text);
    const values = this.#state.draft.values;
    const picked = values[id];
    this.#set({
      draft: {
        values: {
          ...values,
          [id]: clean.trim() ? OTHER : picked === OTHER ? "" : (picked ?? ""),
        },
        other: { ...this.#state.draft.other, [id]: clean },
      },
      keys,
      failed: null,
    });
  }

  leave(id: string) {
    if (this.#state.left.has(id)) return;
    this.#set({ left: new Set(this.#state.left).add(id) });
  }

  // Every secret typed into this draft goes, and any key taken out of it, as after an answer is
  // sent or the question closes.
  forget() {
    this.discardKeys();
    const values = { ...this.#state.draft.values };
    let had = false;
    for (const field of this.fields)
      if (field.kind === "secret" && values[field.id]) {
        values[field.id] = "";
        had = true;
      }
    if (had) this.#set({ draft: { ...this.#state.draft, values } });
  }

  // Sends the answer through `answer`. The request is built once and the draft forgets its secrets
  // before it leaves, whatever comes back.
  async submit(answer: (request: QuestionAnswerRequest) => Promise<boolean>): Promise<boolean> {
    if (this.#state.sending) return false;
    const request = answerRequest(this.question, this.fields, this.#state.draft);
    if (!request) return false;
    this.forget();
    return this.#send("answer", request, answer);
  }

  async decline(answer: (request: QuestionAnswerRequest) => Promise<boolean>): Promise<boolean> {
    if (this.#state.sending) return false;
    this.forget();
    return this.#send("decline", { askId: this.question.askId, declined: true }, answer);
  }

  async #send(
    kind: "answer" | "decline",
    request: QuestionAnswerRequest,
    answer: (request: QuestionAnswerRequest) => Promise<boolean>,
  ) {
    this.#set({ sending: kind, failed: null });
    let sent = false;
    try {
      sent = await answer(request);
    } finally {
      if (!sent) this.#set({ sending: null, failed: NOT_SENT });
    }
    return sent;
  }
}

// The draft for the question dot is waiting on, new for each question and dropped, secrets
// first, once it is answered or gone.
export function useAskDraft(question: AgentQuestion | undefined): AskDraft | null {
  const askId = question?.askId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: one draft per question; later copies of the same question carry only its answer
  const draft = useMemo(() => (question ? new AskDraft(question) : null), [askId]);
  useEffect(() => () => draft?.forget(), [draft]);
  return draft;
}

export function useAskState(draft: AskDraft): AskState {
  return useSyncExternalStore(draft.subscribe, draft.state, draft.state);
}
