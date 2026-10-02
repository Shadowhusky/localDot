import type { InputRequest, TypeRequest } from "@localdot/protocol";
import type { DriverInjector } from "../input.ts";
import type { XHelper } from "../x/helper.ts";
import type { CuaDriver } from "./driver.ts";
import { DECOR_CLASSES, type HelperWindow, listWindows, windowUnder } from "./hit-test.ts";

async function deliveryWindow(
  x: XHelper,
  point?: { x: number; y: number },
  id?: number,
): Promise<HelperWindow> {
  const windows = await listWindows(x);
  const win =
    (id !== undefined ? windows.find((w) => w.id === id) : undefined) ??
    (point && windowUnder(windows, point)) ??
    windows.find((w) => w.active && !DECOR_CLASSES.has(w.cls)) ??
    windows.find((w) => !DECOR_CLASSES.has(w.cls));
  if (!win) throw new Error("no window to deliver to");
  return win;
}

export function driverInjector(driver: CuaDriver, x: XHelper): DriverInjector {
  return {
    async click(req: InputRequest) {
      if (req.input.kind !== "click")
        throw new Error(`the driver injector does not deliver ${req.input.kind}`);
      const win = await deliveryWindow(x, req.input.at, req.window);
      await driver.click(
        win.pid,
        win.id,
        req.input.at,
        req.input.button,
        req.input.count,
        req.input.mods,
      );
    },
    async type(req: TypeRequest) {
      const win = await deliveryWindow(x, undefined, req.window);
      await driver.typeText(win.pid, win.id, req.text);
    },
  };
}
