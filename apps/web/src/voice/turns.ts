import { VoiceError, type VoiceFailure } from "./capture.ts";
import type { Hearing, HearingEvents } from "./hearing.ts";
import { IDLE, MAX_LISTEN_MS, type VoiceEvent, type VoiceState, voiceStep } from "./machine.ts";
import type { VoiceRoute } from "./support.ts";
import { type Draft, spoken } from "./transcript.ts";
import { failureLine, routeBlocked } from "./words.ts";

export interface VoiceHost {
  field(): HTMLTextAreaElement | null;
  route(): VoiceRoute;
  hear(
    route: Extract<VoiceRoute, { kind: "device" | "mac" | "online" }>,
    events: HearingEvents,
  ): Promise<Hearing>;
  // Words show in the message as they come; where the message is hidden while the user talks (a
  // phone's one-line field), only the final words land, so the toolbar doesn't grow meanwhile.
  live(): boolean;
  // The field's text changed under the composer; with a caret, the words are final and in place.
  changed(input: HTMLTextAreaElement, caret?: number): void;
  view(state: VoiceState): void;
  notice(line: string | null): void;
  // The browser's one-time download of on-device speech, started by this press.
  download(): void;
  now(): number;
}

// One turn after another of talking to dot: drives the speech engine from the push-to-talk
// machine and writes what it hears into the message, where the user can change it before sending.
// Nothing is kept: a cancelled turn puts the message back as it was.
export class VoiceTurns {
  state: VoiceState = IDLE;
  #hearing: Hearing | null = null;
  #turn = 0;
  #draft: Draft | null = null;
  #written: string | null = null;
  #limit: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly host: VoiceHost) {}

  level(): number {
    return this.#hearing?.level() ?? -1;
  }

  send(event: VoiceEvent) {
    const step = voiceStep(this.state, event);
    if (step.state === this.state) return;
    this.state = step.state;
    if (step.state.phase !== "listening") clearTimeout(this.#limit);
    this.host.view(step.state);
    if (step.effect === "start") this.#begin();
    else if (step.effect === "finish") this.#finish();
    else if (step.effect === "abort") this.#drop();
  }

  dispose() {
    if (this.state.phase !== "idle") this.send({ type: "cancel" });
  }

  #begin() {
    const route = this.host.route();
    const turn = ++this.#turn;
    this.host.notice(null);
    if (route.kind === "none") {
      if (route.why === "download") {
        this.host.download();
        this.host.notice("Getting speech ready on this device…");
      } else this.host.notice(routeBlocked(route) ?? null);
      this.send({ type: "done" });
      return;
    }
    const input = this.host.field();
    if (input) {
      const focused = document.activeElement === input;
      const end = input.value.length;
      this.#draft = {
        value: input.value,
        start: focused ? input.selectionStart : end,
        end: focused ? input.selectionEnd : end,
      };
    }
    this.#written = null;
    this.host
      .hear(route, {
        partial: (text) => {
          if (turn === this.#turn && this.host.live()) this.#write(text);
        },
        ended: () => {
          if (turn === this.#turn) this.send({ type: "stop" });
        },
        failed: (failure) => {
          if (turn === this.#turn) this.#fail(failure);
        },
      })
      .then(
        (hearing) => {
          if (turn !== this.#turn) {
            hearing.abort();
            return;
          }
          this.#hearing = hearing;
          this.send({ type: "started", at: this.host.now() });
          this.#limit = setTimeout(() => this.send({ type: "stop" }), MAX_LISTEN_MS);
        },
        (error: unknown) => {
          if (turn === this.#turn)
            this.#fail(error instanceof VoiceError ? error.failure : "failed");
        },
      );
  }

  #finish() {
    const hearing = this.#hearing;
    const turn = this.#turn;
    if (!hearing) {
      this.send({ type: "done" });
      return;
    }
    hearing.finish().then(
      (words) => {
        if (turn !== this.#turn) return;
        this.#hearing = null;
        if (words.trim()) this.#write(words, true);
        else {
          this.#restore();
          this.host.notice(failureLine("no-speech"));
        }
        this.#draft = null;
        this.#written = null;
        this.send({ type: "done" });
      },
      (error: unknown) => {
        if (turn === this.#turn) this.#fail(error instanceof VoiceError ? error.failure : "failed");
      },
    );
  }

  #fail(failure: VoiceFailure) {
    const finishing = this.state.phase === "finishing";
    this.host.notice(failureLine(failure));
    this.send({ type: "done" });
    // Done stops a running engine itself; while finishing, the words so far still go back.
    if (finishing) this.#drop();
  }

  #drop() {
    this.#turn++;
    this.#hearing?.abort();
    this.#hearing = null;
    this.#restore();
    this.#draft = null;
    this.#written = null;
  }

  #write(words: string, final = false) {
    const input = this.host.field();
    const draft = this.#draft;
    if (!input || !draft) return;
    // The user changed the message meanwhile: their text wins.
    if (input.value !== (this.#written ?? draft.value)) return;
    const next = spoken(draft, words);
    input.value = next.value;
    this.#written = next.value;
    this.host.changed(input, final ? next.caret : undefined);
  }

  #restore() {
    const input = this.host.field();
    if (!input || !this.#draft || this.#written === null || input.value !== this.#written) return;
    input.value = this.#draft.value;
    this.#written = null;
    this.host.changed(input);
  }
}
