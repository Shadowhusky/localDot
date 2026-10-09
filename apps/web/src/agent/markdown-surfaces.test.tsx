// @vitest-environment jsdom
import type { QuestionAnswerRequest } from "@localdot/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProofStrip } from "../deliverables/ProofStrip.tsx";
import { createApi } from "../lib/api.ts";
import { taskFacts } from "../session/status.ts";
import { showToast } from "../ui/Toast.tsx";
import { ActivityDetail } from "./ActivityDetails.tsx";
import { AllowedNotice } from "./AllowedNotice.tsx";
import { AskForm } from "./AskForm.tsx";
import { type ActivityEntry, entryView } from "./activity.ts";
import { AskDraft } from "./ask-draft.ts";
import { type AgentQuestion, type AgentResult, emptyAgentModel } from "./model.ts";
import { PlanStrip } from "./PlanStrip.tsx";
import { QuestionCard } from "./QuestionCard.tsx";
import { ResultCard, useResultDownloads } from "./ResultFiles.tsx";
import { sayHandedOver } from "./useHandOff.ts";

vi.mock("../ui/Toast.tsx", async (actual) => ({
  ...(await actual<typeof import("../ui/Toast.tsx")>()),
  showToast: vi.fn(),
}));

afterEach(cleanup);

const MARKDOWN =
  "## What I checked\n\nI **couldn't** print `notes.md`.\n\n- This computer has no printer\n- The driver is *missing*";
const PLAIN =
  "What I checked · I couldn't print notes.md. This computer has no printer · The driver is missing";
const api = createApi("fixture", { origin: "http://127.0.0.1:4747", fetchImpl: vi.fn() });
const ASK = "01JXYZ00000000000000000001";
const STEP = "01JXYZ00000000000000000002";

// No Markdown mark reaches the reader as text.
function expectNoMarks(text: string | null | undefined) {
  expect(text).toBeTruthy();
  expect(text).not.toMatch(/\*\*|##|`|(^|\n)\s*[-*+] /);
}

function Result({ result }: { result: AgentResult }) {
  const downloads = useResultDownloads(api, null, [result]);
  return <ResultCard result={result} downloads={downloads} />;
}

describe("a block of dot's words", () => {
  it("shows a result summary's heading, list and bold as they read", () => {
    const { container } = render(<Result result={{ id: "r", summary: MARKDOWN, files: [] }} />);
    const summary = container.querySelector(".result-summary");
    expect(summary?.querySelector("h3")?.textContent).toBe("What I checked");
    expect(summary?.querySelector("strong")?.textContent).toBe("couldn't");
    expect(summary?.querySelector("code")?.textContent).toBe("notes.md");
    expect([...(summary?.querySelectorAll("ul > li") ?? [])].map((li) => li.textContent)).toEqual([
      "This computer has no printer",
      "The driver is missing",
    ]);
    expectNoMarks(summary?.textContent);
  });

  it("shows an Activity note compact, as Markdown", () => {
    const entry: ActivityEntry = {
      key: STEP,
      row: {
        kind: "step",
        id: STEP,
        startT: 0,
        agent: { id: STEP, status: "ok", note: MARKDOWN, output: [], outputTruncated: false },
      },
      keys: [],
    };
    const { container } = render(
      <ActivityDetail
        entry={entry}
        changes={[]}
        api={api}
        sessionId={STEP}
        scale={1}
        replay={false}
      />,
    );
    const note = container.querySelector(".activity-detail-note .safe-markdown");
    expect(note?.hasAttribute("data-compact")).toBe(true);
    expect(note?.querySelectorAll("li")).toHaveLength(2);
    expectNoMarks(note?.textContent);
  });
});

describe("a tight line of dot's words", () => {
  it("reads plan items as plain words", () => {
    const { container } = render(
      <PlanStrip
        plan={[
          { id: "1", text: "**Open** the `totals` sheet", status: "done" },
          { id: "2", text: "## Check [May](https://x.test/may)", status: "doing" },
        ]}
      />,
    );
    expect(container.querySelector(".plan-strip-text")?.textContent).toBe("Check May");
    fireEvent.click(container.querySelector(".ui-disclosure-trigger") as HTMLElement);
    expect([...container.querySelectorAll(".plan-text")].map((item) => item.textContent)).toEqual([
      "Open the totals sheet",
      "Check May",
    ]);
  });

  it("reads a failed step's note as plain words in its Activity row", () => {
    const entry: ActivityEntry = {
      key: STEP,
      row: {
        kind: "step",
        id: STEP,
        startT: 0,
        agent: { id: STEP, status: "failed", note: MARKDOWN, output: [], outputTruncated: false },
      },
      keys: [],
    };
    const view = entryView(entry, [], false);
    expect(view.meta).toBe(`${PLAIN}.`);
  });

  it("reads what dot checked, the hand-off toast and an allowed note as plain words", () => {
    render(
      <ProofStrip
        api={api}
        sessionId={STEP}
        resultId={STEP}
        proof={{
          state: "ready",
          proof: {
            recording: "none",
            results: [{ resultId: STEP, frames: [], checked: MARKDOWN, startMs: 0, endMs: 10 }],
          },
        }}
      />,
    );
    expect(screen.getByText(/^Checked:/).textContent).toBe(`Checked: ${PLAIN}`);

    sayHandedOver({ requestId: ASK, reason: "login", note: MARKDOWN });
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(
      expect.objectContaining({ description: PLAIN }),
    );

    const { container } = render(
      <AllowedNotice
        choice={{
          session: STEP,
          approvalId: ASK,
          actionClass: "send",
          option: { scope: "task", label: "For this task" },
          undo: "idle",
        }}
        outcome={{ approvalId: ASK, decision: "approve", actionClass: "send", note: MARKDOWN }}
        visible
        onUndo={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(container.querySelector(".island-note p")?.textContent).toBe(PLAIN);
  });

  it("gives the band and the island a plain question and hand-off note", () => {
    const facts = taskFacts({
      ...emptyAgentModel(),
      pendingAsk: ASK,
      questions: new Map([[ASK, { askId: ASK, question: MARKDOWN, options: [], allowText: true }]]),
      pendingTakeover: ASK,
      takeovers: new Map([[ASK, { requestId: ASK, reason: "login", note: MARKDOWN }]]),
    });
    expect(facts.question).toBe(PLAIN);
    expect(facts.takeover).toBe(PLAIN);
  });
});

describe("dot's question", () => {
  const question: AgentQuestion = {
    askId: ASK,
    question: "**Send** the file to `Ana`?\n\n- Pay‮exe.pdf\n- report.pdf",
    options: [{ key: "A", text: "**Yes**, send it" }],
    allowText: false,
  };

  it("reads as plain words with every hidden character still shown", () => {
    const { container } = render(<QuestionCard question={question} pending={false} />);
    const text = container.querySelector(".thread-question-text")?.textContent;
    expect(text).toBe("Send the file to Ana? PayU+202Eexe.pdf · report.pdf");
    expectNoMarks(text);
    expect(container.querySelector(".approval-hidden")?.textContent).toBe("U+202E");
    expect(screen.getByText(/hidden characters that change text direction/)).toBeTruthy();
  });

  it("titles the island's form with the same plain words, and its options too", () => {
    const answer = vi.fn(async (_request: QuestionAnswerRequest) => true);
    render(<AskForm draft={new AskDraft(question)} layout="island" answer={answer} />);
    const title = screen.getByRole("heading", { level: 2 });
    expect(title.textContent).toBe("Send the file to Ana? PayU+202Eexe.pdf · report.pdf");
    expect(title.querySelector(".approval-hidden")).toBeTruthy();
    expect(screen.getByText("Yes, send it")).toBeTruthy();
    expect(document.body.textContent).not.toContain("**");
  });

  it("keeps a hidden character the marks alone hold, as written", () => {
    const hidden: AgentQuestion = {
      ...question,
      question: "Open [the invoice](https://x.test/‮exe.pdf)?",
    };
    const { container } = render(<QuestionCard question={hidden} pending={false} />);
    expect(container.querySelector(".approval-hidden")?.textContent).toBe("U+202E");
    expect(screen.getByText(/hidden characters that change text direction/)).toBeTruthy();
  });
});
