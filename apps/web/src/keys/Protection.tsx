import { CommandChip } from "../shell/CommandChip.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Disclosure } from "../ui/Disclosure.tsx";
import { Group, GroupRow, IconTile } from "../ui/Group.tsx";
import type { IconName } from "../ui/icons.ts";
import type { KeydHealth } from "./keys-api.ts";

export const DOCTOR = "localdot doctor";

type Tone = "ok" | "wait" | "bad";

interface Status {
  name: string;
  state: string;
  tone: Tone;
  // Unhealthy: what it means, in one sentence, and the raw error behind it.
  problem?: string;
  details?: string;
}

const CHECKING: Pick<Status, "state" | "tone"> = { state: "Checking…", tone: "wait" };
const UNKNOWN: Pick<Status, "state" | "tone"> = { state: "Unknown", tone: "wait" };

export function protectionOf(health: KeydHealth | null): Status[] {
  const online = health?.online === true;
  const isolation: Status = !health
    ? { name: "Key isolation", ...CHECKING }
    : online
      ? { name: "Key isolation", state: "On", tone: "ok" }
      : {
          name: "Key isolation",
          state: "Off",
          tone: "bad",
          problem: "Keys can't be saved or used until it's back on.",
        };
  const audit: Status = !health
    ? { name: "Audit log", ...CHECKING }
    : !online
      ? { name: "Audit log", ...UNKNOWN }
      : health.audit?.ok === false
        ? {
            name: "Audit log",
            state: "Paused — keys held",
            tone: "bad",
            problem: "localDot can't record when keys are used, so it holds every key back.",
            details: health.audit.error,
          }
        : { name: "Audit log", state: "Recording", tone: "ok" };
  const guard = health?.hairpin;
  const network: Status = !health
    ? { name: "Network protection", ...CHECKING }
    : !online
      ? { name: "Network protection", ...UNKNOWN }
      : guard?.state === "active"
        ? { name: "Network protection", state: "On", tone: "ok" }
        : guard?.state === "off"
          ? {
              name: "Network protection",
              state: "Off",
              tone: "bad",
              problem:
                "Your computer could reach your router through this network's public address.",
              details: guard.error,
            }
          : {
              name: "Network protection",
              state: "Checking",
              tone: "bad",
              problem:
                "It's still finding this network's public address. Until then, your computer could reach your router through it.",
              details: guard?.error,
            };
  return [isolation, audit, network];
}

function Glyph({ tone }: { tone: Exclude<Tone, "ok"> }) {
  if (tone === "bad") return <Badge kind="dot" tone="attention" label="Needs attention" />;
  return <span className="keys-status-ring" aria-hidden="true" />;
}

const TILE: Record<string, IconName> = {
  "Key isolation": "lock",
  "Audit log": "file-text",
  "Network protection": "shield",
};

// What keeps keys safe, one row each, so a problem says what it means and how to fix it.
export function Protection({ health }: { health: KeydHealth | null }) {
  return (
    <Group>
      <ul className="keys-protection">
        {protectionOf(health).map((status) => (
          <li key={status.name} className="keys-status" data-tone={status.tone}>
            <GroupRow
              leading={<IconTile icon={TILE[status.name] ?? "shield"} />}
              label={status.name}
              trailing={
                <span className="keys-status-state">
                  {status.tone === "ok" ? null : <Glyph tone={status.tone} />}
                  <span>{status.state}</span>
                </span>
              }
            >
              {status.problem && (
                <div className="keys-status-help">
                  <p>{status.problem}</p>
                  <div className="keys-status-fix">
                    <span>To fix it, run this in Terminal:</span>
                    <CommandChip text={DOCTOR} />
                  </div>
                  {status.details && (
                    <Disclosure summary="Details" className="keys-status-details">
                      <p className="keys-raw">{status.details}</p>
                    </Disclosure>
                  )}
                </div>
              )}
            </GroupRow>
          </li>
        ))}
      </ul>
    </Group>
  );
}
