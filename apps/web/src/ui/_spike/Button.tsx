import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cn } from "@/ui/cn.ts";

const BASE =
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[background-color,color,box-shadow] outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-45 pointer-coarse:min-h-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

const VARIANTS = {
  default: "bg-primary text-primary-foreground hover:bg-primary/85",
  secondary:
    "bg-secondary text-secondary-foreground hover:bg-secondary-hover aria-expanded:bg-secondary-hover",
  ghost:
    "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
};

const SIZES = {
  default: "h-8 gap-1.5 px-3",
  "icon-sm": "size-8 pointer-coarse:min-w-11",
};

export type ButtonProps = ButtonPrimitive.Props & {
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
};

export function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(BASE, VARIANTS[variant], SIZES[size], className)}
      {...props}
    />
  );
}
