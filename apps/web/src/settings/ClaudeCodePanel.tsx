import { CommandChip } from "../shell/CommandChip.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { claudeCodeSteps } from "./claude-code-steps.ts";
import type { ClaudeCodeControls } from "./useClaudeCode.ts";

// The main model on the user's own Claude Code: what's set up, what's left to do in Terminal, and
// a check that looks again. localDot never handles the Claude sign-in itself.
// Under a page that already names it, as in setup, the card goes without its own heading.
export function ClaudeCodePanel({
  claude,
  titled = true,
  id,
}: {
  claude: ClaudeCodeControls;
  titled?: boolean;
  id?: string;
}) {
  const status = claude.status;
  const ready = status?.state === "signed_in";
  return (
    <section
      id={id}
      className="settings-claude-code"
      {...(titled ? { "aria-labelledby": "claude-code-title" } : { "aria-label": "Claude Code" })}
    >
      {titled && (
        <header className="settings-card-head">
          <div>
            <h4 id="claude-code-title" className="settings-card-title">
              Claude Code (your plan)
            </h4>
            <p className="settings-card-note">
              dot works through the Claude Code on this Mac, with your own plan.
            </p>
          </div>
        </header>
      )}
      <ol className="settings-steps" aria-label="Setup">
        {claudeCodeSteps(status, claude.checking).map((step) => (
          <li key={step.id} className="settings-step" data-state={step.state}>
            <StatusGlyph state={step.state} className="settings-step-glyph" />
            <span className="settings-step-text">
              <span className="settings-step-name">{step.title}</span>
              <span className="settings-step-detail">{step.detail}</span>
            </span>
          </li>
        ))}
      </ol>
      {!ready && status?.command && (
        <div className="settings-claude-todo">
          <p className="settings-note">{status.reason}</p>
          <CommandChip text={status.command} />
        </div>
      )}
      {ready && (
        <p className="settings-note">
          Uses your plan's limits. localDot never sees your Claude sign-in.
        </p>
      )}
      <div className="settings-actions">
        <Button
          variant={ready ? "secondary" : "primary"}
          busy={claude.checking}
          onClick={() => void claude.check()}
        >
          Check again
        </Button>
      </div>
      {claude.error && (
        <p role="alert" className="settings-error">
          <Icon name="circle-alert" size={12} />
          <span>{claude.error}</span>
        </p>
      )}
    </section>
  );
}
