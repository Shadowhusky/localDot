import { clsx } from "clsx";
import { TextField, type TextFieldProps } from "./TextField.tsx";

// Keeps what an amount in dollars can hold: digits, one point and at most two digits after it.
export function moneyInput(text: string): string {
  const [whole = "", ...rest] = text.replace(/[^\d.]/g, "").split(".");
  return rest.length ? `${whole}.${rest.join("").slice(0, 2)}` : whole;
}

export interface MoneyFieldProps
  extends Omit<TextFieldProps, "type" | "inputMode" | "prefix" | "value" | "onChange"> {
  value: string;
  onValueChange(value: string): void;
}

export function MoneyField({ value, onValueChange, className, ...props }: MoneyFieldProps) {
  return (
    <TextField
      autoComplete="off"
      {...props}
      className={clsx("ui-money-field", className)}
      prefix="$"
      inputMode="decimal"
      value={value}
      onChange={(event) => onValueChange(moneyInput(event.target.value))}
    />
  );
}
