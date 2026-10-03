import type { ReactNode } from "react";
import { stepStatus } from "./activity.ts";
import type { AgentStep } from "./model.ts";

const kinds = {
  gui: "Computer",
  shell: "Command",
  file: "File",
  browser: "Browser",
  ask: "Question",
  think: "Thinking",
};
export function ToolRow({
  step,
  ended,
  children,
}: {
  step: AgentStep;
  ended: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="tool-row" data-testid="tool-row" data-step-id={step.id}>
      <div className="activity-heading">
        <span>{step.kind ? kinds[step.kind] : "Tool"}</span>
        <span>{stepStatus(step, ended)}</span>
      </div>
      <p className="tool-title">
        {step.tool?.title ?? (step.kind ? `${kinds[step.kind]} step` : "Step")}
      </p>
      {step.tool && (
        <p className="tool-outcome">
          {step.tool.ok === undefined
            ? ended
              ? "Tool completion not confirmed."
              : "Tool is running."
            : step.tool.ok
              ? "Tool completed."
              : "Tool failed."}
          {step.tool.exitCode !== undefined ? ` Exit code ${step.tool.exitCode}.` : ""}
        </p>
      )}
      {step.note && <p className="step-reason">{step.note}</p>}
      {children}
    </div>
  );
}
