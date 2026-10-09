import type { RecentTask } from "@localdot/protocol";
import { Collapse } from "../../ui/Disclosure.tsx";
import { Group, GroupHead } from "../../ui/Group.tsx";
import { Switch } from "../../ui/Switch.tsx";
import { dayLabel, OUTCOME } from "./memory-copy.ts";

export interface RecentActivityControl {
  on: boolean;
  change(on: boolean): void;
}

// What each new task hears about the user's last few: their own titles, how each ended and when.
export function RecentActivity({
  control,
  tasks,
}: {
  control: RecentActivityControl;
  tasks: readonly RecentTask[];
}) {
  return (
    <section className="memory-section" aria-labelledby="recent-title">
      <GroupHead id="recent-title" title="Recent activity" />
      <Group>
        <Switch
          className="ui-group-row"
          label="Tell dot about recent tasks"
          description="New tasks start with how your last five went, so dot picks up where you left off."
          checked={control.on}
          onCheckedChange={control.change}
        />
        <Collapse open={control.on && tasks.length > 0}>
          <ul className="memory-list memory-recent" aria-label="Recent tasks dot hears about">
            {tasks.map((task) => (
              <li key={task.sessionId} className="ui-group-row">
                <div className="ui-group-row-line">
                  <span className="ui-group-row-text">
                    <span className="memory-recent-title">{task.title}</span>
                  </span>
                  <span className="ui-group-row-trailing memory-recent-meta">
                    {OUTCOME[task.outcome]} · {dayLabel(task.day)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Collapse>
      </Group>
    </section>
  );
}
