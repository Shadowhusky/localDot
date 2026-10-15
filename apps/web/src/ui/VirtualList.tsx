import { type ReactNode, useMemo, useRef } from "react";
import { useVirtualRows } from "./useVirtualRows.ts";

const estimate = () => 64;

// Variable-height activity sections share their parent's scrollport; no nested scrollbars.
export function VirtualList<T>({
  items,
  itemKey,
  children,
}: {
  items: readonly T[];
  itemKey(item: T): string;
  children(item: T): ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null);
  const keys = useMemo(() => items.map(itemKey), [items, itemKey]);
  const windowed = useVirtualRows(list, keys, estimate);
  return (
    <div ref={list}>
      <div aria-hidden="true" style={{ height: windowed.before }} />
      {windowed.indexes.map((index) => (
        <div key={keys[index]} data-index={index} ref={windowed.measure}>
          {children(items[index] as T)}
        </div>
      ))}
      <div aria-hidden="true" style={{ height: windowed.after }} />
    </div>
  );
}
