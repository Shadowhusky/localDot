import { Button } from "../ui/Button.tsx";
import { SkillsView } from "./SkillsView.tsx";
import type { Knowledge } from "./useKnowledge.ts";

export function KnowledgeView({ knowledge }: { knowledge: Knowledge }) {
  const checking = knowledge.skillsPhase === "loading";
  const reading = knowledge.memoryPhase === "loading";
  return (
    <section className="knowledge-view" aria-label="Skills and memory">
      <h4 className="knowledge-head">Skills</h4>
      {knowledge.skillsPhase === "ready" ? (
        <SkillsView skills={knowledge.skills} />
      ) : (
        <p role="status" className="activity-detail-note">
          {checking ? "Checking skills…" : "Skills haven't been checked yet."}
        </p>
      )}
      <div className="activity-detail-actions">
        <Button variant="quiet" size="sm" busy={checking} onClick={knowledge.reloadSkills}>
          Check skills
        </Button>
      </div>
      <h4 className="knowledge-head">Memory</h4>
      <p className="activity-detail-note">
        Read what dot has stored before you settle an undo conflict.
      </p>
      <div className="activity-detail-actions">
        <Button variant="quiet" size="sm" busy={reading} onClick={knowledge.rereadMemory}>
          Read current memory
        </Button>
      </div>
      {knowledge.memoryPhase === "error" && (
        <p role="status" className="activity-detail-note">
          Memory couldn't be read. Check the connection and try again.
        </p>
      )}
      {knowledge.memory && (
        <>
          <h5 className="knowledge-file">USER.md</h5>
          <pre className="knowledge-text">{knowledge.memory.user}</pre>
          <h5 className="knowledge-file">MEMORY.md</h5>
          <pre className="knowledge-text">{knowledge.memory.memory}</pre>
        </>
      )}
    </section>
  );
}
