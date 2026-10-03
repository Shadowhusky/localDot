export interface SkillSummary {
  readonly name: string;
  readonly description: string;
  readonly source: string;
}
export function SkillsView({ skills }: { skills: readonly SkillSummary[] }) {
  return (
    <section className="skills-view" aria-label="Available skills">
      <h3>Skills</h3>
      {!skills.length ? (
        <p>No skills are listed.</p>
      ) : (
        <ul>
          {skills.map((skill) => (
            <li key={`${skill.source}:${skill.name}`}>
              <strong>{skill.name}</strong>
              <p>{skill.description}</p>
              <span>{skill.source}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="history-note">Skills are read-only here.</p>
    </section>
  );
}
