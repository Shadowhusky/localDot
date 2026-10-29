import type { KeyUseState } from "@localdot/stage";

export type { KeyUseState };

export interface KeyUseRowView {
  kind: "key";
  id: string;
  t: number;
  label: string;
  detail: string;
  blocked: boolean;
  count: number;
}

export type TimelineRow<S> = (S & { kind: "step" }) | KeyUseRowView;

// A step's row, the same one for as long as the step's view is the same.
const asRows = new WeakMap<object, unknown>();
export function stepRow<S extends object>(step: S): S & { kind: "step" } {
  let row = asRows.get(step) as (S & { kind: "step" }) | undefined;
  if (!row) {
    row = { ...step, kind: "step" };
    asRows.set(step, row);
  }
  return row;
}

export function keyUseRow(k: KeyUseState): KeyUseRowView {
  const blocked = k.decision !== "allow";
  const key = k.secretId === "unknown" ? "an unknown key" : `${k.secretId} key`;
  return {
    kind: "key",
    id: k.id,
    t: k.t,
    label: `${blocked ? "Blocked" : "Used"} ${key} → ${k.host}`,
    detail: `${k.method} ${k.path}`,
    blocked,
    count: 1,
  };
}

// Stable time order: tied steps retain their input order, then tied key events retain theirs.
// Only an uninterrupted run with the same actual key, host, and outcome is grouped. Labels
// cannot identify a group: deny and ask share a label, and request text can contain separators.
export function timelineRows<S extends { startT: number } & object>(
  steps: readonly S[],
  keyUses: readonly KeyUseState[],
): TimelineRow<S>[] {
  const rows: TimelineRow<S>[] = [];
  const items = [
    ...steps.map((step) => ({ t: step.startT, kind: "step" as const, step })),
    ...keyUses.map((key) => ({ t: key.t, kind: "key" as const, key })),
  ].sort((a, b) => a.t - b.t);
  let previousKey: KeyUseState | undefined;
  for (const item of items) {
    if (item.kind === "step") {
      rows.push(stepRow(item.step));
      previousKey = undefined;
      continue;
    }
    const key = item.key;
    const row = keyUseRow(key);
    const last = rows.at(-1);
    if (
      last?.kind === "key" &&
      previousKey?.secretId === key.secretId &&
      previousKey.host === key.host &&
      previousKey.decision === key.decision
    ) {
      last.count += 1;
      last.detail = row.detail;
    } else {
      rows.push(row);
    }
    previousKey = key;
  }
  return rows;
}
