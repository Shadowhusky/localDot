import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";
import { cn } from "@/ui/cn.ts";

export const Drawer = DrawerPrimitive.Root;
export const DrawerTrigger = DrawerPrimitive.Trigger;
export const DrawerClose = DrawerPrimitive.Close;

// A bottom sheet: it follows the finger and dismisses on a downward swipe. The bleed below the
// popup keeps the surface continuous while a release springs past the bottom edge.
export function DrawerContent({ className, children, ...props }: DrawerPrimitive.Popup.Props) {
  return (
    <DrawerPrimitive.Portal>
      <DrawerPrimitive.Backdrop
        data-slot="drawer-overlay"
        className="fixed inset-0 z-50 min-h-dvh bg-scrim opacity-[calc(1-var(--drawer-swipe-progress))] transition-opacity duration-300 ease-enter data-ending-style:opacity-0 data-ending-style:duration-[calc(var(--drawer-swipe-strength)*300ms)] data-starting-style:opacity-0 data-swiping:duration-0"
      />
      <DrawerPrimitive.Viewport className="fixed inset-0 z-50 flex items-end justify-center">
        <DrawerPrimitive.Popup
          data-slot="drawer-popup"
          className={cn(
            "-mb-12 max-h-[calc(85dvh+3rem)] w-full overflow-y-auto overscroll-contain rounded-t-xl bg-card px-5 pt-2 pb-[calc(1.25rem+env(safe-area-inset-bottom,0px)+3rem)] text-sm text-popover-foreground shadow-overlay outline-none transform-[translateY(var(--drawer-swipe-movement-y))] transition-transform duration-300 ease-enter data-ending-style:transform-[translateY(calc(100%-3rem+2px))] data-ending-style:duration-[calc(var(--drawer-swipe-strength)*300ms)] data-starting-style:transform-[translateY(calc(100%-3rem+2px))] data-swiping:select-none sm:max-w-md",
            className,
          )}
          {...props}
        >
          <div
            aria-hidden="true"
            className="mx-auto mb-3 h-1 w-9 rounded-full bg-muted-foreground/40"
          />
          <DrawerPrimitive.Content className="flex flex-col gap-4">
            {children}
          </DrawerPrimitive.Content>
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPrimitive.Portal>
  );
}

export function DrawerTitle({ className, ...props }: DrawerPrimitive.Title.Props) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn("text-base leading-tight font-semibold text-foreground", className)}
      {...props}
    />
  );
}

export function DrawerDescription({ className, ...props }: DrawerPrimitive.Description.Props) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}
