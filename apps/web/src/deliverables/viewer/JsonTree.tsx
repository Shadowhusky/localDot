import { useState } from "react";
import { count } from "../../copy/format.ts";
import { Button } from "../../ui/Button.tsx";
import { Disclosure } from "../../ui/Disclosure.tsx";

const PAGE = 200;

function Scalar({ value }: { value: unknown }) {
  if (typeof value === "string") return <span className="tok-s">{JSON.stringify(value)}</span>;
  if (typeof value === "number") return <span className="tok-n">{String(value)}</span>;
  return <span className="tok-k">{String(value)}</span>;
}

function Key({ name }: { name: string | number | null }) {
  if (name === null) return null;
  return (
    <span className="viewer-json-key">
      {typeof name === "number" ? name : JSON.stringify(name)}
      <span className="viewer-json-colon">:</span>
    </span>
  );
}

// JSON as a tree that folds: the top level open, everything deeper closed until asked for, and long
// lists shown two hundred items at a time.
export function JsonTree({ value, label }: { value: unknown; label: string }) {
  return (
    <section className="viewer-json" aria-label={label}>
      <JsonNode name={null} value={value} depth={0} />
    </section>
  );
}

function JsonNode({
  name,
  value,
  depth,
}: {
  name: string | number | null;
  value: unknown;
  depth: number;
}) {
  const branch = value !== null && typeof value === "object";
  const entries = branch
    ? Array.isArray(value)
      ? value.map((item, i) => [i, item] as const)
      : Object.entries(value as Record<string, unknown>)
    : [];
  const [open, setOpen] = useState(depth === 0);
  const [seen, setSeen] = useState(open);
  const [shown, setShown] = useState(PAGE);
  if (!branch || entries.length === 0)
    return (
      <div className="viewer-json-row">
        <Key name={name} />
        {branch ? (
          <span className="viewer-json-punct">{Array.isArray(value) ? "[]" : "{}"}</span>
        ) : (
          <Scalar value={value} />
        )}
      </div>
    );
  const list = Array.isArray(value);
  return (
    <Disclosure
      inline
      className="viewer-json-branch"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setSeen(true);
      }}
      summary={
        <span className="viewer-json-row">
          <Key name={name} />
          <span className="viewer-json-punct">{list ? "[" : "{"}</span>
          {!open && <span className="viewer-json-punct">{list ? "…]" : "…}"}</span>}
        </span>
      }
      meta={
        open ? undefined : count(entries.length, list ? "item" : "key", list ? "items" : "keys")
      }
    >
      {seen && (
        <div className="viewer-json-children">
          {entries.slice(0, shown).map(([key, item]) => (
            <JsonNode key={key} name={key} value={item} depth={depth + 1} />
          ))}
          {entries.length > shown && (
            <Button variant="quiet" size="sm" onClick={() => setShown((n) => n + PAGE)}>
              Show {Math.min(PAGE, entries.length - shown)} more
            </Button>
          )}
        </div>
      )}
      {seen && <span className="viewer-json-punct viewer-json-close">{list ? "]" : "}"}</span>}
    </Disclosure>
  );
}
