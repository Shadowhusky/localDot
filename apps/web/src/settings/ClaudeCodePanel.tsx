import { t, tr } from "../i18n/index.ts";
import { CommandChip } from "../shell/CommandChip.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { RadioCards } from "../ui/RadioCards.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { claudeCodeSteps } from "./claude-code-steps.ts";
import type { ClaudeCodeControls } from "./useClaudeCode.ts";

// The main model on the user's own Claude Code: what's set up, what's left to do in Terminal, and
// a check that looks again. localDot never handles the Claude sign-in itself.
// Under a page that already names it, as in setup, the card goes without its own heading.
// Each dot can sign in to a Claude account of its own; the one on this Mac is the default.
const ACCOUNTS = [
  {
    value: "mac",
    label: tr("Use the Claude account signed in on this Mac"),
    description: tr("The same account as Claude Code in Terminal."),
  },
  {
    value: "dot",
    label: tr("Use a separate Claude account for this dot"),
    description: tr("You sign in to it once for this dot. Your other dots don't use it."),
  },
] as const;

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
  const installed = status?.state === "signed_in" || status?.state === "signed_out";
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
              {t`Claude Code (your plan)`}
            </h4>
            <p className="settings-card-note">
              {t`dot works through the Claude Code on this Mac, with your own plan.`}
            </p>
          </div>
        </header>
      )}
      {installed && (
        <RadioCards
          aria-label={t`Claude account`}
          value={status.separate ? "dot" : "mac"}
          onValueChange={(value) => {
            if (!claude.checking) void claude.chooseAccount(value === "dot");
          }}
          options={ACCOUNTS.map((option) => ({
            ...option,
            ...(claude.checking ? { disabledReason: t`Checking Claude Code…` } : {}),
          }))}
        />
      )}
      <ol className="settings-steps" aria-label={t`Setup`}>
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
          {status.separate
            ? t`Uses this dot's own Claude account and its plan's limits. localDot never sees your Claude sign-in.`
            : t`Uses your plan's limits. localDot never sees your Claude sign-in.`}
        </p>
      )}
      <div className="settings-actions">
        <Button
          variant={ready ? "secondary" : "primary"}
          busy={claude.checking}
          onClick={() => void claude.check()}
        >
          {t`Check again`}
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
