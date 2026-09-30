import type { SpringParams } from "@localdot/stage";
import { DEFAULT_GAZE_LIMITS, type GazeLimits, gazeTargets, type Point } from "./gaze.ts";
import { BlinkSchedule, breathAt, swayAt } from "./life.ts";
import { type AvatarParams, clamp, sanitizeParams } from "./params.ts";
import { type ReactionKind, ReactionMixer, type ReactionOffsets } from "./reactions.ts";
import { mouthAt, type SpeechTrack } from "./speech.ts";
import { SpringChannel } from "./spring-channel.ts";
import { type AgentStateName, STATE_POSES, StateGate, THINKING_HMM_MS } from "./states.ts";

export interface ControllerOptions {
  seed: number;
  headCenter: Point;
  reach: number;
  limits?: GazeLimits;
  reducedMotion?: boolean;
}

export const EYE_SPRING: SpringParams = { dampingRatio: 1, response: 0.08 };
export const HEAD_SPRING: SpringParams = { dampingRatio: 1, response: 0.35 };
const POSE_SPRING: SpringParams = { dampingRatio: 1, response: 0.4 };

type Channel = "eyeX" | "eyeY" | "headX" | "headY" | "bodyX" | "brow" | "eyeOpen";

export class AvatarController {
  readonly #now: () => number;
  readonly #seed: number;
  readonly #reach: number;
  readonly #limits: GazeLimits;
  #headCenter: Point;
  #reducedMotion: boolean;
  #attention: Point | null = null;
  #track: SpeechTrack | null = null;
  readonly #gate: StateGate;
  readonly #blinks: BlinkSchedule;
  readonly #reactions = new ReactionMixer();
  readonly #channels: Record<Channel, SpringChannel>;
  readonly #expressionChannels = new Map<string, SpringChannel>();
  readonly #moods = new Map<string, number>();

  constructor(options: ControllerOptions, now: () => number = () => performance.now()) {
    this.#now = now;
    this.#seed = options.seed;
    this.#reach = options.reach;
    this.#limits = options.limits ?? DEFAULT_GAZE_LIMITS;
    this.#headCenter = options.headCenter;
    this.#reducedMotion = options.reducedMotion ?? false;
    const t = now();
    this.#gate = new StateGate("idle");
    this.#blinks = new BlinkSchedule(options.seed);
    this.#channels = {
      eyeX: new SpringChannel(0, EYE_SPRING, t),
      eyeY: new SpringChannel(0, EYE_SPRING, t),
      headX: new SpringChannel(0, HEAD_SPRING, t),
      headY: new SpringChannel(0, HEAD_SPRING, t),
      bodyX: new SpringChannel(0, POSE_SPRING, t),
      brow: new SpringChannel(0, POSE_SPRING, t),
      eyeOpen: new SpringChannel(1, POSE_SPRING, t),
    };
  }

  setState(state: AgentStateName): void {
    this.#gate.request(state, this.#now());
  }

  setAttention(point: Point | null): void {
    this.#attention = point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
  }

  setHeadCenter(point: Point): void {
    this.#headCenter = point;
  }

  react(kind: ReactionKind): boolean {
    return this.#reactions.trigger(kind, this.#now());
  }

  speak(track: SpeechTrack | null): void {
    this.#track = track;
    if (track === null) this.#moods.clear();
  }

  setMood(mood: string, weight: number): void {
    if (weight > 0 && Number.isFinite(weight)) this.#moods.set(mood, clamp(weight, 0, 1));
    else this.#moods.delete(mood);
  }

  setReducedMotion(on: boolean): void {
    this.#reducedMotion = on;
  }

  frame(): AvatarParams {
    const t = this.#now();
    const state = this.#gate.current(t);
    const pose = STATE_POSES[state];
    const gaze = gazeTargets(this.#attention, this.#headCenter, this.#reach, this.#limits);
    const ch = this.#channels;
    ch.eyeX.retarget(clamp(gaze.eyeX + pose.eyeBiasX, -1, 1), t);
    ch.eyeY.retarget(clamp(gaze.eyeY + pose.eyeBiasY, -1, 1), t);
    ch.headX.retarget(gaze.headX, t);
    ch.headY.retarget(gaze.headY + pose.headY, t);
    ch.bodyX.retarget(this.#reducedMotion ? 0 : pose.bodyX, t);
    ch.brow.retarget(pose.brow, t);
    ch.eyeOpen.retarget(pose.eyeOpen, t);

    const targets: Record<string, number> = { ...pose.expressions };
    if (state === "thinking" && this.#gate.heldFor(t) >= THINKING_HMM_MS) targets.hmm = 0.6;
    for (const [mood, weight] of this.#moods) targets[mood] = Math.max(targets[mood] ?? 0, weight);
    const expressions = this.#sampleExpressions(targets, t);

    const reaction = this.#reactions.sample(t);
    for (const [name, weight] of Object.entries(reaction.expressions)) {
      expressions[name] = Math.max(expressions[name] ?? 0, weight);
    }
    const offsets: ReactionOffsets = { ...reaction.offsets };
    if (this.#reducedMotion) {
      delete offsets.headX;
      delete offsets.headY;
      delete offsets.bodyX;
    }

    const sway = this.#reducedMotion ? { x: 0, y: 0 } : swayAt(t, this.#seed);
    const blink = this.#blinks.closure(t);
    const wink = expressions.wink ?? 0;
    const eyeOpen = ch.eyeOpen.value(t) + (offsets.eyeOpen ?? 0);
    const mouth = mouthAt(this.#track, t);

    return sanitizeParams({
      headX: ch.headX.value(t) + (offsets.headX ?? 0) + sway.x,
      headY: ch.headY.value(t) + (offsets.headY ?? 0) + sway.y,
      bodyX: this.#reducedMotion ? 0 : ch.bodyX.value(t) + (offsets.bodyX ?? 0),
      eyeOpenL: eyeOpen * (1 - blink),
      eyeOpenR: eyeOpen * (1 - blink) * (1 - wink),
      eyeX: ch.eyeX.value(t),
      eyeY: ch.eyeY.value(t),
      brow: ch.brow.value(t) + (offsets.brow ?? 0),
      mouthShape: mouth.shape,
      mouthOpen: mouth.open,
      breath: this.#reducedMotion ? 0 : breathAt(t),
      blush: Math.max(offsets.blush ?? 0, expressions.blush ?? 0),
      expressions,
    });
  }

  #sampleExpressions(targets: Record<string, number>, t: number): Record<string, number> {
    for (const name of Object.keys(targets)) {
      if (!this.#expressionChannels.has(name))
        this.#expressionChannels.set(name, new SpringChannel(0, POSE_SPRING, t));
    }
    const out: Record<string, number> = {};
    for (const [name, channel] of this.#expressionChannels) {
      channel.retarget(targets[name] ?? 0, t);
      const value = channel.value(t);
      if (value > 0.001) out[name] = value;
    }
    return out;
  }
}
