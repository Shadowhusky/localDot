import { t } from "../i18n/index.ts";

// Every task goes on when the user moves to another conversation, and a choice made while another
// is on its way waits for it; only a Stop on its way holds the move up.
export function conversationBlockReason(stopping: boolean): string | undefined {
  return stopping ? t`Stopping the current task…` : undefined;
}
