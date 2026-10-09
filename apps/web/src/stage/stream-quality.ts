import type { StreamQuality } from "@localdot/protocol";

// What this viewer can take of its computer's stream, decided once a second from what it sees: the
// round trip on the stream's own socket (a queue in front of the frames means the stream outruns the
// network) and the frames its decoder produced against those the stage presented (a gap means the
// device can't keep up). The daemon runs the shared capture at the most constrained visible
// viewer's choice.

export type DeviceClass = "phone" | "desktop";

export interface QualitySample {
  // Smoothed round trip of the stream, and the lowest of the last minute: the empty link.
  rttMs: number | null;
  baseRttMs: number | null;
  // Frames the client decoded, and the stage presented, in the last second.
  decodedFps: number;
  presentedFps: number;
}

export const FRAMERATES = [60, 45, 30, 24, 18, 12] as const;
// x264 CRF: each step up saves about a fifth of the bit rate, and the picture softens. Still
// screens are sharpened again by Selkies' paint-over whatever the step.
export const CRFS = [25, 28, 31, 34, 37, 41] as const;
// A phone shows a small picture of a large screen: half the frames are plenty.
const PHONE_TOP_FRAMERATE = 30;

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

export class QualityController {
  readonly #top: number;
  #framerate: number;
  #crf = 0;
  // The knobs turned down, latest last: a recovery turns them back up in reverse.
  readonly #lowered: Knob[] = [];
  #bad = 0;
  #clear = 0;
  #cooldown = 0;
  #recover = RECOVER_TICKS;
  // Seconds since the last step up, while that step is still on trial.
  #probe: number | null = null;

  constructor(device: DeviceClass) {
    this.#top = device === "phone" ? FRAMERATES.indexOf(PHONE_TOP_FRAMERATE) : 0;
    this.#framerate = this.#top;
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
    // Frames that arrive in bursts off a queued link reach the stage faster than it presents, so
    // the device is judged only on a clear link.
    const device =
      !network &&
      sample.decodedFps >= MOTION_FPS &&
      sample.presentedFps < sample.decodedFps * DEVICE_KEEPS;
    if (network || device) {
      this.#clear = 0;
      this.#bad++;
      const severe = queue !== null && queue > QUEUE_MS.severe;
      const due = network ? this.#bad >= BAD_TICKS || severe : this.#bad >= DEVICE_BAD_TICKS;
      if (due && this.#cooldown === 0) {
        if (this.#probe !== null) this.#recover = Math.min(RECOVER_MAX_TICKS, this.#recover * 2);
        this.#probe = null;
        // A slow device is spared frames first. A slow link loses detail only, all of it at once
        // when the queue is already long: fewer frames of a moving screen each change more, and
        // cost as many bits or more (2560x1600 scrolling: 30 fps took 6.1 Mbps where 60 took 3.7).
        if (device) this.#lower(["framerate", "crf"], 1);
        else this.#lower(["crf"], severe ? CRFS.length : 1);
      }
      return this.quality;
    }
    this.#bad = 0;
    if (queue === null || queue >= QUEUE_MS.clear) {
      this.#clear = 0;
      return this.quality;
    }
    this.#clear++;
    if (this.#probe !== null && ++this.#probe >= PROBE_TICKS) {
      this.#recover = Math.max(RECOVER_TICKS, this.#recover / 2);
      this.#probe = null;
    }
    if (this.#clear >= this.#recover && this.#lowered.length) this.#raise();
    return this.quality;
  }

  // Turns the first knob in `order` that has room down by up to `steps`.
  #lower(order: Knob[], steps: number): void {
    for (const knob of order) {
      const room =
        knob === "framerate"
          ? FRAMERATES.length - 1 - this.#framerate
          : CRFS.length - 1 - this.#crf;
      if (room <= 0) continue;
      for (let n = Math.min(steps, room); n > 0; n--) {
        if (knob === "framerate") this.#framerate++;
        else this.#crf++;
        this.#lowered.push(knob);
      }
      this.#bad = 0;
      this.#cooldown = COOLDOWN_TICKS;
      return;
    }
  }

  #raise(): void {
    const knob = this.#lowered.pop();
    if (knob === "framerate") this.#framerate = Math.max(this.#top, this.#framerate - 1);
    else if (knob === "crf") this.#crf = Math.max(0, this.#crf - 1);
    this.#clear = 0;
    this.#probe = 0;
  }
}

// Round trips of the stream: smoothed, and the lowest of the last WINDOW of them.
export class RoundTrips {
  static readonly WINDOW = 60;
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
    return this.#recent.length ? Math.min(...this.#recent) : null;
  }
}

export function deviceClass(): DeviceClass {
  try {
    return window.matchMedia("(pointer: coarse)").matches ? "phone" : "desktop";
  } catch {
    return "desktop";
  }
}
