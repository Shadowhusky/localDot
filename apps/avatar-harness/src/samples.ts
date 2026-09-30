import { prepareTrack, type SpeechTrack } from "@localdot/avatar";
import { type LocalDotEvent, parseEvent } from "@localdot/protocol";

export function sampleTrack(startsAt: number): SpeechTrack {
  return prepareTrack({
    lang: "en",
    startsAt,
    visemes: [
      { t: 0, shape: "E" },
      { t: 120, shape: "O" },
      { t: 260, shape: "A" },
      { t: 420, shape: "I" },
      { t: 560, shape: "O" },
      { t: 720, shape: "N" },
      { t: 820, shape: "A" },
      { t: 1000, shape: "rest" },
    ],
  });
}

export const SAMPLE_SCREEN = { w: 1280, h: 800 };

export interface ScheduledEvent {
  atMs: number;
  event: LocalDotEvent;
}

const click = (x: number, y: number) => ({
  input: { kind: "click", button: "left", count: 1, at: { x, y } },
});

const SCRIPT: [number, string, unknown][] = [
  [0, "agent.state", { state: "thinking" }],
  [1400, "agent.state", { state: "acting" }],
  [
    1450,
    "action.intent",
    { verb: "click", label: "Files", point: { x: 160, y: 120 }, risk: "none" },
  ],
  [1900, "action.dispatch", click(160, 120)],
  [
    2300,
    "screen.settle",
    { frameT: 2300, changed: [{ x: 120, y: 80, w: 640, h: 420 }], noVisibleChange: false },
  ],
  [2350, "agent.state", { state: "observing" }],
  [3300, "agent.state", { state: "acting" }],
  [
    3350,
    "action.intent",
    { verb: "click", label: "report.pdf", point: { x: 420, y: 260 }, risk: "none" },
  ],
  [3800, "action.dispatch", click(420, 260)],
  [3900, "action.result", { ok: false, error: "File is locked" }],
  [3950, "agent.state", { state: "error" }],
  [5200, "agent.state", { state: "waiting_user" }],
  [
    5250,
    "approval.request",
    { approvalId: "a1", kind: "send", title: "Send the report", risk: "high" },
  ],
  [8000, "approval.resolve", { approvalId: "a1", decision: "approve", by: "user" }],
  [8050, "agent.state", { state: "acting" }],
  [
    8100,
    "action.intent",
    { verb: "click", label: "Send", point: { x: 1100, y: 700 }, risk: "medium" },
  ],
  [8600, "action.dispatch", click(1100, 700)],
  [9200, "agent.state", { state: "done" }],
  [9250, "session.end", { reason: "done" }],
];

export const SAMPLE_SESSION: ScheduledEvent[] = SCRIPT.map(([atMs, type, data], seq) => ({
  atMs,
  event: parseEvent({ v: 1, id: `sample-${seq}`, seq, t: atMs, agent: "main", type, data }),
}));
