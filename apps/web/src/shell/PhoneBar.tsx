import { type ReactNode, type RefObject, useRef, useState } from "react";
import { Button } from "../ui/Button.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import type { IconName } from "../ui/icons.ts";
import { Menu } from "../ui/Menu.tsx";
import { triggerProps } from "../ui/Popover.tsx";
import type { SessionStatus } from "../ui/SessionGlyph.tsx";

export interface PhoneBarProps {
  title: string;
  // Under the name, only while dot isn't there to say it.
  status?: { kind: SessionStatus | "none"; text: ReactNode };
  // Back, or beside the list a toggle for it.
  back: { label: string; icon: IconName; attention?: boolean; onPress(): void };
  onDetails(): void;
  // This task holds the computer.
  lamp: boolean;
  monitorRef: RefObject<HTMLButtonElement | null>;
  onComputer(): void;
  moreRef: RefObject<HTMLButtonElement | null>;
  onMore?(): void;
  menu: ReactNode;
}

// The conversation's top bar: glass where the thread runs under it, with no rule.
export function PhoneBar({
  title,
  status,
  back,
  onDetails,
  lamp,
  monitorRef,
  onComputer,
  moreRef,
  onMore,
  menu,
}: PhoneBarProps) {
  const [open, setOpen] = useState(false);
  const own = useRef<HTMLButtonElement>(null);
  const anchor = moreRef ?? own;
  return (
    <header className="phone-bar phone-chat-bar" data-sub={status ? "" : undefined}>
      <div className="phone-bar-glass" />
      <div className="phone-bar-row">
        <IconButton
          size={36}
          round
          variant="filled"
          icon={back.icon}
          label={back.label}
          attention={back.attention}
          onClick={back.onPress}
        />
        <Button
          variant="quiet"
          className="phone-title"
          aria-label={`${title}. Conversation details`}
          onClick={onDetails}
        >
          <span className="phone-title-text">{title}</span>
          <span className="phone-title-sub" aria-hidden={!status || undefined}>
            <span className="phone-title-sub-in">
              {status && (
                <>
                  <i data-kind={status.kind} />
                  {status.text}
                </>
              )}
            </span>
          </span>
        </Button>
        <span className="phone-lamp-host" data-lamp={lamp || undefined}>
          <IconButton
            ref={monitorRef}
            size={36}
            round
            variant="filled"
            icon="monitor"
            label={lamp ? "Open the computer. This task has it now" : "Open the computer"}
            onClick={onComputer}
          />
          <span className="phone-lamp" aria-hidden="true" />
        </span>
        <IconButton
          ref={anchor}
          size={36}
          round
          variant="filled"
          icon="more-horizontal"
          label="More"
          {...triggerProps("menu", open)}
          onClick={() => {
            onMore?.();
            setOpen(true);
          }}
        />
        <Menu
          open={open}
          onClose={() => setOpen(false)}
          anchor={anchor}
          side="bottom"
          align="end"
          label="More"
        >
          {menu}
        </Menu>
      </div>
    </header>
  );
}
