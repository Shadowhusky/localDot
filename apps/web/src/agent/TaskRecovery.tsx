import { BudgetRaiseRequest } from "@localdot/protocol";
import { useRef, useState } from "react";
import { ownedPause } from "../session/task-hud.ts";
import type { AgentSessionView } from "./useAgentSession.ts";
import type { TaskControls } from "./useTaskControls.ts";
import "./usage.css";

const UNEXPLAINED =
  "The task could not continue. Check the reported reason and repair its provider or model before deciding whether to resume.";
export function recoveryMessage(reason: string | undefined, local: boolean): string {
  return knownReason(reason, local) ?? UNEXPLAINED;
}
function knownReason(reason: string | undefined, local: boolean): string | undefined {
  if (reason === "budget")
    return "The task reached its spending limit. Raising the ceiling keeps the amount already spent.";
  if (reason === "keyd unavailable")
    return "The key layer is offline. Restore it, check task state, then resume if the task is still paused.";
  if (reason === "chatgpt sign-in expired" || reason === "chatgpt account changed")
    return "Repair the ChatGPT account in Settings, then explicitly resume this task.";
  if (reason === "chatgpt plan limit reached")
    return "Plan limit reached. Wait for the reported reset, then resume. This task has no localDot USD budget.";
  if (reason === "model unavailable")
    return local
      ? "The local model is unavailable. Start its server and restore the selected model before resuming."
      : "The selected model could not continue. Check its provider and access before resuming.";
  return undefined;
}
const dollars = (value: number) =>
  `$${value.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
export function TaskRecovery({
  agent,
  controls,
  onSettings,
}: {
  agent: AgentSessionView;
  controls: TaskControls;
  onSettings(trigger: HTMLButtonElement): void;
}) {
  const [validation, setValidation] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const state = agent.model.state;
  if (
    controls.fenced ||
    agent.snapshot?.pause ||
    !agent.sessionId ||
    agent.model.ended ||
    !state ||
    !["paused", "error"].includes(state.state) ||
    (state.state === "paused" && ownedPause(state.reason))
  )
    return null;
  const subscription = agent.snapshot?.models?.kind === "chatgpt" || !!agent.model.subscription;
  const local =
    agent.snapshot?.models?.kind === "api" &&
    agent.snapshot.models.roles.some(
      (role) => role.role === "main" && ["ollama", "lmstudio"].includes(role.provider),
    );
  const budget = agent.model.budget;
  const taskBudget =
    !subscription && budget?.data.scope === "task" && budget.data.taskId === agent.sessionId;
  return (
    <section className="task-recovery" aria-label="Task recovery">
      <h3>{state.state === "paused" ? "Task paused" : "Task needs attention"}</h3>
      <p>{recoveryMessage(state.reason, local)}</p>
      {!subscription && budget && (
        <p>
          Last {budget.data.scope} budget refusal: ceiling {dollars(budget.data.limitUSD)}, spent{" "}
          {dollars(budget.data.spentUSD)}
          {budget.data.needUSD === undefined
            ? ""
            : `, next request needed ${dollars(budget.data.needUSD)}`}
          . Recorded at the last refusal.
        </p>
      )}
      {taskBudget && state.state === "paused" && (
        <form
          aria-label="Set task budget"
          onSubmit={(event) => {
            event.preventDefault();
            const text = field.current?.value.trim() ?? "";
            const budgetUSD = Number(text);
            if (!text || !BudgetRaiseRequest.safeParse({ budgetUSD }).success) {
              setValidation(
                "Enter a positive USD ceiling up to 10,000, with at least one microdollar.",
              );
              return;
            }
            setValidation(null);
            if (controls.canRaiseBudget) void controls.raiseBudget(budgetUSD);
          }}
        >
          <label className="control-field">
            New task ceiling (USD)
            <input
              ref={field}
              type="number"
              inputMode="decimal"
              min="0.000001"
              max="10000"
              step="any"
              disabled={!controls.canRaiseBudget}
            />
          </label>
          <button type="submit" disabled={!controls.canRaiseBudget}>
            Set task budget and resume
          </button>
          {validation && <p role="status">{validation}</p>}
        </form>
      )}
      {budget?.data.scope === "day" && (
        <p>
          A task ceiling cannot raise the day limit. Check the key layer configuration before
          resuming.
        </p>
      )}
      <button
        type="button"
        disabled={!controls.canResumeTask}
        onClick={() => void controls.resume()}
      >
        Resume task
      </button>
      <details className="recovery-options">
        <summary>Recovery options</summary>
        {state.reason && !knownReason(state.reason, local) && (
          <p>Reported reason: {state.reason}</p>
        )}
        <div className="recovery-actions">
          <button type="button" onClick={(event) => onSettings(event.currentTarget)}>
            Open recovery settings
          </button>
          <button type="button" onClick={controls.recheck}>
            Check task state
          </button>
        </div>
        <p className="history-note">Resume keeps this task's model choice and existing ceiling.</p>
      </details>
    </section>
  );
}
