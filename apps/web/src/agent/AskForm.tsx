import { QuestionAnswerRequest } from "@localdot/protocol";
import { useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyIntake } from "../keys/KeyForm.tsx";
import { KeyFound } from "./KeyFound.tsx";
import type { AgentQuestion } from "./model.ts";
import { QuestionCard } from "./QuestionCard.tsx";
import { useKeyGuard } from "./useKeyGuard.ts";
import type { TaskControls } from "./useTaskControls.ts";

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
  const [problem, setProblem] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null),
    composing = useRef(false);
  const current = useRef({ controls, visible, question, option });
  const guard = useKeyGuard(visible && !question.answer),
    guardOwner = useRef(guard);
  const keyNotice = useId();
  useLayoutEffect(() => {
    current.current = { controls, visible, question, option };
    guardOwner.current = guard;
  });
  const submit = async () => {
    const now = current.current,
      input = field.current;
    if (!now.visible || !now.controls.canAnswer || composing.current || now.question.answer) return;
    if (input && !guardOwner.current.check(input)) return;
    const text = input?.value ?? "";
    const parsed = QuestionAnswerRequest.safeParse({
      askId: now.question.askId,
      ...(now.option ? { option: now.option } : {}),
      ...(text ? { text } : {}),
    });
    if (!parsed.success) {
      setProblem("Choose an answer or write up to 2000 characters.");
      return;
    }
    setProblem(null);
    const accepted = await now.controls.answer(parsed.data);
    if (accepted && input?.isConnected && input.value === text) input.value = "";
  };
  return (
    <QuestionCard question={question} pending={!question.answer}>
      <form
        aria-label="Answer dot"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {!!question.options.length && (
          <fieldset disabled={!visible || !controls.canAnswer}>
            <legend>Choose an answer</legend>
            {question.options.map((choice) => (
              <label className="answer-option" key={choice.key}>
                <input
                  type="radio"
                  name={`ask-${question.askId}`}
                  value={choice.key}
                  checked={option === choice.key}
                  onChange={() => setOption(choice.key)}
                />
                <span>{choice.text}</span>
              </label>
            ))}
          </fieldset>
        )}
        {question.allowText && (
          <label className="control-field">
            <span>Your answer</span>
            <textarea
              ref={field}
              rows={3}
              maxLength={2000}
              disabled={!visible || !controls.canAnswer}
              autoComplete="off"
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onInput={(event) => {
                guardOwner.current.check(event.currentTarget);
                setProblem(null);
              }}
              onPaste={(event) => {
                event.preventDefault();
                const field = event.currentTarget,
                  text = event.clipboardData.getData("text/plain");
                if (
                  field.value.length + text.length - (field.selectionEnd - field.selectionStart) >
                  2000
                )
                  field.value = " ".repeat(8001);
                else field.setRangeText(text, field.selectionStart, field.selectionEnd, "end");
                guardOwner.current.check(field);
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
          </label>
        )}
        <button
          type="submit"
          disabled={!visible || !controls.canAnswer || !!guard.notice}
          aria-describedby={guard.notice ? keyNotice : undefined}
        >
          Send answer
        </button>
      </form>
      <KeyFound guard={guard} receive={receiveKey} noticeId={keyNotice} />
      {problem && <p role="alert">{problem}</p>}
      {!controls.canAnswer && (
        <p className="history-note">Check the current task before answering.</p>
      )}
    </QuestionCard>
  );
}
