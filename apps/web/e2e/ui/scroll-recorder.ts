import type { Page } from "@playwright/test";

// What the reader saw of the thread, frame by frame, as painted.
export interface ScrollFrame {
  t: number;
  phase: string;
  top: number;
  below: number;
  // The rows in view, top first: each row's key and how far its top sits below the view's.
  rows: readonly (readonly [string, number])[];
  // Pictures in view, each with whether it shows its image.
  pictures: readonly (readonly [string, boolean])[];
  later: boolean;
  // How tall the element the recording was asked to watch is.
  watched?: number;
}
export interface RowChange {
  t: number;
  phase: string;
  key: string;
  mounted: boolean;
}
export interface InputMark {
  t: number;
  // How far the input asks the rows to move: down is positive.
  move: number;
  // How long it takes to, when that is known.
  lasts?: number;
}
export interface ScrollRecord {
  frames: ScrollFrame[];
  changes: RowChange[];
  inputs: InputMark[];
}

interface Recorder extends ScrollRecord {
  phase: string;
  stop(): void;
}
declare global {
  interface Window {
    scrollRecorder?: Recorder;
  }
}

// Samples just after each paint, so a correction made in the frame it was needed is not counted as a
// move. Wheels are read where the scroller receives them; a finger's moves reach the page throttled
// once it scrolls, so whoever drags says how far beforehand (`noteDrag`). `watch` selects an element
// whose height each frame notes, such as a panel unfolding.
export async function startRecording(page: Page, phase: string, watch = "") {
  await page.evaluate(
    ([first, watching]) => {
      const view = document.querySelector<HTMLElement>(".thread-scroll");
      const thread = view?.querySelector<HTMLElement>(".thread");
      if (!view || !thread) throw new Error("No thread to record");
      const rec: Recorder = {
        frames: [],
        changes: [],
        inputs: [],
        phase: first as string,
        stop: () => {},
      };
      window.scrollRecorder = rec;
      const sample = () => {
        const box = view.getBoundingClientRect();
        const rows: [string, number][] = [];
        const pictures: [string, boolean][] = [];
        for (const row of thread.querySelectorAll<HTMLElement>(":scope > .thread-row[data-row]")) {
          const at = row.getBoundingClientRect();
          if (at.bottom <= box.top || at.top >= box.bottom) continue;
          rows.push([row.dataset.row ?? "", Math.round((at.top - box.top) * 10) / 10]);
          for (const picture of row.querySelectorAll(
            ".thread-picture:not(.thread-pictures-more)",
          )) {
            const place = picture.getBoundingClientRect();
            if (place.bottom <= box.top || place.top >= box.bottom) continue;
            const image = picture.querySelector("img");
            pictures.push([
              `${row.dataset.row}/${picture.getAttribute("aria-label")}`,
              !!image?.complete && image.naturalWidth > 0,
            ]);
          }
        }
        const later = view.querySelector(".thread-newer")?.getBoundingClientRect();
        rec.frames.push({
          t: performance.now(),
          phase: rec.phase,
          top: view.scrollTop,
          below: view.scrollHeight - view.clientHeight - view.scrollTop,
          rows,
          pictures,
          later: !!later && later.bottom > box.top && later.top < box.bottom,
          ...(watching
            ? { watched: view.querySelector(watching)?.getBoundingClientRect().height ?? 0 }
            : {}),
        });
      };
      const channel = new MessageChannel();
      channel.port1.onmessage = sample;
      let on = true;
      const loop = () => {
        if (!on) return;
        channel.port2.postMessage(0);
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      const changed = new MutationObserver((records) => {
        const t = performance.now();
        for (const record of records) {
          const note = (nodes: NodeList, mounted: boolean) => {
            for (const node of nodes)
              if (node instanceof HTMLElement && node.dataset.row)
                rec.changes.push({ t, phase: rec.phase, key: node.dataset.row, mounted });
          };
          note(record.removedNodes, false);
          note(record.addedNodes, true);
        }
      });
      changed.observe(thread, { childList: true });
      const wheel = (event: WheelEvent) => {
        rec.inputs.push({ t: performance.now(), move: -event.deltaY });
      };
      const up = () => {
        rec.inputs.push({ t: performance.now(), move: 0 });
      };
      view.addEventListener("wheel", wheel, { capture: true, passive: true });
      view.addEventListener("touchend", up, { capture: true, passive: true });
      rec.stop = () => {
        on = false;
        changed.disconnect();
        view.removeEventListener("wheel", wheel, { capture: true });
        view.removeEventListener("touchend", up, { capture: true });
      };
    },
    [phase, watch],
  );
}

// Says how far a finger is about to drag: its move counts from now until it lifts.
export const noteDrag = (page: Page, move: number) =>
  page.evaluate(
    (drag) => {
      window.scrollRecorder?.inputs.push({ t: performance.now(), ...drag });
    },
    { move, lasts: DRAG_LASTS_MS },
  );

export const setPhase = (page: Page, phase: string) =>
  page.evaluate((next) => {
    if (window.scrollRecorder) window.scrollRecorder.phase = next;
  }, phase);

export const stopRecording = (page: Page): Promise<ScrollRecord> =>
  page.evaluate(() => {
    const rec = window.scrollRecorder;
    if (!rec) throw new Error("Not recording");
    rec.stop();
    return { frames: rec.frames, changes: rec.changes, inputs: rec.inputs };
  });

export interface Jump {
  t: number;
  key: string;
  // How far the rows in view moved in one frame.
  by: number;
  // How far the reader's input could have moved them by then.
  allowed: number;
  phase: string;
}
export interface Remount {
  t: number;
  key: string;
  gone: boolean;
  phase: string;
}
export interface ScrollReport {
  frames: number;
  // The rows in view moved further than, or against, what the reader asked for.
  jumps: Jump[];
  biggest: number;
  // No row in view is still in view a frame later, with no input to explain it.
  teleports: number;
  // A row in view was taken out of the page, and perhaps put back.
  remounts: Remount[];
  // Frames with no row in view at all.
  empty: number;
  // Frames that say "Loading later…" with no reader moving.
  stuckLater: number;
  // A picture in view that had its image went blank.
  picturesLost: number;
  mounts: number;
  unmounts: number;
  // The rows that came and went at all: mounts well past this are a window bouncing.
  distinctRows: number;
}

const DRAG_LASTS_MS = 60_000;
// Scrolling that a wheel or a finger started may run on this long after its last event.
const TAIL_MS = 450;
// Rounding, and a wheel's easing overshooting its own total by a little.
const SLACK = 6;
const END_REACH = 24;
// A wheel's event can reach the page just after the frame that shows its first move.
const EVENT_LAG_MS = 32;
// WebKit keeps a scroll position in whole pixels, so a correction can land this far off.
const WHOLE_PX = 1;
// A page held up this long shows at once all that the browser scrolled for it meanwhile.
const STALL_MS = 250;

// Fails nothing itself: says what moved that the reader's input does not explain. `phases`, when
// given, are the stretches to judge; frames of other phases only carry the sequence along.
export function analyse(record: ScrollRecord, phases?: readonly string[]): ScrollReport {
  const judged = (phase: string) => !phases || phases.includes(phase);
  const inputs = [...record.inputs];
  const report: ScrollReport = {
    frames: 0,
    jumps: [],
    biggest: 0,
    teleports: 0,
    remounts: [],
    empty: 0,
    stuckLater: 0,
    picturesLost: 0,
    mounts: record.changes.filter((change) => change.mounted).length,
    unmounts: record.changes.filter((change) => !change.mounted).length,
    distinctRows: new Set(record.changes.map((change) => change.key)).size,
  };
  let budget = 0;
  let lastInput = Number.NEGATIVE_INFINITY;
  let next = 0;
  let previous: ScrollFrame | undefined;
  for (const frame of record.frames) {
    while ((inputs[next]?.t ?? Number.POSITIVE_INFINITY) <= frame.t + EVENT_LAG_MS) {
      const move = inputs[next]?.move ?? 0;
      // A turn the other way leaves nothing of what was asked before, say at an edge.
      budget = move * budget < 0 ? move : budget + move;
      lastInput = (inputs[next]?.t ?? lastInput) + (inputs[next]?.lasts ?? 0);
      next++;
    }
    if (frame.t - lastInput > TAIL_MS) budget = 0;
    if (judged(frame.phase)) report.frames++;
    if (judged(frame.phase) && !frame.rows.length) report.empty++;
    if (judged(frame.phase) && frame.later && frame.t - lastInput > TAIL_MS) report.stuckLater++;
    // At the end and following it, rows come and go at the end as they arrive: that is the thread
    // moving on with the reader, not under them.
    const following = !!previous && previous.below <= 1 && frame.below <= 1;
    if (previous && !following) {
      const now = new Map(frame.rows);
      // What the reader's eye rests on: the first row that starts in view. A row their view starts
      // inside may fold above them, and rightly moves.
      const shared =
        previous.rows.find(([key, at]) => at >= -0.5 && now.has(key)) ??
        previous.rows.find(([key]) => now.has(key));
      if (shared) {
        const [key, was] = shared;
        const by = (now.get(key) ?? was) - was;
        // A gesture coming to rest this close to the end is the reader going back to it.
        const reach = frame.below <= 1 && by < 0 ? END_REACH : 0;
        const within =
          Math.abs(by) <= WHOLE_PX ||
          frame.t - previous.t > STALL_MS ||
          (by * budget > 0 && Math.abs(by) <= Math.abs(budget) + SLACK + reach);
        if (judged(frame.phase) && !within) {
          report.jumps.push({ t: frame.t, key, by, allowed: budget, phase: frame.phase });
          report.biggest = Math.max(report.biggest, Math.abs(by));
        }
        if (by * budget > 0) budget -= Math.sign(budget) * Math.min(Math.abs(budget), Math.abs(by));
      } else if (judged(frame.phase) && frame.rows.length && previous.rows.length && !budget)
        report.teleports++;
      if (judged(frame.phase)) {
        for (const change of record.changes) {
          if (change.mounted || change.t > frame.t || change.t <= previous.t) continue;
          if (!previous.rows.some(([key]) => key === change.key)) continue;
          const returned = record.changes.some(
            (other) => other.mounted && other.key === change.key && other.t >= change.t,
          );
          report.remounts.push({
            t: change.t,
            key: change.key,
            gone: !returned,
            phase: frame.phase,
          });
        }
        const had = new Map(previous.pictures);
        for (const [id, shows] of frame.pictures) if (had.get(id) && !shows) report.picturesLost++;
      }
    }
    previous = frame;
  }
  return report;
}

// The numbers a run reports, without the lists behind them.
export const summary = ({ jumps, remounts, ...counts }: ScrollReport) => ({
  ...counts,
  jumps: jumps.length,
  remounts: remounts.length,
  firstJumps: jumps.slice(0, 5),
  firstRemounts: remounts.slice(0, 5),
});
