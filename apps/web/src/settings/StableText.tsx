/** Size for every known state, but expose only the current text to assistive technology. */
export function StableText({ choices, value }: { choices: readonly string[]; value: string }) {
  return (
    <span className="settings-stable-text">
      {[...new Set([...choices, value])].map((text) => (
        <span
          key={text}
          aria-hidden={text !== value || undefined}
          data-hidden={text !== value || undefined}
        >
          {text}
        </span>
      ))}
    </span>
  );
}
