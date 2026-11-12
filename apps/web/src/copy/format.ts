import { locale, plural, t } from "../i18n/index.ts";

const plurals = new Intl.PluralRules("en");

// "3 steps", in the language on show: write the English pair, one and other, where it is used.
export function count(value: number, one: string, other: string): string {
  return plural(value, one, other);
}

// "a, b and c" or "a, b or c", with no comma before the last as the English copy writes it; another
// language joins a list its own way.
export function wordList(items: readonly string[], type: "conjunction" | "disjunction"): string {
  if (locale() !== "en") return new Intl.ListFormat(locale(), { type }).format(items);
  const last = items.at(-1) ?? "";
  if (items.length < 2) return last;
  return `${items.slice(0, -1).join(", ")} ${type === "conjunction" ? "and" : "or"} ${last}`;
}

export function bytes(value: number): string {
  if (value < 1024) return count(value, "byte", "bytes");
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

// Tokens as a glance reads them: 18.4K tokens.
export const tokenCount = (value: number) =>
  plurals.select(value) === "one"
    ? t`${compact.format(value)} token`
    : t`${compact.format(value)} tokens`;

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

// A running time: m:ss under an hour, h:mm:ss from one hour.
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const s = String(total % 60).padStart(2, "0");
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
