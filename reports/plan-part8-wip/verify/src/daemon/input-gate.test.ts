import { describe, expect, it } from "vitest";
import { viewerMayForward } from "./input-gate.ts";

describe("the viewer's input gate (Review Focus 3)", () => {
  it("passes what runs the stream and drops every input while the agent holds the browser", () => {
    for (const m of ["START_VIDEO", "STOP_VIDEO", "REQUEST_KEYFRAME", 'SETTINGS,{"videoBitRate":8000}', "CLIENT_FRAME_ACK 12 3", "_gz,1", "pong,1", "_arg_fps,60"])
      expect(viewerMayForward(m, false, false), m).toBe(true);
    for (const m of ["kd,65", "ku,65", "kr", "kh,1", "m,10,20,1,0", "m2,1,1,0,0", "js,b,0,1", "cw,aHVudGVyMg==", "cr", "REQUEST_CLIPBOARD", "cmd,xterm", "vp,1.00,1.00", "p,1", "r,2560x1600", "HELLO 1 {}", "kd65", "", " kd,65"])
      expect(viewerMayForward(m, false, false), JSON.stringify(m)).toBe(false);
    expect(viewerMayForward(Buffer.from([1, 2, 3]), true, false)).toBe(false);
  });

  it("forwards everything while the user holds the browser", () => {
    expect(viewerMayForward("kd,65", false, true)).toBe(true);
    expect(viewerMayForward(Buffer.from([1]), true, true)).toBe(true);
  });
});
