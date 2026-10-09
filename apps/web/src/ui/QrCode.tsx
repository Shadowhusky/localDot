import { qrModules } from "@localdot/protocol/qr";
import { useMemo } from "react";

// Modules of light margin a scanner needs around the code.
const QUIET = 4;

// A QR code drawn dark on a light tile. Null when the text is too long for one.
export function QrCode({
  value,
  size = 168,
  label,
}: {
  value: string;
  size?: number;
  label: string;
}) {
  const modules = useMemo(() => qrModules(value), [value]);
  const path = useMemo(() => {
    if (!modules) return "";
    let d = "";
    modules.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) d += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
      });
    });
    return d;
  }, [modules]);
  if (!modules) return null;
  const extent = modules.length + QUIET * 2;
  return (
    <svg
      viewBox={`0 0 ${extent} ${extent}`}
      width={size}
      height={size}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect className="ui-qr-tile" width={extent} height={extent} rx={2} />
      <path className="ui-qr-dots" d={path} />
    </svg>
  );
}
