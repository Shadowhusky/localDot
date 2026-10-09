import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../ui/Button.tsx";
import { afterMotion } from "../ui/finished.ts";
import { Group, GroupRow, IconTile, Monogram } from "../ui/Group.tsx";
import { Icon } from "../ui/Icon.tsx";
import { matches, REDUCED_MOTION } from "../ui/media.ts";
import { VisuallyHidden } from "../ui/VisuallyHidden.tsx";
import { describeKey, PROVIDER_NAMES, type Provider } from "./binding.ts";
import { type KeyRecord, problemText } from "./keys-api.ts";

// How long a first press of Remove stays armed.
export const ARMED_MS = 4000;

export interface KeyListProps {
  active: boolean;
  keys: readonly KeyRecord[];
  // Why nothing can be removed now; while busy, a key change is in flight.
  unavailable?: string;
  busy?: boolean;
  // How many times this task has used each key.
  uses?: Readonly<Record<string, number>>;
  // A key just saved, scrolled to and lit once; `at` tells one save from the next.
  fresh?: { id: string; at: number } | null;
  remove(id: string): Promise<void>;
  // Opens the form that stores a key's value again under its name.
  reenter?(key: KeyRecord): void;
}

interface Row {
  key: KeyRecord;
  leaving: boolean;
}

function added(at: string): string | undefined {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return undefined;
  return `Added ${new Date(time).toLocaleDateString([], { day: "numeric", month: "short" })}`;
}

function initial(record: KeyRecord): string {
  const name =
    record.kind === "llm" && record.provider && Object.hasOwn(PROVIDER_NAMES, record.provider)
      ? PROVIDER_NAMES[record.provider as Provider]
      : record.id;
  return name.charAt(0).toUpperCase();
}

// Deleting a key cannot be undone, so the first press arms the button and a second one, within a
// few seconds, deletes. A removed row folds away rather than vanishing.
export function KeyList({
  active,
  keys,
  unavailable,
  busy = false,
  uses,
  fresh,
  remove,
  reenter,
}: KeyListProps) {
  const [armed, setArmed] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [gone, setGone] = useState<{ key: KeyRecord; index: number }[]>([]);
  const pendingRef = useRef(false);
  const expires = useRef(0);
  const list = useRef<HTMLUListElement>(null);
  const shown = useRef<number | null>(null);
  const locked = !active || Boolean(unavailable) || busy;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new list or changed access state requires a fresh confirmation
  useEffect(() => {
    setArmed(null);
  }, [active, unavailable, keys]);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), ARMED_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  useEffect(() => {
    if (gone.length === 0) return;
    const rows = [...(list.current?.querySelectorAll("[data-leaving]") ?? [])];
    let cancel = () => {};
    const frame = requestAnimationFrame(() => {
      cancel = afterMotion(rows, () => setGone([]));
    });
    return () => {
      cancelAnimationFrame(frame);
      cancel();
    };
  }, [gone]);

  useLayoutEffect(() => {
    if (!fresh || shown.current === fresh.at) return;
    const row = list.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(fresh.id)}"]`);
    if (!row) return;
    shown.current = fresh.at;
    row.scrollIntoView?.({
      block: "nearest",
      behavior: matches(REDUCED_MOTION) ? "auto" : "smooth",
    });
  });

  const rows: Row[] = keys.map((key) => ({
    key,
    leaving: gone.some((entry) => entry.key.id === key.id),
  }));
  for (const entry of gone)
    if (!keys.some((key) => key.id === entry.key.id))
      rows.splice(Math.min(entry.index, rows.length), 0, { key: entry.key, leaving: true });

  if (rows.length === 0)
    return (
      <Group>
        <GroupRow
          leading={<IconTile icon="key-round" />}
          label="No keys yet"
          detail="Add one to use a model or a web API."
        />
      </Group>
    );
  return (
    <>
      <Group>
        <ul
          ref={list}
          className="keys-list"
          aria-label="Saved keys"
          style={{ "--_armed": `${ARMED_MS}ms` } as CSSProperties}
        >
          {rows.map(({ key: k, leaving }) => {
            const label =
              pending === k.id ? "Removing…" : armed === k.id ? "Confirm remove" : "Remove";
            const count = uses?.[k.id] ?? 0;
            const facts = [
              ...describeKey(k).split(" · "),
              k.reenter ? undefined : added(k.createdAt),
              count > 0 ? `Used ${count}× this task` : undefined,
            ].filter((fact): fact is string => Boolean(fact));
            const stale = k.reenter && !leaving;
            const lit = fresh?.id === k.id && !leaving;
            return (
              <li
                key={k.id}
                className="keys-row"
                data-id={k.id}
                data-armed={armed === k.id ? "" : undefined}
                data-leaving={leaving ? "" : undefined}
                data-fresh={lit ? "" : undefined}
                data-reenter={stale ? "" : undefined}
                inert={leaving}
              >
                <GroupRow
                  className="keys-row-inner"
                  leading={<Monogram>{initial(k)}</Monogram>}
                  label={<span className="keys-row-name">{k.id}</span>}
                  detail={
                    // Each fact wraps whole, so no line starts or ends with a separator.
                    <span className="keys-row-meta">
                      {stale && (
                        <span className="keys-row-reenter">
                          <span className="keys-row-point" aria-hidden="true" />
                          Needs re-entering
                        </span>
                      )}
                      {facts.map((fact, at) => (
                        <span key={fact}>
                          {(at > 0 || stale) && <VisuallyHidden>, </VisuallyHidden>}
                          {fact}
                        </span>
                      ))}
                    </span>
                  }
                  trailing={
                    <Button
                      size="sm"
                      variant={armed === k.id ? "secondary" : "quiet"}
                      busy={pending === k.id}
                      disabledReason={
                        pending === k.id
                          ? undefined
                          : (unavailable ??
                            (busy ? "Wait for the other key change to finish" : undefined))
                      }
                      aria-label={`${label} ${k.id}`}
                      onClick={async () => {
                        if (locked || pendingRef.current) return;
                        if (armed !== k.id || performance.now() >= expires.current) {
                          expires.current = performance.now() + ARMED_MS;
                          setArmed(k.id);
                          return;
                        }
                        setArmed(null);
                        pendingRef.current = true;
                        setPending(k.id);
                        const index = keys.findIndex((key) => key.id === k.id);
                        try {
                          await remove(k.id);
                          setProblem(null);
                          setGone((now) => [...now, { key: k, index }]);
                        } catch (err) {
                          setProblem(problemText(err));
                        } finally {
                          pendingRef.current = false;
                          setPending(null);
                        }
                      }}
                    >
                      {/* As wide as its longest label, so arming it moves nothing in the row. */}
                      <span className="keys-remove-label" data-longest="Confirm remove">
                        <span>{label}</span>
                      </span>
                    </Button>
                  }
                >
                  {stale && reenter && (
                    <div className="keys-row-fix">
                      <Button
                        size="sm"
                        variant="secondary"
                        icon="key-round"
                        disabledReason={
                          unavailable ??
                          (busy ? "Wait for the other key change to finish" : undefined)
                        }
                        aria-label={`Re-enter ${k.id}`}
                        onClick={() => reenter(k)}
                      >
                        Re-enter
                      </Button>
                    </div>
                  )}
                  {lit && <span key={fresh.at} className="keys-row-glow" aria-hidden="true" />}
                  {armed === k.id && <span className="keys-row-drain" aria-hidden="true" />}
                </GroupRow>
              </li>
            );
          })}
        </ul>
      </Group>
      {problem && (
        <p className="keys-note" data-alert="" role="alert">
          <Icon name="circle-alert" size={12} />
          <span>{problem}</span>
        </p>
      )}
    </>
  );
}
