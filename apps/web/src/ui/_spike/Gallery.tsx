import { type ReactNode, useState } from "react";
import { cn } from "@/ui/cn.ts";
import { Button } from "./Button.tsx";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from "./Combobox.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./Dialog.tsx";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  DrawerTrigger,
} from "./Drawer.tsx";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./Menu.tsx";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "./Popover.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "./Select.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./Sheet.tsx";
import { Toaster, useToastManager } from "./Toast.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./Tooltip.tsx";

const SPEEDS = [
  { value: "0.5", label: "0.5×" },
  { value: "1", label: "1×" },
  { value: "1.5", label: "1.5×" },
  { value: "2", label: "2×" },
  { value: "4", label: "4×" },
];

const ASKING = [
  { value: "always", label: "Ask before every action" },
  { value: "risky", label: "Ask before risky actions" },
  { value: "never", label: "Never ask" },
];

const MODELS = [
  "sonnet-5-5",
  "sonnet-5",
  "opus-5-5",
  "haiku-5",
  "luna-6",
  "luna-6-mini",
  "local-small",
  "local-large",
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-lg bg-card p-5" aria-label={title}>
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function SpeedSelect({ label }: { label: string }) {
  return (
    <Select items={SPEEDS} defaultValue="1">
      <div className="flex flex-col gap-1.5">
        <SelectLabel>{label}</SelectLabel>
        <SelectTrigger className="w-32">
          <SelectValue />
        </SelectTrigger>
      </div>
      <SelectContent>
        {SPEEDS.map((speed) => (
          <SelectItem key={speed.value} value={speed.value}>
            {speed.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ModelCombobox({ className }: { className?: string }) {
  return (
    <Combobox items={MODELS}>
      <div className={cn("flex w-full flex-col gap-1.5", className)}>
        <ComboboxLabel>Model</ComboboxLabel>
        <ComboboxInput placeholder="Search models" />
      </div>
      <ComboboxContent>
        <ComboboxEmpty>No matching models</ComboboxEmpty>
        <ComboboxList>
          {(model: string) => (
            <ComboboxItem key={model} value={model}>
              {model}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function SelectDemo() {
  const [presses, setPresses] = useState(0);
  return (
    <Section title="Select">
      <SpeedSelect label="Playback speed" />
      <Button variant="secondary" className="self-start" onClick={() => setPresses((n) => n + 1)}>
        Under the list · pressed {presses}
      </Button>
    </Section>
  );
}

function OverlayDemo() {
  return (
    <Section title="Popover, menu and tooltip">
      <div className="flex flex-wrap items-center gap-2">
        <Popover>
          <PopoverTrigger render={<Button variant="secondary" />}>Details</PopoverTrigger>
          <PopoverContent align="start">
            <PopoverTitle>Recorded on this Mac</PopoverTitle>
            <PopoverDescription>
              3 minutes, 24 steps. Screenshots stay on this Mac until you delete them.
            </PopoverDescription>
          </PopoverContent>
        </Popover>
        <Menu>
          <MenuTrigger render={<Button variant="secondary" />}>More</MenuTrigger>
          <MenuContent>
            <MenuItem>Rename</MenuItem>
            <MenuItem>Duplicate</MenuItem>
            <MenuSeparator />
            <MenuItem>Delete</MenuItem>
          </MenuContent>
        </Menu>
        <Tooltip>
          <TooltipTrigger render={<Button variant="secondary" />}>Copy link</TooltipTrigger>
          <TooltipContent>Copies a link to this replay</TooltipContent>
        </Tooltip>
      </div>
    </Section>
  );
}

function DialogDemo() {
  const toasts = useToastManager();
  return (
    <Section title="Dialog">
      <Dialog>
        <DialogTrigger render={<Button variant="secondary" className="self-start" />}>
          Delete recording
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this recording?</DialogTitle>
            <DialogDescription>
              The video and its screenshots are removed from this Mac. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Keep it</DialogClose>
            <DialogClose
              render={<Button variant="secondary" />}
              onClick={() => toasts.add({ title: "Recording deleted" })}
            >
              Delete
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

function SheetDemo() {
  return (
    <Section title="Sheet">
      <Sheet>
        <SheetTrigger render={<Button variant="secondary" className="self-start" />}>
          Open settings
        </SheetTrigger>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Settings</SheetTitle>
            <SheetDescription>Choices here apply to the next task.</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-5 px-5 pb-5">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Task note</span>
              <input
                className="h-8 rounded-md border border-input bg-field px-2.5 text-sm outline-none placeholder:text-muted-foreground hover:border-input-hover focus-visible:border-muted-foreground pointer-coarse:min-h-11 pointer-coarse:text-base"
                placeholder="Optional"
              />
            </label>
            <Select items={ASKING} defaultValue="risky">
              <div className="flex flex-col gap-1.5">
                <SelectLabel>When to ask</SelectLabel>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
              </div>
              <SelectContent>
                {ASKING.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ModelCombobox />
          </div>
        </SheetContent>
      </Sheet>
    </Section>
  );
}

function DrawerDemo() {
  return (
    <Section title="Bottom sheet">
      <Drawer>
        <DrawerTrigger render={<Button variant="secondary" className="self-start" />}>
          Open playback options
        </DrawerTrigger>
        <DrawerContent>
          <DrawerTitle>Playback</DrawerTitle>
          <DrawerDescription>Choose how fast this replay plays.</DrawerDescription>
          <SpeedSelect label="Speed" />
          <DrawerClose render={<Button className="self-start" />}>Done</DrawerClose>
        </DrawerContent>
      </Drawer>
    </Section>
  );
}

function ToastDemo() {
  const toasts = useToastManager();
  return (
    <Section title="Toast">
      <Button
        variant="secondary"
        className="self-start"
        onClick={() =>
          toasts.add({
            title: "Settings saved",
            description: "They apply to the next task.",
            actionProps: { children: "Undo" },
          })
        }
      >
        Save settings
      </Button>
    </Section>
  );
}

export function Gallery() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-8 sm:px-8 sm:py-12">
      <header className="flex flex-col gap-1 pb-2">
        <p className="text-xs text-muted-foreground">Development only. Never part of the app.</p>
        <h1 className="text-xl font-semibold">Kit spike</h1>
        <p className="text-sm text-muted-foreground">
          Generated components on Base UI, served with the app's content security policy.
        </p>
      </header>
      <SelectDemo />
      <Section title="Combobox">
        <ModelCombobox className="max-w-64" />
      </Section>
      <OverlayDemo />
      <DialogDemo />
      <SheetDemo />
      <DrawerDemo />
      <ToastDemo />
      <p className="h-[120vh] pt-4 text-xs text-muted-foreground">
        Extra length, so the page scrolls behind an open dialog.
      </p>
      <Toaster />
    </main>
  );
}
