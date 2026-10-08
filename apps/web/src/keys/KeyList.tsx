import { useEffect, useRef, useState } from "react";
import { describeKey } from "./binding.ts";
import { type KeyRecord, problemText } from "./keys-api.ts";

export interface KeyListProps {
  active: boolean;
  keys: KeyRecord[];
  disabled: boolean;
  remove(id: string): Promise<void>;
}

// Deleting a key cannot be undone, so the first press arms the button and a second one, within a
// few seconds, deletes.
export function KeyList({ active, keys, disabled, remove }: KeyListProps) {
  const [armed, setArmed] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const expires = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new list or changed access state requires a fresh confirmation
  useEffect(() => {
    setArmed(null);
  }, [active, disabled, keys]);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), 4000);
    return () => clearTimeout(timer);
  }, [armed]);

  if (keys.length === 0) return <p className="keys-empty">No keys yet.</p>;
  return (
    <>
      <ul className="key-list" aria-label="Saved keys">
        {keys.map((k) => {
          const label =
            pending === k.id ? "Removing…" : armed === k.id ? "Confirm remove" : "Remove";
          return (
            <li key={k.id}>
              <span className="key-name">{k.id}</span>
              <span className="key-what">{describeKey(k)}</span>
              <button
                type="button"
                className={armed === k.id ? "key-del armed" : "key-del"}
                disabled={!active || disabled || pending !== null}
                aria-label={`${label} ${k.id}`}
                onClick={async () => {
                  if (!active || disabled || pendingRef.current) return;
                  if (armed !== k.id || performance.now() >= expires.current) {
                    expires.current = performance.now() + 4000;
                    setArmed(k.id);
                    return;
                  }
                  setArmed(null);
                  pendingRef.current = true;
                  setPending(k.id);
                  try {
                    await remove(k.id);
                    setProblem(null);
                  } catch (err) {
                    setProblem(problemText(err));
                  } finally {
                    pendingRef.current = false;
                    setPending(null);
                  }
                }}
              >
                {label}
              </button>
            </li>
          );
        })}
      </ul>
      {problem && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
    </>
  );
}
