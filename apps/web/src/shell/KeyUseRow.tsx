import type { KeyUseRowView } from "../session/key-uses.ts";

// The protocol bounds request fields; React escapes them and CSS wraps each text column.
// None of the cell's chosen text becomes markup, a URL, or a style value.
export function KeyUseRow({ row }: { row: KeyUseRowView }) {
  return (
    <div className={row.blocked ? "keyuse blocked" : "keyuse"} data-testid="key-use">
      <span className="kd" aria-hidden="true" />
      <span className="kl">{row.label}</span>
      {row.count > 1 && <span className="kc">×{row.count}</span>}
      <span className="kp">{row.detail}</span>
    </div>
  );
}
