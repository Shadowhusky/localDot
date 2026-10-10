// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentTakeover } from "./model.ts";
import { type HandOffInput, useHandOff } from "./useHandOff.ts";

const SESSION = "01JXYZ0000000000000000SESS";
const handed: AgentTakeover = {
  requestId: "01JXYZ00000000000000000001",
  reason: "login",
  note: "Sign in to the sample site",
};
let hidden = false;
Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
const setHidden = (value: boolean) => {
  hidden = value;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
};
afterEach(() => {
  cleanup();
  hidden = false;
});

function fixture(over: Partial<HandOffInput> = {}, taken = true) {
  const take = vi.fn(async () => taken);
  const late = vi.fn();
  let props: HandOffInput = {
    sessionId: SESSION,
    fresh: true,
    offered: undefined,
    shown: true,
    canTake: true,
    take,
    ...over,
  };
  const view = renderHook((p: HandOffInput) => useHandOff(p, late), { initialProps: props });
  return {
    take,
    late,
    async update(next: Partial<HandOffInput>) {
      props = { ...props, ...next };
      await act(async () => view.rerender(props));
    },
  };
}

it("puts the user in control the moment dot hands over, without a press", async () => {
  const f = fixture();
  await f.update({ offered: handed, fresh: false });
  expect(f.take).toHaveBeenCalledOnce();
  await f.update({ fresh: true });
  expect(f.take).toHaveBeenCalledOnce();
  expect(f.late).toHaveBeenCalledOnce();
  expect(f.late).toHaveBeenCalledWith(handed);
});

it("waits while the page is out of sight, then takes the computer and says dot handed it over", async () => {
  const f = fixture();
  hidden = true;
  await f.update({ offered: handed });
  expect(f.take).not.toHaveBeenCalled();
  setHidden(false);
  await act(async () => {});
  expect(f.take).toHaveBeenCalledOnce();
  expect(f.late).toHaveBeenCalledWith(handed);
});

it("waits while a recording or Settings covers the computer", async () => {
  const f = fixture({ shown: false });
  await f.update({ offered: handed });
  expect(f.take).not.toHaveBeenCalled();
  await f.update({ shown: true });
  expect(f.take).toHaveBeenCalledOnce();
  expect(f.late).toHaveBeenCalledWith(handed);
});

it("says why when the page opens onto a hand-off already waiting", async () => {
  const f = fixture({ offered: handed });
  await act(async () => {});
  expect(f.take).toHaveBeenCalledOnce();
  expect(f.late).toHaveBeenCalledWith(handed);
});

it("waits until the computer can be taken", async () => {
  const f = fixture({ canTake: false });
  await f.update({ offered: handed });
  expect(f.take).not.toHaveBeenCalled();
  await f.update({ canTake: true });
  expect(f.take).toHaveBeenCalledOnce();
});

it("leaves a take that didn't go through to Take control, and tries again on the next look", async () => {
  const f = fixture({}, false);
  await f.update({ offered: handed });
  await f.update({ canTake: false });
  await f.update({ canTake: true });
  expect(f.take).toHaveBeenCalledOnce();
  expect(f.late).not.toHaveBeenCalled();
  setHidden(true);
  setHidden(false);
  await act(async () => {});
  expect(f.take).toHaveBeenCalledTimes(2);
});

it("takes each hand-off once", async () => {
  const f = fixture();
  await f.update({ offered: handed });
  await f.update({ offered: undefined });
  await f.update({ offered: handed });
  expect(f.take).toHaveBeenCalledOnce();
  await f.update({ offered: { ...handed, requestId: "01JXYZ00000000000000000002" } });
  expect(f.take).toHaveBeenCalledTimes(2);
});
