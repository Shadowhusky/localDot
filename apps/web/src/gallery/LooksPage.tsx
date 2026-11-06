import { PERSONAS, type PersonaId, type Wearable, Wearable as Wearables } from "@localdot/protocol";
import { conversationLook, conversationRows } from "../agent/conversation-list.ts";
import { DotAvatar } from "../dot/DotAvatar.tsx";
import { ConversationAvatar } from "../shell/ConversationAvatar.tsx";
import "../ui/conversations-layout.css";

const STATUSES = ["done", "stopped", "failed", "working", "needs-you", "idle"] as const;
const TASKS = Array.from(
  { length: 32 },
  (_, n) => `01M6K1VH23${String(n * 7919).padStart(16, "A")}`,
);
const NEIGHBOURS: (PersonaId | undefined)[] = [
  undefined,
  undefined,
  "coder",
  "research",
  undefined,
  "design",
  "video",
  "finance",
];

const rowFor = (id: string, persona: PersonaId | undefined, at: number) => {
  const status = STATUSES[at % STATUSES.length];
  return conversationRows(
    [
      {
        sessionId: id,
        sessions: [id],
        title: "A task",
        said: null,
        startedAt: "2026-10-08T09:00:00.000Z",
        ended: status === "failed" ? "error" : status === "stopped" ? "stopped" : "done",
        ...(persona ? { persona } : {}),
        ...(status === "working" || status === "needs-you" || status === "idle"
          ? {
              ended: null,
              live: {
                state: status,
                since: "2026-10-08T09:00:00.000Z",
                onScreen: false,
              },
            }
          : {}),
      },
    ],
    { live: null, needsYou: new Set() },
  )[0];
};

function Wardrobe({ size }: { size: number }) {
  return (
    <div className="gallery-looks-row">
      {Wearables.options.map((name: Wearable) => (
        <figure key={name} title={name}>
          <DotAvatar size={size} wearables={[name]} seed="1" />
        </figure>
      ))}
    </div>
  );
}

// Every wearable alone, a list's worth of neighbours with their statuses, and each dot's own tasks,
// for the eye.
export function LooksPage() {
  return (
    <div className="gallery-helpers">
      <Wardrobe size={96} />
      <Wardrobe size={32} />
      <div className="gallery-looks-row">
        {TASKS.map((id, at) => {
          const row = rowFor(id, NEIGHBOURS[at % NEIGHBOURS.length], at);
          return row && <ConversationAvatar key={id} row={row} />;
        })}
      </div>
      {Object.values(PERSONAS).map((persona) => (
        <div key={persona.id} className="gallery-looks-row">
          {TASKS.slice(0, 16).map((id) => (
            <DotAvatar key={id} size={48} wearables={lookOf(id, persona.id)} seed={id} />
          ))}
        </div>
      ))}
    </div>
  );
}

const lookOf = (id: string, persona: PersonaId) => {
  const row = rowFor(id, persona, 0);
  return row ? conversationLook(row.entry) : [];
};
