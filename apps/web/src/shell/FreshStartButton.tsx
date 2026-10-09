import { useRef, useState } from "react";
import { Button, type ButtonProps } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";

export type FreshStartButtonProps = Omit<ButtonProps, "onClick"> & { run(): void };

// Start fresh erases the computer, so it asks first.
export function FreshStartButton({
  run,
  children = "Start fresh",
  ...button
}: FreshStartButtonProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  return (
    <>
      <Button
        {...button}
        onClick={(event) => {
          anchor.current = event.currentTarget;
          setOpen(true);
        }}
      >
        {children}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        title="Start fresh?"
        description="Your computer's files are erased. Your sign-ins are kept."
      >
        <Button variant="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          onClick={() => {
            setOpen(false);
            run();
          }}
        >
          Start fresh
        </Button>
      </Dialog>
    </>
  );
}
