const plurals = new Intl.PluralRules("en");

export function count(value: number, one: string, other: string): string {
  return `${value.toLocaleString()} ${plurals.select(value) === "one" ? one : other}`;
}

export function bytes(value: number): string {
  if (value < 1024) return count(value, "byte", "bytes");
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

// A running time: m:ss under an hour, h:mm:ss from one hour.
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const s = String(total % 60).padStart(2, "0");
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
