import { AutonomyMode, AutonomyPolicy, EDITABLE_ACTION_CLASSES } from "@localdot/protocol";

const labels: Record<(typeof EDITABLE_ACTION_CLASSES)[number], string> = {
  reading: "Read and look",
  browsing: "Browse websites",
  computer: "Work in its computer",
  purchase: "Buy or pay",
  send: "Send as you",
  post: "Post or publish as you",
  delete: "Delete your online data",
  download_execute: "Run downloaded programs",
  system_settings: "Change account settings",
  memory: "Save to its memory",
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
        Passwords, codes and card details are always handed to you. Uploads always need you. Unclear
        steps on signed-in sites always ask, and so do commands once you sign in on its computer.
      </p>
    </fieldset>
  );
}
