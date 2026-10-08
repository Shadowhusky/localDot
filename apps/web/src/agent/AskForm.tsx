import { QuestionAnswerRequest } from "@localdot/protocol";
import { useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyIntake } from "../keys/KeyForm.tsx";
import { Button } from "../ui/Button.tsx";
import { Collapse } from "../ui/Disclosure.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { useMediaQuery } from "../ui/media.ts";
import { RadioCards } from "../ui/RadioCards.tsx";
import { TextArea } from "../ui/TextArea.tsx";
import { KeyFound } from "./KeyFound.tsx";
import type { AgentQuestion } from "./model.ts";
import { useKeyGuard } from "./useKeyGuard.ts";
import type { TaskControls } from "./useTaskControls.ts";

const OTHER = "other";
const TOUCH = "(hover: none) and (pointer: coarse)";
const ANSWER_LIMIT = 2000;

// Takes the composer's place while dot waits for an answer. The question itself is dot's turn in
// the thread above. A choice can be made at any time; only sending waits for the task to be ready,
// so the rows never change size while it settles.
export function AskForm({
  question,
  controls,
  visible,
  receiveKey,
}: {
  question: AgentQuestion;
  controls: TaskControls;
  visible: boolean;
  receiveKey: KeyIntake["receive"];
}) {
  const [option, setOption] = useState<string>();
  const [written, setWritten] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null),
    composing = useRef(false);
  const current = useRef({ controls, visible, question, option });
  const guard = useKeyGuard(visible && !question.answer),
    guardOwner = useRef(guard);
  const keyNotice = useId();
  const touch = useMediaQuery(TOUCH);
  useLayoutEffect(() => {
    current.current = { controls, visible, question, option };
    guardOwner.current = guard;
  });
  const choices = [
    ...question.options.map((choice) => ({ value: choice.key, label: choice.text })),
    ...(question.allowText && question.options.length
      ? [{ value: OTHER, label: "Something else…" }]
      : []),
  ];
  const writes = question.allowText && (!question.options.length || option === OTHER);
  const field = () => form.current?.querySelector("textarea") ?? null;
  const unavailable = !visible
    ? "Open the conversation to answer."
    : !controls.canAnswer
      ? "Check the current task before answering."
      : undefined;

  // The panel takes the composer's place, so focus that was in the composer moves to the answer.
  useLayoutEffect(() => {
    if (!document.activeElement?.closest(".thread-composer")) return;
    form.current
      ?.querySelector<HTMLElement>("input[type='radio'], textarea")
      ?.focus({ preventScroll: true });
  }, []);

  const choose = (value: string) => {
    setOption(value);
    setProblem(null);
    if (value === OTHER) requestAnimationFrame(() => field()?.focus({ preventScroll: true }));
  };

  const submit = async () => {
    const now = current.current,
      input = field();
    if (!now.visible || !now.controls.canAnswer || composing.current || now.question.answer) return;
    const typing = input && (!now.question.options.length || now.option === OTHER);
    if (typing && !guardOwner.current.check(input)) return;
    const text = typing ? input.value.trim() : "";
    const picked = now.option && now.option !== OTHER ? now.option : undefined;
    const parsed = QuestionAnswerRequest.safeParse({
      askId: now.question.askId,
      ...(picked ? { option: picked } : {}),
      ...(text ? { text } : {}),
    });
    if (!parsed.success) {
      setProblem(
        typing ? "Write an answer of up to 2,000 characters." : "Choose an answer to send.",
      );
      return;
    }
    setProblem(null);
    const accepted = await now.controls.answer(parsed.data);
    if (accepted && input?.isConnected && input.value.trim() === text) {
      input.value = "";
      setWritten(false);
    }
  };

  return (
    <div className="answer-panel">
      <form
        ref={form}
        aria-label="Answer dot"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onKeyDown={(event) => {
          if (event.target instanceof HTMLTextAreaElement) return;
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          const choice = /^[1-9]$/.test(event.key) ? choices[Number(event.key) - 1] : undefined;
          if (!choice) return;
          event.preventDefault();
          choose(choice.value);
        }}
      >
        <div className="answer-panel-head">
          <span>Your answer</span>
          {choices.length > 1 && !touch && (
            <span className="answer-panel-keys">
              Press <Kbd keys={["1"]} />–<Kbd keys={[String(choices.length)]} />
            </span>
          )}
        </div>
        {choices.length > 0 && (
          <RadioCards
            aria-label="Choose an answer"
            className="answer-choices"
            name={`ask-${question.askId}`}
            value={option ?? ""}
            onValueChange={choose}
            options={choices.map((choice, index) => ({
              ...choice,
              ...(touch ? {} : { preview: <Kbd keys={[String(index + 1)]} /> }),
            }))}
          />
        )}
        {question.allowText && (
          <Collapse open={writes} className="answer-other">
            <TextArea
              aria-label="Your answer"
              placeholder="Write your answer"
              maxLength={ANSWER_LIMIT}
              maxRows={6}
              autoComplete="off"
              readOnly={!!unavailable}
              aria-disabled={!!unavailable || undefined}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onInput={(event) => {
                guardOwner.current.check(event.currentTarget);
                setWritten(event.currentTarget.value.trim().length > 0);
                setProblem(null);
              }}
              onPaste={(event) => {
                event.preventDefault();
                const area = event.currentTarget,
                  text = event.clipboardData.getData("text/plain");
                if (
                  area.value.length + text.length - (area.selectionEnd - area.selectionStart) >
                  ANSWER_LIMIT
                )
                  area.value = " ".repeat(8001);
                else area.setRangeText(text, area.selectionStart, area.selectionEnd, "end");
                guardOwner.current.check(area);
                setWritten(area.value.trim().length > 0);
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  !event.nativeEvent.isComposing &&
                  !composing.current
                ) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          </Collapse>
        )}
        <div className="answer-panel-foot">
          <p className="answer-panel-problem" role={problem ? "alert" : undefined}>
            {problem}
          </p>
          <Button
            type="submit"
            variant="primary"
            aria-describedby={guard.notice ? keyNotice : undefined}
            disabledReason={
              unavailable ??
              (guard.notice
                ? "Discard the key or move it to Keys first."
                : option === OTHER || (!option && writes)
                  ? written
                    ? undefined
                    : "Write an answer first."
                  : option
                    ? undefined
                    : "Choose an answer first.")
            }
          >
            Send answer
          </Button>
        </div>
      </form>
      <KeyFound guard={guard} receive={receiveKey} noticeId={keyNotice} />
    </div>
  );
}
