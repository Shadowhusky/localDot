import { describe, expect, it } from "vitest";
import {
  deviceOnly,
  localDotHost,
  localDotLink,
  localDotNameProblem,
  localDotOrigin,
  localDotProblem,
  signInLink,
} from "./local-dots.ts";

const RELAY = `https://${"a1".repeat(16)}--dot.localdot.dev`;
const PAIR = `${RELAY}/_remote/pair#remote=${"b".repeat(64)}&code=${"c".repeat(43)}`;

describe("another localDot's address", () => {
  it("reads what people type or paste as the origin to open", () => {
    expect(localDotOrigin("office-pc.example.ts.net:4750")).toBe(
      "https://office-pc.example.ts.net:4750",
    );
    expect(localDotOrigin(" http://192.168.1.20:4750/#token=abc ")).toBe(
      "http://192.168.1.20:4750",
    );
    expect(localDotOrigin("https://mini.local/")).toBe("https://mini.local");
    expect(localDotOrigin(PAIR)).toBe(RELAY);
    expect(localDotOrigin("")).toBeNull();
    expect(localDotOrigin("ftp://mini.local")).toBeNull();
    expect(localDotOrigin("https://user:pass@mini.local")).toBeNull();
    expect(localDotOrigin("javascript:alert(1)")).toBeNull();
  });

  it("refuses this localDot and one already listed, except the entry being edited", () => {
    const others = [{ name: "Office", url: "https://office.example:4750" }];
    expect(localDotProblem("studio.example:4750", others, "https://studio.example:4750")).toBe(
      "That's this localDot.",
    );
    expect(localDotProblem("office.example:4750", others, "https://studio.example:4750")).toBe(
      "That localDot is already in the list.",
    );
    expect(
      localDotProblem(
        "office.example:4750",
        others,
        "https://studio.example:4750",
        "https://office.example:4750",
      ),
    ).toBeNull();
    expect(
      localDotProblem("laptop.example:4750", others, "https://studio.example:4750"),
    ).toBeNull();
    expect(localDotHost("https://office.example:4750")).toBe("office.example:4750");
  });

  it("recognises sign-in links: a Remote access pairing link and the app's own", () => {
    expect(signInLink(` ${PAIR} `)).toBe(PAIR);
    expect(signInLink(`https://office.example.ts.net:4750/#code=${"c".repeat(43)}`)).toBe(
      `https://office.example.ts.net:4750/#code=${"c".repeat(43)}`,
    );
    expect(signInLink(`office.example.ts.net:4750/#token=${"t".repeat(43)}`)).toBe(
      `https://office.example.ts.net:4750/#token=${"t".repeat(43)}`,
    );
    expect(signInLink("office.example.ts.net:4750")).toBeNull();
    expect(signInLink("https://office.example/#section")).toBeNull();
    expect(signInLink("javascript:alert(1)//#code=x")).toBeNull();
  });

  it("names an entry after its computer when no name is given, within the 40 a name allows", () => {
    expect(localDotLink("", "richards-mac-studio.tail849a6b.ts.net:4750")).toEqual({
      name: "richards-mac-studio",
      url: "https://richards-mac-studio.tail849a6b.ts.net:4750",
    });
    expect(localDotLink("  ", PAIR)).toEqual({ name: "Remote localDot", url: RELAY });
    expect(localDotLink("", "http://192.168.1.20:4750")?.name).toBe("192.168.1.20:4750");
    expect(localDotLink(" Office PC ", "office.example:4750")).toEqual({
      name: "Office PC",
      url: "https://office.example:4750",
    });
    expect(localDotLink("", `${"x".repeat(60)}.example`)?.name).toHaveLength(40);
    expect(localDotLink("Office", "")).toBeNull();
  });

  it("explains a name the settings can't keep", () => {
    expect(localDotNameProblem("Office PC")).toBeNull();
    expect(localDotNameProblem("")).toBeNull();
    expect(localDotNameProblem("<Office>")).toBe("Use up to 40 letters, numbers and punctuation.");
  });
});

it("tells an address that means whichever device opens it from one that names a computer", () => {
  for (const url of [
    "http://127.0.0.1:4750",
    "http://127.1.2.3:4750",
    "http://127.1:4750",
    "http://localhost:4750",
    "http://LOCALHOST.:4750",
    "https://studio.localhost",
    "http://[::1]:4750",
    "http://[0:0:0:0:0:0:0:1]:4750",
  ])
    expect(deviceOnly(url), url).toBe(true);
  for (const url of [
    "https://100.91.187.75:4744",
    "https://100.111.145.104",
    "https://studio.tail849a6b.ts.net",
    `https://${"a1".repeat(16)}--dot.localdot.dev`,
    "http://192.168.1.20:4750",
    "http://128.0.0.1:4750",
    "https://localhost.example.com",
    "https://127.0.0.1.nip.io",
    "not an address",
  ])
    expect(deviceOnly(url), url).toBe(false);
});
