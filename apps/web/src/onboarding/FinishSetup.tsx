import type { MouseEvent } from "react";
import { Button } from "../ui/Button.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { SETUP_STEPS, type SetupStep } from "./setup.ts";
import "./onboarding.css";

export interface FinishSetupProps {
  steps: readonly SetupStep[];
  done: number;
  onChooseModel(event: MouseEvent<HTMLButtonElement>): void;
  onContinue(event: MouseEvent<HTMLButtonElement>): void;
}

// What setup has left, at the top of an empty chat (design-v2 §11 A). Turn on stays the curtain's
// one porcelain action, so Continue setup is secondary.
export function FinishSetup({ steps, done, onChooseModel, onContinue }: FinishSetupProps) {
  const modelReady = steps.some((step) => step.id === "model" && step.done);
  return (
    <section className="setup" aria-labelledby="setup-title">
      <div className="setup-head">
        <h3 id="setup-title">Finish setting up</h3>
        <p>
          {done} of {SETUP_STEPS} steps done.
          {modelReady ? "" : " dot needs a model before it can start."}
        </p>
      </div>
      <ul className="setup-group">
        {steps.map((step) => (
          <li key={step.id} className="setup-row" data-done={step.done || undefined}>
            <StatusGlyph state={step.done ? "done" : "todo"} className="setup-glyph" />
            <span className="setup-text">
              <span className="setup-name">{step.title}</span>
              <span className="setup-detail">{step.detail}</span>
            </span>
            {step.id === "model" && !step.done && (
              <Button size="sm" onClick={onChooseModel}>
                Choose…
              </Button>
            )}
          </li>
        ))}
      </ul>
      <Button className="setup-continue" icon="continue" onClick={onContinue}>
        Continue setup
      </Button>
    </section>
  );
}
