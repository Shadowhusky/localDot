import type { Knowledge } from "../agent/useKnowledge.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Group, GroupHead, GroupNote, GroupRow } from "../ui/Group.tsx";
import { Skeleton } from "../ui/Skeleton.tsx";

// Read only: the skills dot can use and the notes it keeps.
export function KnowledgeSection({ knowledge }: { knowledge: Knowledge }) {
  const checking = knowledge.skillsPhase === "loading" || knowledge.skillsPhase === "unknown";
  const reading = knowledge.memoryPhase === "loading";
  return (
    <div className="settings-knowledge">
      <div>
        <GroupHead title="Skills" />
        {knowledge.skillsPhase === "error" ? (
          <Group>
            <GroupRow
              label="Skills couldn't be read."
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
            <GroupRow label="No skills yet." />
          </Group>
        )}
      </div>
      <div>
        <GroupHead
          title="Memory"
          aside={
            !knowledge.memory && (
              <Button variant="quiet" size="sm" busy={reading} onClick={knowledge.rereadMemory}>
                Show memory
              </Button>
            )
          }
        />
        {knowledge.memory ? (
          <Group>
            <GroupRow label="About you">
              <pre className="settings-well">{knowledge.memory.user || "Nothing yet."}</pre>
            </GroupRow>
            <GroupRow label="Its notes">
              <pre className="settings-well">{knowledge.memory.memory || "Nothing yet."}</pre>
            </GroupRow>
          </Group>
        ) : (
          <GroupNote>
            {knowledge.memoryPhase === "error"
              ? "Memory couldn't be read. Check the connection and try again."
              : "What dot remembers about you and your work."}
          </GroupNote>
        )}
      </div>
    </div>
  );
}
