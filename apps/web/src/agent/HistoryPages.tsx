export function HistoryPages({
  label,
  older,
  newer,
  onOlder,
  onNewer,
}: {
  label: "messages" | "steps";
  older: boolean;
  newer: boolean;
  onOlder(): void;
  onNewer(): void;
}) {
  if (!older && !newer) return null;
  return (
    <nav className="history-pages" aria-label={`${label} pages`}>
      <button type="button" disabled={!older} onClick={onOlder}>
        Older {label}
      </button>
      <button type="button" disabled={!newer} onClick={onNewer}>
        Newer {label}
      </button>
    </nav>
  );
}
