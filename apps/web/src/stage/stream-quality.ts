import type { StreamQuality } from "@localdot/protocol";

// What this viewer can take of its computer's stream, decided once a second from what it sees: the
// round trip on the stream's own socket (a queue in front of the frames means the stream outruns the
// network) and the frames its decoder produced against those the stage presented (a gap means the
// device can't keep up). The daemon runs the shared capture at the most constrained visible
// viewer's choice.

// The viewer's choice in Settings: Auto, or what the stream keeps longest when it has to give.
export type StreamPreference = "auto" | "sharp" | "smooth";
export const STREAM_PREFERENCES: readonly StreamPreference[] = ["auto", "sharp", "smooth"];

export interface QualitySample {
  // Smoothed round trip of the stream, and the empty link's (see RoundTrips).
  rttMs: number | null;
  baseRttMs: number | null;
  // Frames the client decoded, and the stage presented, in the last second.
  decodedFps: number;
  presentedFps: number;
}

export const FRAMERATES = [60, 45, 30, 24, 18, 12] as const;
// A touch device shows the stream a few inches wide and runs on a battery: it asks for no more.
export const HANDHELD_FRAMERATE = 30;
// dot's work watched in part of the window shows every step at 30 fps. A stage that covers this
// share of the window or more (full screen, the chat hidden), or a computer in the user's own
// hands, gets the device's full rate.
export const WATCHING_FRAMERATE = 30;
export const LARGE_STAGE_SHARE = 0.6;
// x264 CRF: each step up saves about a fifth of the bit rate, and the picture softens. Still
// screens are sharpened again by Selkies' paint-over whatever the step.
export const CRFS = [25, 28, 31, 34, 37, 41] as const;

// Round trip above the empty link's that means a queue, a long one, and one that has drained.
export const QUEUE_MS = { bad: 150, severe: 600, clear: 60 };
// The stage presenting less than this share of the decoded frames: the device is the limit.
export const DEVICE_KEEPS = 0.75;
// Fewer decoded frames than this a second is too still a screen to judge the device by.
export const MOTION_FPS = 8;
// Seconds of trouble before a step down (a device gets longer: a stage that just started, or a
// busy moment, presents a little late), and of quiet between steps down.
const BAD_TICKS = 2;
const DEVICE_BAD_TICKS = 4;
const COOLDOWN_TICKS = 3;
// Seconds of a clear link before a step back up. A step up that brings trouble back within
// PROBE_TICKS doubles the wait, up to RECOVER_MAX_TICKS; one that holds halves it again.
export const RECOVER_TICKS = 8;
export const RECOVER_MAX_TICKS = 120;
export const PROBE_TICKS = 10;

type Knob = "framerate" | "crf";
type Cause = "link" | "device";

// The knobs each cause turns down, the first with room first. Auto spares a slow device frames
// and gives a slow link detail only: fewer frames of a moving screen each change more, and cost as
// many bits or more (2560x1600 scrolling: 30 fps took 6.1 Mbps where 60 took 3.7). Sharp gives
// frames before detail, Smooth detail before frames.
const ORDER: Record<StreamPreference, Record<Cause, readonly Knob[]>> = {
  auto: { link: ["crf"], device: ["framerate", "crf"] },
  sharp: { link: ["framerate", "crf"], device: ["framerate", "crf"] },
  smooth: { link: ["crf", "framerate"], device: ["crf", "framerate"] },
};

// The most frames a second this viewer asks for.
export function framerateCeiling(
  matches: (query: string) => boolean = (query) =>
    typeof matchMedia === "function" && matchMedia(query).matches,
): number {
  return matches("(pointer: coarse)") ? HANDHELD_FRAMERATE : FRAMERATES[0];
}

// The most a stage asks for: the device's ceiling for a large stage or the user's control, and the
// watching rate otherwise.
export function stageFramerate(
  stage: { share: number; control: boolean },
  ceiling = framerateCeiling(),
): number {
  return stage.control || stage.share >= LARGE_STAGE_SHARE
    ? ceiling
    : Math.min(ceiling, WATCHING_FRAMERATE);
}

const topStep = (maxFramerate: number) => {
  const top = FRAMERATES.findIndex((fps) => fps <= maxFramerate);
  return top < 0 ? FRAMERATES.length - 1 : top;
};

export class QualityController {
  #preference: StreamPreference;
  // The step the frame rate starts from and never rises above.
  #top: number;
  #framerate: number;
  #crf = 0;
  // The steps down, latest last, each with its cause: a step comes back once its cause has cleared,
  // the latest such first.
  readonly #lowered: { knob: Knob; cause: Cause }[] = [];
  #bad = 0;
  // Seconds of a clear link, and of a device keeping up with a moving screen.
  readonly #clear: Record<Cause, number> = { link: 0, device: 0 };
  #cooldown = 0;
  #recover = RECOVER_TICKS;
  // Seconds since the last step up, while that step is still on trial.
  #probe: number | null = null;

  constructor(preference: StreamPreference = "auto", maxFramerate: number = FRAMERATES[0]) {
    this.#preference = preference;
    this.#top = topStep(maxFramerate);
    this.#framerate = this.#top;
  }

  // A new ceiling, as the stage grows, shrinks or changes hands. Steps a slow device or link took
  // stay taken, counted down from the new ceiling.
  cap(maxFramerate: number): void {
    const top = topStep(maxFramerate);
    if (top === this.#top) return;
    const lowered = this.#lowered.filter((step) => step.knob === "framerate").length;
    this.#top = top;
    this.#framerate = Math.min(FRAMERATES.length - 1, top + lowered);
  }

  // A new choice starts again from full quality, giving what it prefers to give as needed.
  prefer(preference: StreamPreference): void {
    if (preference === this.#preference) return;
    this.#preference = preference;
    this.#framerate = this.#top;
    this.#crf = 0;
    this.#lowered.length = 0;
    this.#bad = 0;
    this.#clear.link = 0;
    this.#clear.device = 0;
    this.#cooldown = 0;
    this.#probe = null;
  }

  get quality(): StreamQuality {
    return { framerate: FRAMERATES[this.#framerate] ?? 60, crf: CRFS[this.#crf] ?? 25 };
  }

  // Seconds of a clear link that the next step up waits for.
  get recoverTicks(): number {
    return this.#recover;
  }

  tick(sample: QualitySample): StreamQuality {
    if (this.#cooldown > 0) this.#cooldown--;
    const queue =
      sample.rttMs !== null && sample.baseRttMs !== null ? sample.rttMs - sample.baseRttMs : null;
    const network = queue !== null && queue > QUEUE_MS.bad;
    const moving = sample.decodedFps >= MOTION_FPS;
    // Frames that arrive in bursts off a queued link reach the stage faster than it presents, so
    // the device is judged only on a link that is not queued.
    const device = !network && moving && sample.presentedFps < sample.decodedFps * DEVICE_KEEPS;
    if (network || device) {
      const cause: Cause = network ? "link" : "device";
      this.#clear[cause] = 0;
      this.#bad++;
      const severe = queue !== null && queue > QUEUE_MS.severe;
      const due = network ? this.#bad >= BAD_TICKS || severe : this.#bad >= DEVICE_BAD_TICKS;
      if (due && this.#cooldown === 0) {
        if (this.#probe !== null) this.#recover = Math.min(RECOVER_MAX_TICKS, this.#recover * 2);
        this.#probe = null;
        // A queue that is already long takes all of the first knob at once.
        this.#lower(ORDER[this.#preference][cause], cause, severe ? Number.POSITIVE_INFINITY : 1);
      }
      return this.quality;
    }
    this.#bad = 0;
    this.#clear.link = queue !== null && queue < QUEUE_MS.clear ? this.#clear.link + 1 : 0;
    // A still screen says nothing of the device.
    if (moving) this.#clear.device++;
    if (this.#probe !== null && ++this.#probe >= PROBE_TICKS) {
      this.#recover = Math.max(RECOVER_TICKS, this.#recover / 2);
      this.#probe = null;
    }
    const at = this.#lowered.findLastIndex((step) => this.#clear[step.cause] >= this.#recover);
    if (at >= 0) this.#raise(at);
    return this.quality;
  }

  // Turns the first knob in `order` that has room down by up to `steps`.
  #lower(order: readonly Knob[], cause: Cause, steps: number): void {
    for (const knob of order) {
      const room =
        knob === "framerate"
          ? FRAMERATES.length - 1 - this.#framerate
          : CRFS.length - 1 - this.#crf;
      if (room <= 0) continue;
      for (let n = Math.min(steps, room); n > 0; n--) {
        if (knob === "framerate") this.#framerate++;
        else this.#crf++;
        this.#lowered.push({ knob, cause });
      }
      this.#bad = 0;
      this.#cooldown = COOLDOWN_TICKS;
      return;
    }
  }

  #raise(at: number): void {
    const [step] = this.#lowered.splice(at, 1);
    if (step?.knob === "framerate") this.#framerate = Math.max(this.#top, this.#framerate - 1);
    else if (step?.knob === "crf") this.#crf = Math.max(0, this.#crf - 1);
    this.#clear.link = 0;
    this.#clear.device = 0;
    this.#probe = 0;
  }
}

// Round trips of the stream: smoothed, and the empty link's: a low share of the last WINDOW of them,
// so one lucky ping does not make a jittery link look queued for a minute.
export class RoundTrips {
  static readonly WINDOW = 60;
  static readonly BASE_SHARE = 0.1;
  readonly #recent: number[] = [];
  #smoothed: number | null = null;

  add(ms: number): void {
    this.#smoothed = this.#smoothed === null ? ms : this.#smoothed * 0.6 + ms * 0.4;
    this.#recent.push(ms);
    if (this.#recent.length > RoundTrips.WINDOW) this.#recent.shift();
  }

  get smoothed(): number | null {
    return this.#smoothed;
  }

  get base(): number | null {
    if (!this.#recent.length) return null;
    const sorted = [...this.#recent].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * RoundTrips.BASE_SHARE)] ?? null;
  }
}
