import { PERSONAS, type PersonaId } from "@localdot/protocol";
import { useRef, useState } from "react";
import { Dot } from "../dot/Dot.tsx";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { Button } from "../ui/Button.tsx";
import { Menu, MenuItem } from "../ui/Menu.tsx";
import { triggerProps } from "../ui/Popover.tsx";
import type { AgentDotChoice } from "./model.ts";

export function dotChoiceLine(choice: AgentDotChoice): string {
  const name = PERSONAS[choice.persona].name;
  if (choice.by === "user") return `You chose ${name} for this conversation`;
  if (choice.by === "default") return `Working as ${name}, your default: Auto had no quick answer`;
  return `Auto chose ${name}`;
}

// Which dot works the conversation while Auto is on, and why, with the way to change it for the
// task at work: the agent carries on as the new dot.
export function DotChoice({
  choice,
  task,
}: {
  choice: AgentDotChoice;
  // The task at work, when this line is the conversation's latest choice.
  task?: { api: ApiClient; sessionId: string };
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = async (persona: PersonaId) => {
    if (!task || busy) return;
    setBusy(true);
    setError(null);
    try {
      await task.api.post(`/api/agent/sessions/${task.sessionId}/persona`, { persona });
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 409
          ? "Answer what dot is waiting on, then change its dot."
          : "The dot couldn't be changed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="thread-dot">
      <Dot size={24} wearables={PERSONAS[choice.persona].wearables} />
      <p className="thread-dot-text">
        <span className="thread-dot-name">{dotChoiceLine(choice)}</span>
        {choice.reason && ` · ${choice.reason}`}
        {error && (
          <span className="thread-dot-error" role="alert">
            {error}
          </span>
        )}
      </p>
      {task && (
        <>
          <Button
            ref={anchor}
            variant="quiet"
            size="sm"
            busy={busy}
            {...triggerProps("menu", open)}
            onClick={() => setOpen(true)}
          >
            Change
          </Button>
          <Menu
            open={open}
            onClose={() => setOpen(false)}
            anchor={anchor}
            label="Dot for this task"
            align="end"
          >
            {Object.values(PERSONAS).map((persona) => (
              <MenuItem
                key={persona.id}
                checked={persona.id === choice.persona}
                onSelect={() => void change(persona.id)}
              >
                {persona.name}
              </MenuItem>
            ))}
          </Menu>
        </>
      )}
    </div>
  );
}
