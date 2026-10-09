import { useMemo } from "react";
import { qrModules } from "./qr.ts";

// Modules of light margin a scanner needs around the code.
const QUIET = 4;

// A QR code drawn dark on a light tile, as scanners expect whatever the theme. Null when the text
// is too long for one.
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
      <rect width={extent} height={extent} rx={2} fill="#fff" />
      <path d={path} fill="#0b0c0e" />
    </svg>
  );
}
