import { setTimeout as delay } from "node:timers/promises";
import { FramePng } from "../../../daemon/src/agent/frame-png.ts";
import { redactor } from "../../../daemon/src/agent/redact.ts";
import {
  runSideAgent,
  type SideEvent,
  type SideGo,
  type SideModel,
} from "../../../daemon/src/agent/side/agent.ts";
import { sideReaders } from "../../../daemon/src/agent/side/readers.ts";
import { sideSpendLedger } from "../../../daemon/src/agent/side/spend.ts";
import {
  sideQuestionEvents,
  sideQuestionPrompt,
  sideState,
} from "../../../daemon/src/agent/side-question.ts";
import { StoredFiles } from "../../../daemon/src/deliverables/stored.ts";
import { TaskScanner } from "../../../daemon/src/deliverables/task-scan.ts";
import type { EventLog } from "../../../daemon/src/event-log.ts";
import type { FrameStore } from "../../../daemon/src/gateway/frames.ts";

// The real side agent over the fixture's own log, frames and files. Only the model is scripted: it
// picks a tool by the question's words and answers from what the tool really returned.
const USED = { inputTokens: 1800, outputTokens: 90, usd: 0.0031 };
const totalIn = (text: string) => /Total: [\d,]+/.exec(text)?.[0] ?? "nothing I could read";

function fastModel(question: string): SideModel {
  const slow = /slowly/i.test(question) ? 1500 : 0;
  const read = async (go: SideGo, name: string, input: unknown) => {
    const result = await go.tools.call(name, input, go.signal);
    if (slow) await delay(slow, undefined, { signal: go.signal });
    return result;
  };
  return {
    provider: "openai",
    model: "gpt-6-luna",
    role: "fast",
    tools: true,
    images: true,
    run: async (go) => {
      go.used(USED);
      const finish = (status: string, answer: string, sources: string[]) =>
        go.tools.call("finish", { status, answer, sources }, go.signal);
      if (/terminal|command/i.test(question)) {
        const { text } = await read(go, "search_log", { query: "csvstat", only: "terminal" });
        await finish("found", `The command printed: ${totalIn(text)}`, ["terminal"]);
      } else if (/screen/i.test(question)) {
        const { images } = await read(go, "look_at_screen", {});
        await finish(
          images?.length ? "found" : "not_found",
          images?.length ? "The screen shows the sample spreadsheet." : "I can't see the screen.",
          ["screen"],
        );
      } else if (/receipt/i.test(question)) {
        await read(go, "search_log", { query: "receipt" });
        await finish("not_found", "**The log** mentions no receipt.", ["log"]);
      } else {
        const step = /^\[\w+\] (.+)$/m.exec(go.prompt)?.[1];
        await finish(
          "found",
          step
            ? `dot is still on its first step, **${step}**. Nothing has been bought or sent yet.`
            : "Nothing has happened in this task yet.",
          ["record"],
        );
      }
    },
  };
}
const mainModel: SideModel = {
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  role: "main",
  tools: true,
  images: true,
  run: async (go) => {
    go.used({ inputTokens: 2600, outputTokens: 120, usd: 0.0096 });
    await go.tools.call(
      "finish",
      {
        status: "found",
        answer: go.prompt.includes("mentions no receipt")
          ? "Nothing was bought, so there is no receipt: the task only reads a spreadsheet."
          : "An answer from the main model.",
        sources: ["log"],
      },
      go.signal,
    );
  },
};

export function fixtureSideAgent(deps: { home: string; log: EventLog; frames: FrameStore }) {
  const png = new FramePng(deps.frames);
  const scanner = new TaskScanner(deps.log);
  const stored = new StoredFiles(deps.home);
  return (id: string, question: string, signal: AbortSignal, onEvent?: (e: SideEvent) => void) => {
    const file = deps.log.logFile(id);
    const readers = sideReaders(
      {
        frames: deps.frames,
        png,
        desktop: () => undefined,
        device: () => undefined,
        owners: () => ({ foreign: () => false, known: () => true }),
        holder: () => undefined,
        scale: () => 1,
        cellOf: () => undefined,
        scanner,
        stored,
        chain: (sessionId) => [sessionId],
        settings: () => ({}),
        redactor: () => redactor([]),
        now: () => Date.now(),
      },
      id,
      undefined,
      file,
    );
    return runSideAgent({
      models: [fastModel(question), mainModel],
      readers,
      question,
      ...sideQuestionPrompt(sideQuestionEvents(file), question, sideState(undefined, false)),
      signal,
      spend: sideSpendLedger(file),
      ...(onEvent ? { onEvent } : {}),
    });
  };
}
