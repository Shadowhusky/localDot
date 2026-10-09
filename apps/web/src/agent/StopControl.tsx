import { Button } from "../ui/Button.tsx";
import type { TaskControls } from "./useTaskControls.ts";
import "./controls.css";
// Under the island its label already says Stopping…, so only the outcome is noted there.
export function StopControl({
  controls,
  inIsland = false,
}: {
  controls: TaskControls;
  inIsland?: boolean;
}) {
  const status = controls.stopStatus;
  return (
    <>
      {status.phase !== "idle" && !(inIsland && status.phase === "sending") && (
        <section className="control-status" aria-label="Stop status">
          <p role="status">
            {status.phase === "sending"
              ? "Stopping…"
              : status.phase === "paused"
                ? "Stopped. Your computer is paused."
                : status.phase === "stopped"
                  ? "Stopped. Your computer is off."
                  : "Could not confirm stopped. Check the connection and try Stop again."}
          </p>
          {!!status.errors.length && (
            <div>
              <p>Some cleanup could not be confirmed:</p>
              <ul>
                {status.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </div>
          )}
          {status.phase === "unconfirmed" && (
            <Button variant="quiet" size="sm" onClick={controls.recheck}>
              Check task and computer
            </Button>
          )}
        </section>
      )}
    </>
  );
}
