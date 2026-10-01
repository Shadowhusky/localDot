import { MascotDock } from "./MascotDock.tsx";

export function ConversationRail() {
  return (
    <aside className="rail" aria-label="Conversation">
      <div className="rail-h">
        <span>Conversation</span>
      </div>
      <div className="msgs">
        <p className="say empty">
          Your conversation with dot appears here once the first task starts.
        </p>
      </div>
      <MascotDock />
    </aside>
  );
}
