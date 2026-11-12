import type { RefObject } from "react";
import { t } from "../i18n/index.ts";
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
      label={chat ? t`Hide chat` : t`Show chat`}
      size={32}
      onClick={onChat}
    />
  );
}
