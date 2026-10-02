// What a viewer's Selkies client may send a browser cell while the user does not hold it (P8-R13):
// the messages that run the stream, never input. Read from the vendored client
// (apps/web/vendor/selkies/assets/selkies-core-*.js) and confirmed on the image by S10 (Task 1).
// Everything else is input or worse — keys (kd, ku, kr, kh), the pointer (m, m2), gamepads (js),
// the clipboard (cw, cr, REQUEST_CLIPBOARD), commands (cmd) and binary frames (file uploads,
// the microphone) — and is dropped. An unknown message is dropped too.
export const VIEW_FIELDS: ReadonlySet<string> = new Set([
  "START_VIDEO",
  "STOP_VIDEO",
  "REQUEST_KEYFRAME",
  "SETTINGS",
  "CLIENT_FRAME_ACK",
  "LOST_FRAME",
  "SET_NATIVE_CURSOR_RENDERING",
  "_gz",
  "_stats",
  "_stats_video",
  "_l",
  "_f",
  "_arg_fps",
  "_crf",
  "_rc",
  "_ebc",
  "vb",
  "ab",
  "s",
  "pong",
]);

export function firstField(text: string): string {
  const end = text.search(/[ ,]/);
  return end < 0 ? text : text.slice(0, end);
}

export function viewerMayForward(data: Buffer | string, isBinary: boolean, userHolds: boolean): boolean {
  if (userHolds) return true;
  if (isBinary) return false;
  const text = typeof data === "string" ? data : data.toString("utf8");
  return VIEW_FIELDS.has(firstField(text));
}
