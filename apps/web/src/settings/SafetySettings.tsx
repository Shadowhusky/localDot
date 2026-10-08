import { type ActionClass, AutonomyMode, AutonomyPolicy } from "@localdot/protocol";
import { AUTONOMY_PRESETS, CLASS_LABELS, CUSTOM_SUMMARY, presetOf } from "../copy/autonomy.ts";
import type { RulesView } from "./useRules.ts";

const ROWS = [
  "reading",
  "browsing",
  "computer",
  "download_execute",
  "memory",
  "send",
  "post",
  "delete",
  "system_settings",
  "purchase",
] as const satisfies readonly (keyof AutonomyPolicy)[];
const locked = (policy: AutonomyPolicy): readonly [ActionClass, string][] => [
  ["upload", policy.send === "handoff" ? "Hand off, like sending" : "Ask"],
  ["credentials", "Hand off"],
  ["unknown", "Ask"],
];
export function SafetySettings({
  value,
  disabled,
  onChange,
  rules,
}: {
  value: AutonomyPolicy;
  disabled?: boolean;
  onChange(value: AutonomyPolicy): void;
  rules?: RulesView;
}) {
  const parsed = AutonomyPolicy.safeParse(value);
  if (!parsed.success)
    return <p role="alert">Autonomy settings could not be verified. Reload saved settings.</p>;
  const active = presetOf(parsed.data);
  return (
    <>
      <fieldset className="role-editor safety-settings" disabled={disabled}>
        <legend>When the computer should ask</legend>
        <p>Saved choices apply to new tasks. Your current task keeps its starting policy.</p>
        <div className="safety-presets">
          {AUTONOMY_PRESETS.map((preset) => (
            <button
              key={preset.name}
              type="button"
              aria-pressed={preset === active}
              onClick={() => {
                if (preset !== active) onChange(AutonomyPolicy.parse({ ...preset.policy }));
              }}
            >
              {preset.name}
            </button>
          ))}
        </div>
        <p className="safety-preset-note">
          {active ? active.summary : `Custom: ${CUSTOM_SUMMARY.toLowerCase()}`}
        </p>
        {ROWS.map((key) => (
          <label key={key}>
            <span>{CLASS_LABELS[key]}</span>
            <select
              aria-label={CLASS_LABELS[key]}
              value={parsed.data[key]}
              onChange={(event) => {
                const mode = AutonomyMode.safeParse(event.target.value);
                if (mode.success)
                  onChange(AutonomyPolicy.parse({ ...parsed.data, [key]: mode.data }));
              }}
            >
              <option value="act">Act</option>
              <option value="ask">Ask</option>
              <option value="handoff">Hand off</option>
            </select>
          </label>
        ))}
        <ul className="safety-locked" aria-label="Can't be changed here">
          {locked(parsed.data).map(([key, mode]) => (
            <li key={key}>
              <span>{CLASS_LABELS[key]}</span>
              <span>{mode}</span>
            </li>
          ))}
        </ul>
        <p className="safety-hint">
          Always allow can cover uploads and unclear steps for one task only. Once you sign in on
          its computer, commands count as unclear steps.
        </p>
      </fieldset>
      {rules && <AlwaysAllowed rules={rules} />}
    </>
  );
}

function AlwaysAllowed({ rules }: { rules: RulesView }) {
  const busy = rules.removing !== null || rules.resetting;
  return (
    <fieldset className="role-editor safety-rules">
      <legend>Always allowed</legend>
      <p>Choices you made with Always allow on a request. Removing one takes effect right away.</p>
      {rules.unreadable && (
        <div className="safety-rules-problem" role="alert">
          <p className="safety-rules-message">
            {rules.unreadable} Start over to save new choices. The old file is kept, not deleted.
          </p>
          <button
            type="button"
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) rules.reset();
            }}
          >
            {rules.resetting ? "Starting over…" : "Start over"}
          </button>
          {rules.resetFailed && (
            <p className="safety-rules-failed">Couldn't start over. Try again.</p>
          )}
        </div>
      )}
      {rules.phase === "error" && (
        <div className="safety-rules-problem">
          <p className="safety-rules-message">Couldn't load this list.</p>
          <button type="button" onClick={rules.reload}>
            Try again
          </button>
        </div>
      )}
      {rules.phase === "loading" && !rules.rules.length && <p role="status">Loading…</p>}
      {rules.phase === "ready" && !rules.unreadable && !rules.rules.length && (
        <p>Nothing yet. Use Always allow on a request to add one.</p>
      )}
      {rules.rules.length > 0 && (
        <ul aria-label="Always allowed">
          {rules.rules.map((rule) => {
            const name = CLASS_LABELS[rule.actionClass];
            return (
              <li key={rule.id}>
                <span className="safety-rule-text">
                  <span>{name}</span>
                  <span className="safety-rule-where">{rule.label}</span>
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${name}: ${rule.label}`}
                  aria-disabled={busy || undefined}
                  onClick={() => {
                    if (!busy) rules.remove(rule.id);
                  }}
                >
                  {rules.removing === rule.id ? "Removing…" : "Remove"}
                </button>
                {rules.failed === rule.id && <p role="status">Couldn't remove this. Try again.</p>}
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
}
