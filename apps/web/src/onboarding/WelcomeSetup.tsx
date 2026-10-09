import { AutonomyPolicy, DEFAULT_AUTONOMY } from "@localdot/protocol";
import type { ReactNode } from "react";
import { checksSummary } from "../copy/autonomy.ts";
import { Dot } from "../dot/Dot.tsx";
import { Button } from "../ui/Button.tsx";
import { PHONE, useMediaQuery } from "../ui/media.ts";
import { ScrollArea } from "../ui/ScrollArea.tsx";
import { type GlyphState, StatusGlyph } from "../ui/StatusGlyph.tsx";
import { type AppearanceControl, AppearancePicker } from "./AppearancePicker.tsx";
import "./onboarding.css";

export interface WelcomeSetupProps {
  modelReady: boolean;
  loading: boolean;
  modelLabel?: string;
  autonomy?: AutonomyPolicy;
  appearance: AppearanceControl;
  starting: boolean;
  canStart: boolean;
  onSettings(trigger: HTMLButtonElement, section?: "models" | "autonomy"): void;
  onStart(): void;
}

/** Empty-workspace guidance only. This component never stores credentials, saves model/policy
 * choices, starts a task or grants permissions. Those actions remain in their existing controls.
 */
export function WelcomeSetup(props: WelcomeSetupProps) {
  const phone = useMediaQuery(PHONE);
  const policy = AutonomyPolicy.safeParse(props.autonomy ?? DEFAULT_AUTONOMY);
  return (
    <section className="welcome-setup" aria-labelledby="welcome-title">
      <div className="welcome-layout">
        <div className="welcome-hero">
          <Dot size={phone ? 64 : 96} state={props.starting ? "waking" : "idle"} />
          <h1 id="welcome-title" className="welcome-title">
            Set up localDot
          </h1>
          <p className="welcome-lede">Three quick choices, then turn on your computer.</p>
          <Button
            variant="primary"
            size="lg"
            className="welcome-start"
            busy={props.starting}
            disabledReason={
              props.canStart || props.starting ? undefined : "Looking for your computer…"
            }
            onClick={props.onStart}
          >
            Turn on
          </Button>
          <p className="welcome-note">
            {props.loading
              ? ""
              : props.modelReady
                ? "Then tell dot what to do in the conversation."
                : "You can turn it on while you choose a model."}
          </p>
        </div>
        <ScrollArea className="welcome-scroll">
          <ol className="welcome-steps">
            <Step
              title="Model"
              state={props.modelReady ? "done" : "todo"}
              detail={
                props.loading
                  ? "Checking your saved model…"
                  : props.modelReady
                    ? (props.modelLabel ?? "Your saved model")
                    : "Choose the model dot thinks with."
              }
              action={
                <Button
                  size="sm"
                  aria-label={props.modelReady ? "Change model" : "Choose model"}
                  onClick={(event) => props.onSettings(event.currentTarget)}
                >
                  {props.modelReady ? "Change" : "Choose"}
                </Button>
              }
            />
            <Step
              title="Appearance"
              state="done"
              detail={
                props.appearance.saved
                  ? undefined
                  : "Applied for this visit. This browser couldn't save it."
              }
            >
              <AppearancePicker appearance={props.appearance} aria-label="Theme" />
            </Step>
            <Step
              title="When dot checks with you"
              state={props.loading ? "todo" : policy.success ? "done" : "failed"}
              detail={
                props.loading
                  ? "Checking your saved choices…"
                  : policy.success
                    ? checksSummary(policy.data)
                    : "Your choices couldn't be read. Review them in Settings."
              }
              action={
                <Button
                  size="sm"
                  aria-label="Review when dot checks with you"
                  onClick={(event) => props.onSettings(event.currentTarget, "autonomy")}
                >
                  Review
                </Button>
              }
            />
          </ol>
        </ScrollArea>
      </div>
    </section>
  );
}

function Step({
  title,
  state,
  detail,
  action,
  children,
}: {
  title: string;
  state: GlyphState;
  detail?: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="welcome-step" data-state={state}>
      <StatusGlyph state={state} className="welcome-step-glyph" />
      <h2 className="welcome-step-title">{title}</h2>
      {action && <div className="welcome-step-action">{action}</div>}
      {detail && <p className="welcome-step-detail">{detail}</p>}
      {children && <div className="welcome-step-extra">{children}</div>}
    </li>
  );
}
