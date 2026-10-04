import { AutonomyMode, AutonomyPolicy, EDITABLE_ACTION_CLASSES } from "@localdot/protocol";

const labels = {
  reading: "Read information",
  browsing: "Browse websites",
  purchase: "Make purchases",
  send: "Send messages",
  post: "Publish posts",
  delete: "Delete files or data",
  download_execute: "Download and run files",
  system_settings: "Change system settings",
};
export function SafetySettings({
  value,
  disabled,
  onChange,
}: {
  value: AutonomyPolicy;
  disabled?: boolean;
  onChange(value: AutonomyPolicy): void;
}) {
  const parsed = AutonomyPolicy.safeParse(value);
  if (!parsed.success)
    return <p role="alert">Autonomy settings could not be verified. Reload saved settings.</p>;
  return (
    <fieldset className="role-editor safety-settings" disabled={disabled}>
      <legend>When the computer should ask</legend>
      <p>Saved choices apply to new tasks. Your current task keeps its starting policy.</p>
      {EDITABLE_ACTION_CLASSES.map((key) => (
        <label key={key}>
          <span>{labels[key]}</span>
          <select
            aria-label={labels[key]}
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
      <p>
        Credentials always require safe handoff. Unrecognized actions always require a decision.
      </p>
    </fieldset>
  );
}
