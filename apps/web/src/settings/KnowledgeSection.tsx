import type { Knowledge } from "../agent/useKnowledge.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Group, GroupHead, GroupRow } from "../ui/Group.tsx";
import { Skeleton } from "../ui/Skeleton.tsx";
import { MemoryEditor } from "./memory/MemoryEditor.tsx";
import { PeopleList } from "./memory/PeopleList.tsx";
import { RecentActivity, type RecentActivityControl } from "./memory/RecentActivity.tsx";
import type { WhatDotKnows } from "./memory/useWhatDotKnows.ts";

// What dot remembers, who it reaches for the user, what it hears about recent tasks, and the
// skills it can use.
export function KnowledgeSection({
  knowledge,
  known,
  recentActivity,
  onOpenTask,
}: {
  knowledge: Knowledge;
  known: WhatDotKnows;
  recentActivity?: RecentActivityControl;
  onOpenTask?(sessionId: string): void;
}) {
  const checking = knowledge.skillsPhase === "loading" || knowledge.skillsPhase === "unknown";
  return (
    <div className="settings-knowledge">
      <p className="settings-lede">
        What dot remembers, the people it reaches and your recent tasks. It all stays on the
        computer running localDot.
      </p>
      <MemoryEditor known={known} knowledge={knowledge} onOpenTask={onOpenTask} />
      <PeopleList known={known} onOpenTask={onOpenTask} />
      {recentActivity && <RecentActivity control={recentActivity} tasks={known.recent} />}
      <div>
        <GroupHead title="Skills" />
        {knowledge.skillsPhase === "error" ? (
          <Group>
            <GroupRow
              label="Couldn't load skills"
              trailing={
                <Button variant="quiet" size="sm" onClick={knowledge.reloadSkills}>
                  Try again
                </Button>
              }
            />
          </Group>
        ) : checking ? (
          <Group aria-busy="true">
            <GroupRow
              label={<Skeleton loading width="12ch" />}
              detail={<Skeleton loading width="28ch" />}
            />
          </Group>
        ) : knowledge.skills.length ? (
          <Group>
            <ul className="settings-skills" aria-label="Skills">
              {knowledge.skills.map((skill) => (
                <li key={`${skill.source}:${skill.name}`}>
                  <GroupRow
                    label={skill.name}
                    detail={<span className="settings-skill-description">{skill.description}</span>}
                    trailing={<Badge>{skill.source === "user" ? "Yours" : "Built in"}</Badge>}
                  />
                </li>
              ))}
            </ul>
          </Group>
        ) : (
          <Group>
            <EmptyState icon="book" title="No skills yet" />
          </Group>
        )}
      </div>
    </div>
  );
}
