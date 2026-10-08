import { AutonomyPolicy, DEFAULT_AUTONOMY, EDITABLE_ACTION_CLASSES } from "@localdot/protocol";
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
  const policy = AutonomyPolicy.safeParse(props.autonomy ?? DEFAULT_AUTONOMY);
  const counts = { act: 0, ask: 0, handoff: 0 };
  if (policy.success) for (const action of EDITABLE_ACTION_CLASSES) counts[policy.data[action]]++;
  return (
    <section className="welcome-setup" aria-labelledby="welcome-title">
      <header>
        <p className="welcome-eyebrow">YOUR WORKSPACE</p>
        <h1 id="welcome-title">Set up localDot</h1>
        <p>Choose a model, make it yours, then start your first task.</p>
      </header>
      <ol className="welcome-steps">
        <li>
          <span className="welcome-number" aria-hidden="true">
            1
          </span>
          <div>
            <h2>Model and keys</h2>
            <p role="status">
              {props.loading
                ? "Checking saved settings…"
                : props.modelReady
                  ? `Ready · ${props.modelLabel ?? "Your saved model"}`
                  : "Choose a main model and connect its provider in Settings."}
            </p>
            <button type="button" onClick={(event) => props.onSettings(event.currentTarget)}>
              {props.modelReady ? "Change model" : "Choose model"}
            </button>
          </div>
        </li>
        <li>
          <span className="welcome-number" aria-hidden="true">
            2
          </span>
          <div>
            <h2>Make it yours</h2>
            <AppearancePicker appearance={props.appearance} />
          </div>
        </li>
        <li>
          <span className="welcome-number" aria-hidden="true">
            3
          </span>
          <div>
            <h2>Your autonomy defaults</h2>
            <p>
              {props.loading
                ? "Loading your defaults…"
                : policy.success
                  ? `${counts.act} action types can act · ${counts.ask} ask first · ${counts.handoff} hand off to you`
                  : "Defaults are unavailable. Reload Settings before continuing."}
            </p>
            <button
              type="button"
              onClick={(event) => props.onSettings(event.currentTarget, "autonomy")}
            >
              Review autonomy
            </button>
          </div>
        </li>
      </ol>
      <footer>
        <div>
          <h2>Ready for your first task?</h2>
          <p>
            {props.modelReady
              ? "Turn on your computer, then describe what you want in the conversation."
              : "Turn on your computer while you choose a model."}
          </p>
        </div>
        <button
          className="welcome-primary"
          type="button"
          aria-disabled={props.canStart ? undefined : true}
          onClick={() => {
            if (props.canStart) props.onStart();
          }}
        >
          {props.starting ? "Starting…" : "Turn on"}
        </button>
      </footer>
    </section>
  );
}
