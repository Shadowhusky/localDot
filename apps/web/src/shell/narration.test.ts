import { type LocalDotEvent, msToMicros } from "@localdot/protocol";
import { emptyModel, foldEvents, type SessionModel } from "@localdot/stage";
import { describe, expect, it } from "vitest";
import { STATE_CAPTIONS, taskHud } from "../session/status.ts";
import { LONG_THINK_MS, narrationLine } from "./narration.ts";

const ID = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
const MESSAGE = "01J9ZQ3V8Y7X6W5T4S3R2Q1P1A";
const FOLLOW_UP = "01J9ZQ3V8Y7X6W5T4S3R2Q1P1B";
let seq = 0;
const ev = (type: string, tMs: number, data: object, step?: string): LocalDotEvent =>
  ({
    v: 1,
    id: ID,
    seq: seq++,
    t: msToMicros(tMs),
    agent: "main",
    ...(step ? { step } : {}),
    type,
    data,
  }) as LocalDotEvent;
const fold = (events: LocalDotEvent[]) => foldEvents(emptyModel(), events);
const session = (): LocalDotEvent[] => [
  ev("session.start", 0, { screen: { w: 1280, h: 800, scale: 1 }, os: "linux" }),
  ev("message.user", 0, { messageId: MESSAGE, text: "Text Mum that I'm late", kind: "task" }),
];
// One computer call: its step, with the line dot gave it, and its click.
const click = (step: string, at: number, label: string, intent?: string) => [
  ev("agent.state", at, { state: "acting" }),
  ev("step.start", at, { kind: "gui", ...(intent ? { intent } : {}) }, step),
  ev("action.intent", at + 10, { verb: "click", label, risk: "none" }, step),
  ev("action.result", at + 400, { ok: true }, step),
  ev("step.end", at + 450, { status: "ok" }, step),
  ev("agent.state", at + 500, { state: "thinking" }),
];
// What the band says at t, by the same status rows the island uses.
const band = (model: SessionModel, t: number) => {
  const hud = taskHud(model, t);
  return narrationLine(hud.row, hud.caption, model, t);
};
const linesOver = (model: SessionModel, from: number, to: number) => {
  const lines: string[] = [];
  for (let t = from; t <= to; t += 50) {
    const line = band(model, t);
    if (line !== lines.at(-1)) lines.push(line);
  }
  return lines;
};

describe("the narrator's line while dot works", () => {
  it("never turns into a state word as dot goes between thinking and acting", () => {
    const model = fold([
      ...session(),
      ev("agent.state", 100, { state: "thinking" }),
      ...click("s1", 2000, "Click “Telegram”", "Opening Telegram to send your message"),
      ...click("s2", 4000, "Click “Search”"),
      ...click("s3", 6000, "Click “Mum”", "Opening your chat with Mum"),
      ...click("s4", 8000, "Click the message box"),
    ]);
    const lines = linesOver(model, 2000, 9500);
    expect(lines).toEqual(["Opening Telegram to send your message", "Opening your chat with Mum"]);
    for (const line of lines) expect(STATE_CAPTIONS.has(line)).toBe(false);
  });

  it("puts dot's newest words first: a call's line, then a later sentence to the user", () => {
    const model = fold([
      ...session(),
      ...click("s1", 1000, "Click “Telegram”", "Opening Telegram to send your message"),
      ev("message.delta", 1800, { messageId: FOLLOW_UP, text: "Telegram is open. I'll find " }),
      ev("message.delta", 2200, { messageId: FOLLOW_UP, text: "Mum next." }),
    ]);
    expect(band(model, 1600)).toBe("Opening Telegram to send your message");
    expect(band(model, 2300)).toBe("I'll find Mum next.");
  });

  it("falls back to the plan item, then to what dot did on the screen, and is quiet before either", () => {
    const planned = fold([
      ...session(),
      ev("agent.state", 100, { state: "thinking" }),
      ev("plan.set", 500, {
        items: [
          { id: "p1", text: "Open Telegram", status: "done" },
          { id: "p2", text: "Find Mum's chat", status: "doing" },
        ],
      }),
      ...click("s1", 1000, "Click “Search”"),
    ]);
    expect(band(planned, 300)).toBe("");
    expect(band(planned, 600)).toBe("Find Mum's chat");
    expect(band(planned, 1200)).toBe("Find Mum's chat");
    const unplanned = fold([...session(), ...click("s1", 1000, "Click “Search”")]);
    expect(band(unplanned, 1200)).toBe("Clicking “Search”");
    expect(band(unplanned, 1600)).toBe("Clicked “Search”");
  });

  it("leaves a finished turn's words behind when a follow-up starts", () => {
    const model = fold([
      ...session(),
      ...click("s1", 1000, "Click “Send”", "Sending your message to Mum"),
      ev("message.user", 5000, { messageId: FOLLOW_UP, text: "Now Dad", kind: "followup" }),
      ev("agent.state", 5000, { state: "thinking" }),
    ]);
    expect(band(model, 2000)).toBe("Sending your message to Mum");
    expect(band(model, 5500)).toBe("");
  });

  it("after a long think, says what dot is still working out", () => {
    const planned = fold([
      ...session(),
      ev("plan.set", 100, { items: [{ id: "p1", text: "Sign in to Telegram", status: "doing" }] }),
      ...click("s1", 1000, "Click “Log in”", "Opening the sign-in page"),
    ]);
    const thinking = 1500;
    expect(band(planned, thinking + LONG_THINK_MS - 1)).toBe("Opening the sign-in page");
    expect(band(planned, thinking + LONG_THINK_MS)).toBe(
      "Still working out how to sign in to Telegram",
    );
    const unplanned = fold([
      ...session(),
      ...click("s1", 1000, "Click “Telegram”", "Opening Telegram to send your message"),
    ]);
    expect(band(unplanned, thinking + LONG_THINK_MS)).toBe(
      "Still opening Telegram to send your message",
    );
    const gerund = fold([
      ...session(),
      ev("plan.set", 100, { items: [{ id: "p1", text: "Drawing the dog", status: "doing" }] }),
      ev("agent.state", 200, { state: "thinking" }),
    ]);
    expect(band(gerund, 200 + LONG_THINK_MS)).toBe("Still drawing the dog");
  });

  it("keeps a long think's own sentence over the reminder", () => {
    const model = fold([
      ...session(),
      ev("plan.set", 100, { items: [{ id: "p1", text: "Sign in to Telegram", status: "doing" }] }),
      ev("agent.state", 200, { state: "thinking" }),
      ev("message.assistant", 4000, { messageId: FOLLOW_UP, text: "The code screen is up." }),
    ]);
    expect(band(model, 200 + LONG_THINK_MS + 1000)).toBe("The code screen is up.");
  });

  it("shows a streamed sentence in Replay from when it was finished, as the live band did", () => {
    const events = [
      ...session(),
      ...click("s1", 1000, "Click “Telegram”", "Opening Telegram to send your message"),
      ev("message.delta", 1800, { messageId: FOLLOW_UP, text: "Telegram is open. I'll find " }),
      ev("message.delta", 2200, { messageId: FOLLOW_UP, text: "Mum next." }),
      ev("message.assistant", 2600, {
        messageId: FOLLOW_UP,
        text: "Telegram is open. I'll find Mum next.",
      }),
    ];
    const replayed = fold(events);
    for (const t of [1600, 1900, 2300, 2700]) {
      const live = fold(events.filter((event) => event.t <= msToMicros(t)));
      expect(band(replayed, t)).toBe(band(live, t));
    }
    expect(band(replayed, 1900)).toBe("Telegram is open.");
  });

  it("moves on to a plan item dot starts after its last line", () => {
    const model = fold([
      ...session(),
      ...click("s1", 1000, "Click “Telegram”", "Opening Telegram to send your message"),
      ev("plan.set", 3000, {
        items: [
          { id: "p1", text: "Open Telegram", status: "done" },
          { id: "p2", text: "Find Mum's chat", status: "doing" },
        ],
      }),
      ev("plan.set", 3500, {
        items: [
          { id: "p1", text: "Open Telegram", status: "done" },
          { id: "p2", text: "Find Mum's chat", status: "doing" },
          { id: "p3", text: "Send the message", status: "todo" },
        ],
      }),
      ev("message.assistant", 4000, { messageId: FOLLOW_UP, text: "Searching for Mum." }),
    ]);
    expect(band(model, 2000)).toBe("Opening Telegram to send your message");
    expect(band(model, 3200)).toBe("Find Mum's chat");
    expect(band(model, 3700)).toBe("Find Mum's chat");
    expect(band(model, 4100)).toBe("Searching for Mum.");
  });

  it("says still working on an item that only looks like a doing word", () => {
    const think = (item: string) => {
      const model = fold([
        ...session(),
        ev("plan.set", 100, { items: [{ id: "p1", text: item, status: "doing" }] }),
        ev("agent.state", 200, { state: "thinking" }),
      ]);
      return band(model, 200 + LONG_THINK_MS);
    };
    expect(think("Morning briefing email")).toBe("Still working on Morning briefing email");
    expect(think("Spring cleaning list")).toBe("Still working on Spring cleaning list");
    expect(think("Running the export script")).toBe("Still running the export script");
    expect(think("Writing the reply")).toBe("Still writing the reply");
    const lined = fold([
      ...session(),
      ...click("s1", 1000, "Click “Inbox”", "Morning check of your inbox"),
    ]);
    expect(band(lined, 1500 + LONG_THINK_MS)).toBe("Morning check of your inbox");
  });

  it("shows a line as plain words", () => {
    const model = fold([
      ...session(),
      ...click("s1", 1000, "Click “Save”", "Saving **report.ods** to `~/Documents`"),
    ]);
    expect(band(model, 1200)).toBe("Saving report.ods to ~/Documents");
  });
});

describe("the narrator's line around the user", () => {
  const model = fold([
    ...session(),
    ...click("s1", 1000, "Click “Send”", "Sending your message to Mum"),
  ]);

  it("keeps the caption where it is dot's question, a wait or a problem", () => {
    expect(narrationLine("question", "Which Mum?", model, 1200)).toBe("Which Mum?");
    expect(narrationLine("approval", "Waiting for your OK.", model, 1200)).toBe(
      "Waiting for your OK.",
    );
    expect(narrationLine("control", "Your turn.", model, 1200)).toBe("Your turn.");
    expect(narrationLine("recovery", "I can't go on by myself.", model, 1200)).toBe(
      "I can't go on by myself.",
    );
  });

  it("keeps a caption that names a moment of its own, and the caption out of touch", () => {
    expect(narrationLine("working", "Starting again where I left off.", model, 1200)).toBe(
      "Starting again where I left off.",
    );
    expect(narrationLine("thinking", "Thinking…", null, 1200)).toBe("Thinking…");
  });
});
