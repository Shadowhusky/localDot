import { Mascot } from "./Mascot.tsx";

export function TopBar({ title, live }: { title: string; live: boolean }) {
  return (
    <header className="bar">
      <div className="bar-l">
        <span className="brand">
          <Mascot />
          localDot
        </span>
        <span className="title">{title}</span>
      </div>
      <nav className="modes" aria-label="Mode">
        <span aria-disabled="true">Glance</span>
        <span className="on" aria-current="page">
          Watch
        </span>
        <span aria-disabled="true">Replay</span>
      </nav>
      <div className="bar-r">
        <span className={live ? "live on" : "live"}>
          <b aria-hidden="true" />
          {live ? "Live" : "Offline"}
        </span>
      </div>
    </header>
  );
}
