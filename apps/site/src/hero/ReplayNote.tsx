import { LANG, t } from "../i18n.ts";

// Where the app keeps its composer. Nothing typed here would reach dot, so instead of a field that
// looks like it would, it says in one line what the visitor is watching.
export function ReplayNote({ model }: { model?: string }) {
  const [lead, rest] = model
    ? [t("A replay."), t("A real task with {model}, sped up.", { model })]
    : [t("These are replays."), t("Real tasks dot did, sped up.")];
  // Chinese runs on after its comma; English takes a space.
  const gap = LANG === "zh" ? "" : " ";
  return (
    <div className="composer site-replay">
      <p title={`${lead}${gap}${rest}`}>
        <strong>{lead}</strong>
        {gap}
        {rest}
      </p>
    </div>
  );
}
