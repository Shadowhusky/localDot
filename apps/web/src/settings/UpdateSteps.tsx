import { t } from "../i18n/index.ts";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";

// The steps of an update, those behind it done and the one under way or failed marked.
export function UpdateSteps<Stage extends string>({
  stages,
  names,
  at,
  failed,
}: {
  stages: readonly Stage[];
  names: Record<Stage, string>;
  at: Stage;
  failed: boolean;
}) {
  const index = stages.indexOf(at);
  return (
    <ol className="settings-steps settings-update-steps" aria-label={t`Update steps`}>
      {stages.map((stage, i) => {
        const state = i < index ? "done" : i > index ? "todo" : failed ? "failed" : "doing";
        return (
          <li
            key={stage}
            className="settings-step"
            data-state={state}
            aria-current={state === "doing" ? "step" : undefined}
          >
            <StatusGlyph state={state} className="settings-step-glyph" />
            <span className="settings-step-text">
              <span className="settings-step-name">{names[stage]}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
