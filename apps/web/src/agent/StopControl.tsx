import type { TaskControls } from "./useTaskControls.ts";
import "./controls.css";
export function StopControl({ controls }: { controls: TaskControls }) {
  const status = controls.stopStatus;
  return (
    <>
      {status.phase !== "idle" && (
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
            <button type="button" onClick={controls.recheck}>
              Check task and computer
            </button>
          )}
        </section>
      )}
    </>
  );
}
