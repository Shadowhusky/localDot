import { SkillsView } from "./SkillsView.tsx";
import type { Knowledge } from "./useKnowledge.ts";
import "./usage.css";
export function KnowledgeView({ knowledge }: { knowledge: Knowledge }) {
  return (
    <section className="knowledge-view" aria-label="Skills and memory">
      {knowledge.skillsPhase === "ready" ? (
        <SkillsView skills={knowledge.skills} />
      ) : (
        <p role="status">
          {knowledge.skillsPhase === "loading"
            ? "Loading skills…"
            : "Skills have not been verified."}
        </p>
      )}
      <button
        type="button"
        disabled={knowledge.skillsPhase === "loading"}
        onClick={knowledge.reloadSkills}
      >
        Check skills
      </button>
      <h3>Current memory</h3>
      <p>
        Reread the stored files before resolving an undo conflict. Recorded diffs stay in task
        history.
      </p>
      <button
        type="button"
        disabled={knowledge.memoryPhase === "loading"}
        onClick={knowledge.rereadMemory}
      >
        Read current memory
      </button>
      {knowledge.memoryPhase === "loading" && <p role="status">Reading memory…</p>}
      {knowledge.memoryPhase === "error" && (
        <p role="status">
          Memory could not be verified. Check the connection before reading again.
        </p>
      )}
      {knowledge.memory && (
        <>
          <h4>USER.md</h4>
          <pre>{knowledge.memory.user}</pre>
          <h4>MEMORY.md</h4>
          <pre>{knowledge.memory.memory}</pre>
        </>
      )}
    </section>
  );
}
