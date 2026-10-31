// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSharedToken } from "../lib/token.ts";
import {
  type ArrivalHost,
  forgetLocalDot,
  handoffUrl,
  knownLocalDots,
  openLocalDot,
  otherLocalDots,
  rememberArrival,
  rememberLocalDot,
  takeArrival,
} from "./localdot-handoff.ts";

const STUDIO = "https://studio.example.ts.net:4744";
const OFFICE = "https://office.example.ts.net:4744";
const TOKEN = "t".repeat(43);
const STORE = "localdot.other-localdots";

// This page is the office's; the browser says which page sent it here.
function arriving(hash: string, referrer = `${STUDIO}/`) {
  const replaceState = vi.fn();
  const host = {
    location: { hash, pathname: "/", search: "", origin: OFFICE },
    history: { replaceState },
    document: { referrer },
    localStorage: window.localStorage,
  } satisfies ArrivalHost & { localStorage: Storage };
  return { host, replaceState };
}

const fromStudio = (extra = "name=Studio+Mac&persona=coder&accessory=cap") =>
  `#from=${encodeURIComponent(STUDIO)}${extra ? `&${extra}` : ""}`;

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("switching to another localDot", () => {
  it("carries only this one's address and look, in the fragment", () => {
    localStorage.setItem("localdot.token", TOKEN);
    const url = new URL(
      handoffUrl(`${OFFICE}/somewhere?x=1#code=${"c".repeat(43)}`, {
        url: STUDIO,
        name: "Studio Mac",
        persona: "coder",
        accessory: "cap",
      }),
    );
    expect(url.origin + url.pathname).toBe(`${OFFICE}/`);
    expect(url.search).toBe("");
    const fragment = new URLSearchParams(url.hash.slice(1));
    expect([...fragment]).toEqual([
      ["from", STUDIO],
      ["name", "Studio Mac"],
      ["persona", "coder"],
      ["accessory", "cap"],
    ]);
    expect(url.href).not.toContain(TOKEN);
    expect(url.href).not.toContain("c".repeat(43));
  });

  it("sends this page's origin as the referrer, and nothing more of its address", () => {
    let clicked: HTMLAnchorElement | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked = this;
    });
    openLocalDot(OFFICE, { url: STUDIO, name: "Studio Mac" });
    expect(clicked?.referrerPolicy).toBe("origin");
    expect(clicked?.href).toBe(`${OFFICE}/#from=${encodeURIComponent(STUDIO)}&name=Studio+Mac`);
    expect(clicked?.isConnected).toBe(false);
  });
});

describe("arriving from another localDot", () => {
  it("takes the profile of the page that sent this one, and clears the address", () => {
    const { host, replaceState } = arriving(fromStudio());
    expect(takeArrival(host)).toEqual({
      url: STUDIO,
      name: "Studio Mac",
      persona: "coder",
      accessory: "cap",
    });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
  });

  it("ignores a fragment that names a page other than the one that sent this one", () => {
    // A link from a message, a QR code or a bookmark: no referrer.
    const forged = arriving(fromStudio(), "");
    expect(takeArrival(forged.host)).toBeNull();
    expect(forged.replaceState).toHaveBeenCalled();
    // Another site saying it is the user's studio.
    expect(takeArrival(arriving(fromStudio(), "https://evil.example/").host)).toBeNull();
    expect(takeArrival(arriving(fromStudio(), "https://studio.example.ts.net:4745/").host)).toBe(
      null,
    );
    expect(takeArrival(arriving(fromStudio(), "http://studio.example.ts.net:4744/").host)).toBe(
      null,
    );
  });

  it("refuses anything but another localDot's plain origin", () => {
    for (const from of [
      `${STUDIO}/path`,
      `${STUDIO}/?code=x`,
      "https://user:pass@studio.example.ts.net:4744",
      "javascript:alert(1)",
      "data:text/html,hi",
      "",
      OFFICE,
    ]) {
      const { host } = arriving(`#from=${encodeURIComponent(from)}`, from);
      expect(takeArrival(host), from).toBeNull();
    }
    const twice = arriving(`${fromStudio("")}&from=${encodeURIComponent("https://evil.example")}`);
    expect(takeArrival(twice.host)).toBeNull();
  });

  it("leaves a sign-in link, or anything else in the fragment, to what reads it", () => {
    for (const hash of [
      `${fromStudio()}&code=${"c".repeat(43)}`,
      `${fromStudio()}&token=${TOKEN}`,
      `#remote=${"r".repeat(64)}&code=${"c".repeat(43)}`,
      "#settings=keys",
      "#session=01J00000000000000000000000",
    ]) {
      const { host, replaceState } = arriving(hash);
      expect(takeArrival(host), hash).toBeNull();
      expect(replaceState).not.toHaveBeenCalled();
    }
  });

  it("keeps a valid address with only the parts of its look that are valid", () => {
    const { host } = arriving(
      fromStudio(`name=${encodeURIComponent("<img src=x>")}&persona=hacker&accessory=crown`),
    );
    expect(takeArrival(host)).toEqual({ url: STUDIO });
    const long = arriving(fromStudio(`name=${"n".repeat(41)}`));
    expect(takeArrival(long.host)).toEqual({ url: STUDIO });
  });

  it("is kept only by a browser signed in here as the owner", () => {
    rememberArrival(arriving(fromStudio()).host);
    expect(knownLocalDots()).toEqual([]);

    localStorage.setItem("localdot.token", TOKEN);
    rememberSharedToken(TOKEN, true);
    rememberArrival(arriving(fromStudio()).host);
    expect(knownLocalDots()).toEqual([]);

    rememberSharedToken(TOKEN, false);
    rememberArrival(arriving(fromStudio(), "").host);
    expect(knownLocalDots()).toEqual([]);

    rememberArrival(arriving(fromStudio()).host);
    expect(knownLocalDots()).toEqual([
      { url: STUDIO, name: "Studio Mac", persona: "coder", accessory: "cap" },
    ]);
    // Only the address and the look are stored: no token, code or anything else.
    const stored = localStorage.getItem(STORE) ?? "";
    expect(stored).not.toContain(TOKEN);
    expect(Object.keys(JSON.parse(stored)[0]).sort()).toEqual([
      "accessory",
      "name",
      "persona",
      "url",
    ]);
  });
});

describe("the localDots this browser has come from", () => {
  it("keeps the newest twelve, once each, and forgets one on request", () => {
    for (let i = 0; i < 14; i++) rememberLocalDot({ url: `https://dot${i}.example` });
    rememberLocalDot({ url: "https://dot5.example", name: "Five" });
    const known = knownLocalDots();
    expect(known).toHaveLength(12);
    expect(known[0]).toEqual({ url: "https://dot5.example", name: "Five" });
    expect(known.filter((entry) => entry.url === "https://dot5.example")).toHaveLength(1);
    forgetLocalDot("https://dot5.example");
    expect(knownLocalDots().some((entry) => entry.url === "https://dot5.example")).toBe(false);
  });

  it("reads nothing from a list that isn't what this page wrote", () => {
    localStorage.setItem(STORE, JSON.stringify([{ url: "javascript:alert(1)" }]));
    expect(knownLocalDots()).toEqual([]);
    localStorage.setItem(STORE, JSON.stringify([{ url: STUDIO, token: TOKEN }]));
    expect(knownLocalDots()).toEqual([]);
    localStorage.setItem(STORE, "{");
    expect(knownLocalDots()).toEqual([]);
  });

  it("joins the list here, named as the user named them, to those only this browser has", () => {
    const listed = [
      { name: "Office PC", url: OFFICE },
      { name: "Remote localDot", url: `https://${"a1".repeat(16)}--dot.localdot.dev` },
    ];
    const known = [
      { url: "https://lab.example:4744", persona: "research" as const },
      { url: OFFICE, name: "Work Mac", persona: "coder" as const, accessory: "cap" as const },
      { url: listed[1]?.url ?? "", name: "Studio Mac", accessory: "bow" as const },
    ];
    expect(otherLocalDots(listed, known)).toEqual([
      { name: "Office PC", url: OFFICE, persona: "coder", accessory: "cap", browserOnly: false },
      { name: "Studio Mac", url: listed[1]?.url, accessory: "bow", browserOnly: false },
      { name: "lab", url: "https://lab.example:4744", persona: "research", browserOnly: true },
    ]);
  });
});
