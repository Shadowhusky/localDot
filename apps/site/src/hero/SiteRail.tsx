import type { ConversationRow } from "@app/agent/conversation-list.ts";
import "@app/ui/conversations-layout.css";
import "@app/shell/rails.css";
import { ConversationAvatar } from "@app/shell/ConversationAvatar.tsx";
import { Button } from "@app/ui/Button.tsx";
import { t } from "../i18n.ts";
import { DEMOS, type DemoEntry, lookOf } from "./catalog.ts";

const row = (entry: DemoEntry, playing: boolean): ConversationRow => ({
  entry: {
    sessionId: entry.id,
    sessions: [entry.id],
    title: entry.ask,
    said: null,
    startedAt: "",
    ended: "done",
    firstTask: entry.id,
    look: lookOf(entry),
  },
  title: entry.ask,
  status: playing ? "working" : "done",
  active: playing,
  since: "",
});

// The app's rail of conversations, folded to their dots: each task here, with the dot it has, and a
// press away.
export function SiteRail({
  current,
  playing,
  onPick,
}: {
  current?: string;
  playing: boolean;
  onPick(entry: DemoEntry): void;
}) {
  return (
    <nav className="sessions site-rail" aria-label={t("Tasks")}>
      <ul className="sessions-list">
        {DEMOS.map((entry) => {
          const here = entry.id === current;
          return (
            <li key={entry.id} className="sessions-item" data-current={here || undefined}>
              <span className="sessions-selection" aria-hidden="true" />
              <Button
                variant="quiet"
                className="sessions-row"
                aria-label={t(entry.ask)}
                aria-current={here || undefined}
                onClick={() => onPick(entry)}
              >
                <ConversationAvatar row={row(entry, here && playing)} />
              </Button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
