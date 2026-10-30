// Every task goes on when the user moves to another conversation; only a Stop on its way or a
// choice still being made holds the move up.
export function conversationBlockReason(stopping: boolean, busy: boolean): string | undefined {
  if (stopping) return "Stopping the current task…";
  if (busy) return "Just a moment…";
  return undefined;
}
