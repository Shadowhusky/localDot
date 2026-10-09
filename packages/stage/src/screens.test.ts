import { LocalDotEvent } from "@localdot/protocol";
import { expect, it } from "vitest";
import { emptyModel, foldEvents, screenAt } from "./model.ts";
import { sceneAt } from "./scene.ts";

const desktop = "01JXYZ0000000000000000ABCD",
  browser = "01JXYZ0000000000000000ABCE";
const geometry = { w: 1280, h: 800, scale: 1 };
function events() {
  let seq = 0;
  const event = (type: string, t: number, data: unknown, step?: string) =>
    LocalDotEvent.parse({
      v: 1,
      id: String(++seq).padStart(26, "0"),
      seq,
      t: t * 1000,
      agent: "main",
      type,
      data,
      ...(step ? { step } : {}),
    });
  const click = (t: number, x: number, step: string) => [
    event(
      "action.intent",
      t,
      { verb: "click", label: "Click", point: { x, y: 50 }, risk: "none" },
      step,
    ),
    event(
      "action.dispatch",
      t + 1,
      {
        input: { kind: "click", button: "left", count: 1, at: { x, y: 50 } },
        pressT: (t + 1) * 1000,
        ringAt: (t + 1) * 1000,
        injector: "xtest",
      },
      step,
    ),
  ];
  return [
    event("session.start", 0, { screen: geometry, os: "linux" }),
    event("agent.state", 1, { state: "acting" }),
    ...click(10, 100, "desktop-click"),
    event("screen.switch", 20, {
      screen: "browser",
      cellId: browser,
      revision: 1,
      by: "agent",
      geometry,
    }),
    ...click(30, 900, "browser-click"),
    event("screen.switch", 40, {
      screen: "desktop",
      cellId: desktop,
      revision: 2,
      by: "agent",
      geometry,
    }),
    ...click(50, 300, "new-desktop-click"),
  ];
}

it("never draws another screen's pointer, target, press or click rings across a switch", () => {
  const model = foldEvents(emptyModel(), events());
  const view = { reducedMotion: true };
  expect(sceneAt(model, 15, view).cursor?.x).toBe(100);
  expect(sceneAt(model, 15, view).press?.x).toBe(100);
  expect(sceneAt(model, 21, view).cursor).toBeNull();
  expect(sceneAt(model, 21, view).press).toBeNull();
  expect(sceneAt(model, 21, view).rings).toEqual([]);
  expect(sceneAt(model, 35, view).cursor?.x).toBe(900);
  expect(sceneAt(model, 35, view).press?.x).toBe(900);
  expect(sceneAt(model, 41, view).cursor).toBeNull();
  expect(sceneAt(model, 41, view).press).toBeNull();
  expect(sceneAt(model, 55, view).cursor?.x).toBe(300);
  // The click's ripple follows its 90 ms hold; the browser click's would have been at 121.
  expect(sceneAt(model, 145, view).rings.map((r) => r.x)).toEqual([300]);
});

it("suppresses an event-ahead or video-ahead revision while retaining correct replay history", () => {
  const log = events(),
    model = foldEvents(emptyModel(), log);
  const view = { reducedMotion: true, screen: "browser" as const, screenRevision: 1 };
  expect(sceneAt(model, 15, view).cursor).toBeNull();
  expect(sceneAt(model, 35, view).cursor?.x).toBe(900);
  expect(sceneAt(model, 55, view).cursor).toBeNull();
  expect(sceneAt(model, 35, { ...view, screen: "desktop" }).rings).toEqual([]);
  expect(screenAt(model, 15)).toBeUndefined();
  expect(screenAt(model, 35)?.cellId).toBe(browser);
  expect(screenAt(model, 55)?.cellId).toBe(desktop);
  expect(sceneAt(model, 15, { reducedMotion: true })).toEqual(
    sceneAt(foldEvents(emptyModel(), log.slice(0, 4)), 15, { reducedMotion: true }),
  );
});
