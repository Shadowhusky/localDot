import type { RefObject } from "react";
import { IconButton } from "../ui/IconButton.tsx";

export function ChatToggle({
  buttonRef,
  chat,
  onChat,
}: {
  buttonRef?: RefObject<HTMLButtonElement | null>;
  chat: boolean;
  onChat(): void;
}) {
  return (
    <IconButton
      ref={buttonRef}
      icon="panel-right"
      label={chat ? "Hide chat" : "Show chat"}
      size={32}
      onClick={onChat}
    />
  );
}
