import { Badge } from "../ui/Badge.tsx";

export interface SkillSummary {
  readonly name: string;
  readonly description: string;
  readonly source: string;
}

// Descriptions are plain text, never markup.
export function SkillsView({ skills }: { skills: readonly SkillSummary[] }) {
  if (!skills.length) return <p className="activity-detail-note">No skills yet.</p>;
  return (
    <ul className="skills-list" aria-label="Available skills">
      {skills.map((skill) => (
        <li key={`${skill.source}:${skill.name}`} className="skills-item">
          <span className="skills-name">{skill.name}</span>
          <Badge>{skill.source === "user" ? "Yours" : "Built in"}</Badge>
          <span className="skills-description">{skill.description}</span>
        </li>
      ))}
    </ul>
  );
}
