import type { LocalDotEvent, RecordingGap } from "@localdot/protocol";

interface UserSpan {
  from: number;
  to: number | null;
  // The first frame recorded after `to`: a key frame, since deltas would need the dropped references.
  resumedAt: number | null;
}

// Privacy (P7-R10): while the user has control (M5's takeover: logins, 2FA, CAPTCHAs, payment) the
// recorder keeps no frame, not even in its journal. A frame is judged by its own session time
// against the control changes in the log, so a frame that waited in the recorder's queue behind a
// control.change is still judged correctly. Frames reach `admit` in arrival order; control changes
// may be observed before frames older than them.
export class ControlGate {
  readonly #spans: UserSpan[] = [];

  // Every event of the session, in log order: the backlog at start, then live appends.
  // Returns "returned" when control came back, so the caller asks for a key frame.
  observe(event: LocalDotEvent): "took" | "returned" | null {
    const took =
      event.type === "takeover.request" ||
      (event.type === "control.change" && event.data.holder === "user");
    const returned =
      (event.type === "takeover.end" && event.data.by === "user") ||
      (event.type === "control.change" && event.data.holder === "agent");
    if (!took && !returned) return null;
    return took ? this.hold(event.t) : this.release(event.t);
  }

  hold(tMicros: number): "took" | null {
    const open = this.#spans.at(-1);
    if (open && open.to === null) return null;
    this.#spans.push({ from: tMicros, to: null, resumedAt: null });
    return "took";
  }

  release(tMicros: number): "returned" | null {
    const open = this.#spans.at(-1);
    if (!open || open.to !== null) return null;
    open.to = Math.max(open.from, tMicros);
    return "returned";
  }

  admit(tMicros: number, key: boolean): boolean {
    let before: UserSpan | undefined;
    for (const s of this.#spans) {
      if (tMicros >= s.from && (s.to === null || tMicros < s.to)) return false;
      if (s.to !== null && s.to <= tMicros) before = s;
    }
    if (before && before.resumedAt === null) {
      if (!key) return false;
      before.resumedAt = tMicros;
    }
    return true;
  }

  get userHasControl(): boolean {
    return this.#spans.at(-1)?.to === null;
  }

  // No video from a takeover until the first frame recorded after it; takeovers whose video never
  // came back in between are one gap.
  get gaps(): RecordingGap[] {
    const out: RecordingGap[] = [];
    for (const s of this.#spans) {
      const last = out.at(-1);
      if (last && (last.to === null || s.from <= last.to)) last.to = s.resumedAt;
      else out.push({ from: s.from, to: s.resumedAt, reason: "user-control" });
    }
    return out;
  }
}
