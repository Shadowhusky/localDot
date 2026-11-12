import type { AgentRoleChoice } from "@localdot/protocol";
import { t } from "../i18n/index.ts";
import { Switch } from "../ui/Switch.tsx";

// Why Auto can't pick: a ChatGPT plan's one Codex process is the task's, with nothing to spare
// for the quick request that picks.
export function autoDotReason(main: AgentRoleChoice | undefined): string | undefined {
  return main?.provider === "chatgpt"
    ? t`Not with the ChatGPT plan, which answers one request at a time.`
    : undefined;
}

// Auto picks each new conversation's dot in the quick request that names the conversation, so it
// asks nothing extra; what it costs is the moment the task waits for the pick.
export function AutoDot({
  on,
  onChange,
  disabledReason,
  className,
}: {
  on: boolean;
  onChange(on: boolean): void;
  disabledReason?: string;
  className?: string;
}) {
  return (
    <Switch
      className={className}
      label={t`Auto`}
      description={t`Picks each new conversation's dot in the quick request that names it. A new task may wait up to 4 seconds for it.`}
      checked={on && !disabledReason}
      {...(disabledReason ? { disabledReason } : {})}
      onCheckedChange={(checked) => onChange(checked)}
    />
  );
}

export function dotChoiceNote(auto: boolean): string {
  return auto
    ? t`When Auto can't pick in time, the dot chosen here works the task.`
    : t`Your choice applies from the next task.`;
}
