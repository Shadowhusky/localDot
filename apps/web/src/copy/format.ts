const plurals = new Intl.PluralRules("en");

export function count(value: number, one: string, other: string): string {
  return `${value.toLocaleString()} ${plurals.select(value) === "one" ? one : other}`;
}
