// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { parsePhoneRoute, phoneHash, usePhoneRoute } from "./phone-route.ts";

const ID = "01J00000000000000000000000";

describe("the address of a phone's stack", () => {
  it("reads the list, a conversation and its computer", () => {
    expect(parsePhoneRoute("")).toEqual({ level: 0 });
    expect(parsePhoneRoute("#session=x")).toEqual({ level: 0 });
    expect(parsePhoneRoute(`#/c/${ID}`)).toEqual({ level: 1, id: ID });
    expect(parsePhoneRoute(`#/c/${ID}/computer`)).toEqual({ level: 2, id: ID });
  });

  it("writes what it reads", () => {
    for (const hash of ["", `#/c/${ID}`, `#/c/${ID}/computer`])
      expect(phoneHash(parsePhoneRoute(hash))).toBe(hash);
  });
});

describe("usePhoneRoute", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("builds the stack under a link, so Back stays in the app", () => {
    window.history.replaceState(null, "", `/#/c/${ID}/computer`);
    const before = window.history.length;
    const { result } = renderHook(() => usePhoneRoute(true));
    expect(result.current.route).toEqual({ level: 2, id: ID });
    expect(window.history.length).toBe(before + 2);
    expect(window.history.state).toEqual({ phone: 2 });
  });

  it("pushes an entry for each level and comes back up by one", () => {
    const { result } = renderHook(() => usePhoneRoute(true));
    act(() => result.current.push({ level: 1, id: ID }));
    expect(window.location.hash).toBe(`#/c/${ID}`);
    act(() => result.current.push({ level: 2, id: ID }));
    expect(window.location.hash).toBe(`#/c/${ID}/computer`);
    act(() => result.current.back());
    expect(result.current.route).toEqual({ level: 1, id: ID });
  });

  it("follows the browser's own Back", () => {
    const { result } = renderHook(() => usePhoneRoute(true));
    act(() => result.current.push({ level: 1, id: ID }));
    window.history.replaceState({ phone: 1 }, "", "/");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    expect(result.current.route).toEqual({ level: 0 });
  });

  it("marks a Back Safari drew itself, so it isn't animated twice", () => {
    const { result } = renderHook(() => usePhoneRoute(true));
    act(() => result.current.push({ level: 1, id: ID }));
    window.history.replaceState(null, "", "/");
    act(() => {
      const event = new PopStateEvent("popstate") as PopStateEvent & {
        hasUAVisualTransition?: boolean;
      };
      event.hasUAVisualTransition = true;
      window.dispatchEvent(event);
    });
    expect(result.current.drawnByBrowser.current).toBe(true);
  });

  it("comes in from the other view style at a conversation, with the list under it", () => {
    const { result } = renderHook(() => usePhoneRoute(true));
    const before = window.history.length;
    act(() => result.current.enter(ID));
    expect(result.current.route).toEqual({ level: 1, id: ID });
    expect(window.location.hash).toBe(`#/c/${ID}`);
    expect(window.history.state).toEqual({ phone: 1 });
    expect(window.history.length).toBe(before + 1);
  });

  it("leaves no place in the stack behind on going to the other view style", () => {
    const { result } = renderHook(() => usePhoneRoute(true));
    act(() => result.current.push({ level: 2, id: ID }));
    act(() => result.current.leave());
    expect(result.current.route).toEqual({ level: 0 });
    expect(window.location.hash).toBe("");
    expect(window.history.state).toBeNull();
  });

  it("shows a conversation over the list, or in place of the one on show", () => {
    const { result } = renderHook(() => usePhoneRoute(true));
    const before = window.history.length;
    act(() => result.current.show(ID));
    expect(window.history.length).toBe(before + 1);
    act(() => result.current.show("new"));
    expect(window.history.length).toBe(before + 1);
    expect(result.current.route).toEqual({ level: 1, id: "new" });
  });

  it("from an entry a link replaced, Back goes up without leaving the app", () => {
    const { result } = renderHook(() => usePhoneRoute(true));
    act(() => result.current.push({ level: 1, id: ID }));
    window.history.replaceState(null, "", `/#/c/${ID}`);
    const before = window.history.length;
    act(() => result.current.back());
    expect(result.current.route).toEqual({ level: 0 });
    expect(window.history.length).toBe(before);
    expect(window.location.hash).toBe("");
  });
});
