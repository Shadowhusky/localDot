import type { Knowledge } from "../agent/useKnowledge.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";

// Read only: the skills dot can use and the notes it keeps.
export function KnowledgeSection({ knowledge }: { knowledge: Knowledge }) {
  const checking = knowledge.skillsPhase === "loading" || knowledge.skillsPhase === "unknown";
  const reading = knowledge.memoryPhase === "loading";
  return (
    <div className="settings-knowledge">
      <h4 className="settings-group-title">Skills</h4>
      {knowledge.skillsPhase === "error" ? (
        <div className="settings-inline">
          <p className="settings-note">Skills couldn't be read.</p>
          <Button variant="quiet" size="sm" onClick={knowledge.reloadSkills}>
            Try again
          </Button>
        </div>
      ) : checking ? (
        <p role="status" className="settings-note">
          Reading skills…
        </p>
      ) : knowledge.skills.length ? (
        <ul className="settings-skills" aria-label="Skills">
          {knowledge.skills.map((skill) => (
            <li key={`${skill.source}:${skill.name}`}>
              <span className="settings-skill-name">{skill.name}</span>
              <Badge>{skill.source === "user" ? "Yours" : "Built in"}</Badge>
              <span className="settings-skill-description">{skill.description}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-note">No skills yet.</p>
      )}
      <h4 className="settings-group-title">Memory</h4>
      {knowledge.memory ? (
        <>
          <p className="settings-label">About you</p>
          <pre className="settings-well">{knowledge.memory.user || "Nothing yet."}</pre>
          <p className="settings-label">Its notes</p>
          <pre className="settings-well">{knowledge.memory.memory || "Nothing yet."}</pre>
        </>
      ) : (
        <div className="settings-inline">
          <p className="settings-note">
            {knowledge.memoryPhase === "error"
              ? "Memory couldn't be read. Check the connection and try again."
              : "What dot remembers about you and your work."}
          </p>
          <Button variant="quiet" size="sm" busy={reading} onClick={knowledge.rereadMemory}>
            Show memory
          </Button>
        </div>
      )}
    </div>
  );
}
