import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import { Button } from "./Button.tsx";
import { XIcon } from "./icons.tsx";

export const useToastManager = ToastPrimitive.useToastManager;

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager();
  return toasts.map((toast) => (
    <ToastPrimitive.Root
      key={toast.id}
      toast={toast}
      data-slot="toast"
      className="pointer-events-auto absolute right-0 bottom-0 z-[calc(1000-var(--toast-index))] h-(--height) w-full origin-bottom rounded-xl bg-popover text-popover-foreground shadow-overlay outline-none select-none [--gap:0.75rem] [--height:var(--toast-frontmost-height,var(--toast-height))] [--offset-y:calc(var(--toast-offset-y)*-1+calc(var(--toast-index)*var(--gap)*-1)+var(--toast-swipe-movement-y))] [--peek:0.75rem] [--scale:calc(max(0,1-(var(--toast-index)*0.1)))] [--shrink:calc(1-var(--scale))] transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--peek))-(var(--shrink)*var(--height))))_scale(var(--scale))] [transition:transform_360ms_var(--ease-enter),opacity_360ms,height_150ms] after:absolute after:top-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full focus-visible:outline-2 focus-visible:outline-ring data-ending-style:opacity-0 data-expanded:h-(--toast-height) data-expanded:transform-[translateX(var(--toast-swipe-movement-x))_translateY(var(--offset-y))] data-limited:opacity-0 data-starting-style:transform-[translateY(150%)] [&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:transform-[translateY(150%)] data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+150%))] data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]"
    >
      <ToastPrimitive.Content className="flex h-full items-center gap-3 overflow-hidden py-3 pr-2 pl-4 transition-opacity duration-200 data-behind:opacity-0 data-expanded:opacity-100">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <ToastPrimitive.Title className="text-sm font-medium" />
          <ToastPrimitive.Description className="text-sm text-muted-foreground" />
        </div>
        <ToastPrimitive.Action render={<Button variant="secondary" />} />
        <ToastPrimitive.Close
          aria-label="Dismiss"
          render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" />}
        >
          <XIcon />
        </ToastPrimitive.Close>
      </ToastPrimitive.Content>
    </ToastPrimitive.Root>
  ));
}

export function Toaster() {
  return (
    <ToastPrimitive.Portal>
      <ToastPrimitive.Viewport
        data-slot="toast-viewport"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-50 mx-auto w-auto max-w-sm outline-none sm:right-6 sm:bottom-6 sm:left-auto sm:mx-0 sm:w-full"
      >
        <ToastList />
      </ToastPrimitive.Viewport>
    </ToastPrimitive.Portal>
  );
}
