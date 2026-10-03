import type { AgentModel } from "./model.ts";

export function PlanView({ plan }: { plan: AgentModel["plan"] }) {
  const done = plan.filter((item) => item.status === "done").length;
  return (
    <section className="plan-view" aria-label="Plan progress">
      <div className="activity-heading">
        <h3>Plan</h3>
        <span>
          {done} of {plan.length} completed
        </span>
      </div>
      <ol className="task-plan" aria-label="Task plan">
        {plan.map((item, index) => (
          <li key={item.id} className={`plan-${item.status}`}>
            <span className="plan-state">
              {index + 1}.{" "}
              {
                { todo: "Next", doing: "In progress", done: "Done", skipped: "Skipped" }[
                  item.status
                ]
              }
            </span>
            <span>{item.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
