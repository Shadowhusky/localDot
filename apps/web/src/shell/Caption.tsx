export function Caption({ text }: { text: string }) {
  return (
    <p className="caption">
      <span>dot</span>
      {text}
    </p>
  );
}
