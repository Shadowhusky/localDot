// dot's line beside the stage. Until dot itself docks beside it, the line carries its speaker.
export function Caption({ text, speaker }: { text: string; speaker: "dot" | "system" }) {
  return (
    <p className="narration" data-speaker={speaker} aria-live="polite">
      {text && (
        <span className="narration-line" key={text}>
          {speaker === "dot" && <span className="narration-speaker">dot</span>}
          {text}
        </span>
      )}
    </p>
  );
}
