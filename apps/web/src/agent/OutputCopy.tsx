import { keyLikePresent } from "@localdot/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
export function OutputCopy({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState<string | null>(null);
  const owner = useRef({ text, label, epoch: 0, mounted: true });
  useLayoutEffect(() => {
    owner.current.epoch++;
    Object.assign(owner.current, { text, label });
    setStatus(null);
  }, [text, label]);
  useEffect(() => {
    owner.current.mounted = true;
    return () => {
      owner.current.mounted = false;
      owner.current.epoch++;
    };
  }, []);
  const blocked = !text || keyLikePresent(text);
  return (
    <div className="output-copy">
      <button
        type="button"
        disabled={blocked}
        onClick={() => {
          if (!text || keyLikePresent(text)) return;
          const epoch = owner.current.epoch;
          if (!navigator.clipboard?.writeText) {
            setStatus("Copy is unavailable in this browser.");
            return;
          }
          void navigator.clipboard.writeText(text).then(
            () => {
              if (owner.current.mounted && owner.current.epoch === epoch)
                setStatus("Copied shown text.");
            },
            () => {
              if (owner.current.mounted && owner.current.epoch === epoch)
                setStatus("Could not copy the text.");
            },
          );
        }}
      >
        {label}
      </button>
      {blocked && text && <span className="history-note">Select a shorter excerpt to copy.</span>}
      {status && <span role="status">{status}</span>}
    </div>
  );
}
