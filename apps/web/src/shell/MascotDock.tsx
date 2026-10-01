import { Mascot } from "./Mascot.tsx";

export function MascotDock() {
  return (
    <div className="dock">
      <Mascot />
      <div className="input" aria-disabled="true">
        <span>Message dot…</span>
      </div>
    </div>
  );
}
