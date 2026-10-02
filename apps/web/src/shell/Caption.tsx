export function Caption({ text }: { text: string }) {
  return (
    <p className="caption" aria-live="polite">
      <span>dot</span>
      {text}
    </p>
  );
}
