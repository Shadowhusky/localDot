const plurals = new Intl.PluralRules("en");

export function count(value: number, one: string, other: string): string {
  return `${value.toLocaleString()} ${plurals.select(value) === "one" ? one : other}`;
}

export function bytes(value: number): string {
  if (value < 1024) return count(value, "byte", "bytes");
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

// Whole dollars without cents; anything else to the cent.
export const dollars = (value: number) =>
  `$${value.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const cents = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 3,
});

// Money the provider stated reads plainly; money worked out from token counts and list prices is
// an estimate and says so with "≈". Less than a cent keeps a third decimal.
export function spendText(value: number, estimated: boolean): string {
  const amount =
    value > 0 && value < 0.001 ? "< $0.001" : (value < 0.01 ? cents : usd).format(value);
  // A no-break space: the mark never ends a line without its amount.
  return estimated ? `≈\u00a0${amount}` : amount;
}
