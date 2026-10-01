import type { SpringParams } from "@localdot/stage";
import { type AttentionPoint, type AttentionSource, OUTRANKS_SPEECH } from "./attention.ts";
import {
  DEFAULT_GAZE_LIMITS,
  type GazeLimits,
  type GazeTargets,
  gazeTargets,
  gazeToward,
  type Point,
} from "./gaze.ts";
import { BlinkSchedule, breathAt, swayAt } from "./life.ts";
import { type AvatarParams, clamp, sanitizeParams } from "./params.ts";
import { type ReactionKind, ReactionMixer, type ReactionOffsets } from "./reactions.ts";
import { MOUTH_TAIL_MS, mouthAt, prepareTrack, type SpeechTrack, speechSpan } from "./speech.ts";
import { SpringChannel } from "./spring-channel.ts";
import {
  type AgentStateName,
  type Pose,
  STATE_POSES,
  StateGate,
  THINKING_HMM_MS,
} from "./states.ts";
import { GazeWander } from "./wander.ts";

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
const LIFE_SPRING: SpringParams = { dampingRatio: 1, response: 1.5 };
// Roll per unit of head turn: she tilts toward the side she looks.
const LOOK_TILT = 0.8;
export const MOOD_HOLD_MS = 4000;
export const SPEECH_GAZE_HOLD_MS = 800;

type Channel = "eyeX" | "eyeY" | "headX" | "headY" | "bodyX" | "brow" | "eyeOpen" | "life";

export class AvatarController {
  readonly #now: () => number;
  readonly #start: number;
  readonly #seed: number;
  readonly #reach: number;
  readonly #limits: GazeLimits;
  #headCenter: Point;
  #reducedMotion: boolean;
  #attention: AttentionPoint | null = null;
  #source: AttentionSource | "idle" = "idle";
  #track: SpeechTrack | null = null;
  readonly #gate: StateGate;
  readonly #blinks: BlinkSchedule;
  readonly #wander: GazeWander;
  readonly #reactions = new ReactionMixer();
  readonly #channels: Record<Channel, SpringChannel>;
  readonly #expressionChannels = new Map<string, SpringChannel>();
  readonly #moods = new Map<string, number>();
  #moodUntil = Number.NEGATIVE_INFINITY;
  #gazeHoldUntil = Number.NEGATIVE_INFINITY;

  constructor(options: ControllerOptions, now: () => number = () => performance.now()) {
    this.#now = now;
    this.#seed = options.seed;
    this.#reach = options.reach;
    this.#limits = options.limits ?? DEFAULT_GAZE_LIMITS;
    this.#headCenter = options.headCenter;
    this.#reducedMotion = options.reducedMotion ?? false;
    const t = now();
    this.#start = t;
    this.#gate = new StateGate("idle");
    this.#blinks = new BlinkSchedule(options.seed);
    this.#wander = new GazeWander(options.seed);
    this.#channels = {
      eyeX: new SpringChannel(0, EYE_SPRING, t),
      eyeY: new SpringChannel(0, EYE_SPRING, t),
      headX: new SpringChannel(0, HEAD_SPRING, t),
      headY: new SpringChannel(0, HEAD_SPRING, t),
      bodyX: new SpringChannel(0, POSE_SPRING, t),
      brow: new SpringChannel(0, POSE_SPRING, t),
      eyeOpen: new SpringChannel(1, POSE_SPRING, t),
      life: new SpringChannel(0, LIFE_SPRING, t),
    };
  }

  setState(state: AgentStateName): void {
    this.#gate.request(state, this.#now());
  }

  // null means nothing holds attention, so the gaze wanders; a bare point counts as a target.
  setAttention(point: AttentionPoint | null, source?: AttentionSource | "idle"): void {
    this.#attention =
      point === "user" || (point && Number.isFinite(point.x) && Number.isFinite(point.y))
        ? point
        : null;
    this.#source = this.#attention === null ? "idle" : (source ?? "target");
  }

  setHeadCenter(point: Point): void {
    this.#headCenter = point;
  }

  react(kind: ReactionKind): boolean {
    return this.#reactions.trigger(kind, this.#now());
  }

  speak(track: SpeechTrack | null): void {
    const t = this.#now();
    const span = speechSpan(this.#track);
    // A cleared or replaced track still holds her eyes on the user for the rest of its hold.
    if (span && t >= span.from) {
      const hold = Math.min(t, span.to) + SPEECH_GAZE_HOLD_MS;
      this.#gazeHoldUntil = Math.max(this.#gazeHoldUntil, hold);
    }
    this.#track = track && prepareTrack(track);
    if (this.#track === null) {
      this.#moods.clear();
      return;
    }
    const last = this.#track.visemes.at(-1);
    if (last && Number.isFinite(this.#track.startsAt)) {
      this.#moodUntil = this.#track.startsAt + last.t + MOUTH_TAIL_MS;
    }
  }

  // A reply's mood lasts while its speech plays, or MOOD_HOLD_MS for a reply with no speech.
  setMood(mood: string, weight: number): void {
    if (weight > 0 && Number.isFinite(weight)) {
      this.#moods.set(mood, clamp(weight, 0, 1));
      this.#moodUntil = this.#now() + MOOD_HOLD_MS;
    } else {
      this.#moods.delete(mood);
    }
  }

  setReducedMotion(on: boolean): void {
    this.#reducedMotion = on;
  }

  frame(): AvatarParams {
    const t = this.#now();
    if (t > this.#moodUntil) this.#moods.clear();
    const state = this.#gate.current(t);
    const pose = STATE_POSES[state];
    const gaze = this.#gaze(pose, t);
    const ch = this.#channels;
    ch.eyeX.retarget(clamp(gaze.eyeX + pose.eyeBiasX, -1, 1), t);
    ch.eyeY.retarget(clamp(gaze.eyeY + pose.eyeBiasY, -1, 1), t);
    ch.headX.retarget(gaze.headX, t);
    ch.headY.retarget(gaze.headY + pose.headY, t);
    ch.bodyX.retarget(this.#reducedMotion ? 0 : pose.bodyX, t);
    ch.brow.retarget(pose.brow, t);
    ch.eyeOpen.retarget(pose.eyeOpen, t);
    ch.life.retarget(this.#reducedMotion ? 0 : 1, t);

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

    // Idle life eases in from the first frame, and out and back in with reduced motion, so it never
    // pops.
    const life = ch.life.value(t);
    const sway = swayAt(t, this.#seed);
    const blink = this.#blinks.closure(t);
    const wink = expressions.wink ?? 0;
    const eyeOpen = ch.eyeOpen.value(t) + (offsets.eyeOpen ?? 0);
    const mouth = mouthAt(this.#track, t);

    return sanitizeParams({
      headX: ch.headX.value(t) + (offsets.headX ?? 0) + sway.x * life,
      headY: ch.headY.value(t) + (offsets.headY ?? 0) + sway.y * life,
      headRoll: (sway.roll + LOOK_TILT * ch.headX.value(t)) * life,
      bodyX: ch.bodyX.value(t) + (offsets.bodyX ?? 0) + sway.body * life,
      eyeOpenL: eyeOpen * (1 - blink),
      eyeOpenR: eyeOpen * (1 - blink) * (1 - wink),
      eyeX: ch.eyeX.value(t),
      eyeY: ch.eyeY.value(t),
      brow: ch.brow.value(t) + (offsets.brow ?? 0),
      mouthShape: mouth.shape,
      mouthOpen: mouth.open,
      breath: breathAt(t) * life,
      blush: Math.max(offsets.blush ?? 0, expressions.blush ?? 0),
      wind: sway.wind * life,
      expressions,
    });
  }

  #gaze(pose: Pose, t: number): GazeTargets {
    const outranksSpeech = this.#source !== "idle" && OUTRANKS_SPEECH.has(this.#source);
    const attention = this.#speaking(t) && !outranksSpeech ? "user" : this.#attention;
    if (attention !== null && attention !== "user")
      return gazeTargets(attention, this.#headCenter, this.#reach, this.#limits);
    const wander = attention === null && pose.wanders;
    return gazeToward(wander ? this.#wander.at(t - this.#start) : { x: 0, y: 0 }, this.#limits);
  }

  #speaking(t: number): boolean {
    if (t <= this.#gazeHoldUntil) return true;
    const span = speechSpan(this.#track);
    return span !== null && t >= span.from && t <= span.to + SPEECH_GAZE_HOLD_MS;
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
