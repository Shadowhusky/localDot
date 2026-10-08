import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { cn } from "@/ui/cn.ts";
import { CheckIcon, ChevronDownIcon } from "./icons.tsx";

export const Combobox = ComboboxPrimitive.Root;

export function ComboboxLabel({ className, ...props }: ComboboxPrimitive.Label.Props) {
  return (
    <ComboboxPrimitive.Label
      data-slot="combobox-label"
      className={cn("text-xs font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}

export function ComboboxInput({ className, ...props }: ComboboxPrimitive.Input.Props) {
  return (
    <ComboboxPrimitive.InputGroup
      data-slot="combobox-input-group"
      className={cn(
        "relative flex h-8 w-full min-w-0 items-center rounded-md border border-input bg-field transition-[border-color] hover:border-input-hover has-focus-visible:border-muted-foreground pointer-coarse:min-h-11",
        className,
      )}
    >
      <ComboboxPrimitive.Input
        data-slot="combobox-input"
        className="h-full min-w-0 flex-1 bg-transparent pr-8 pl-2.5 text-sm outline-none placeholder:text-muted-foreground pointer-coarse:text-base"
        {...props}
      />
      <ComboboxPrimitive.Trigger
        data-slot="combobox-trigger"
        aria-label="Show suggestions"
        className="absolute inset-y-0 right-0 flex w-8 items-center justify-end pr-2 text-muted-foreground outline-none pointer-coarse:w-11"
      >
        <ChevronDownIcon className="pointer-events-none size-4" />
      </ComboboxPrimitive.Trigger>
    </ComboboxPrimitive.InputGroup>
  );
}

export function ComboboxContent({
  className,
  side = "bottom",
  sideOffset = 6,
  align = "start",
  ...props
}: ComboboxPrimitive.Popup.Props &
  Pick<ComboboxPrimitive.Positioner.Props, "side" | "align" | "sideOffset">) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        className="isolate z-50"
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            "group/combobox-content relative max-h-(--available-height) w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-overlay transition-[opacity,scale] duration-150 ease-enter data-ending-style:scale-95 data-ending-style:opacity-0 data-ending-style:ease-exit data-starting-style:scale-95 data-starting-style:opacity-0",
            className,
          )}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

export function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn(
        "max-h-72 scroll-py-1 overflow-y-auto overscroll-contain p-1 data-empty:p-0",
        className,
      )}
      {...props}
    />
  );
}

export function ComboboxItem({ className, children, ...props }: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        "relative flex min-h-8 w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-45 pointer-coarse:min-h-11",
        className,
      )}
      {...props}
    >
      {children}
      <ComboboxPrimitive.ItemIndicator
        render={
          <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />
        }
      >
        <CheckIcon className="size-4" />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  );
}

export function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className={cn(
        "hidden w-full justify-center py-2 text-center text-sm text-muted-foreground group-data-empty/combobox-content:flex",
        className,
      )}
      {...props}
    />
  );
}
