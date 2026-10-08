const plurals = new Intl.PluralRules("en");

export function count(value: number, one: string, other: string): string {
  return `${value.toLocaleString()} ${plurals.select(value) === "one" ? one : other}`;
}

export function bytes(value: number): string {
  if (value < 1024) return count(value, "byte", "bytes");
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
