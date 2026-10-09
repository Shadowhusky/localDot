import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ScreenUnavailableError } from "./browser/screen-controller.ts";
import { DesktopdError } from "./desktopd/client.ts";
import { ShellExecutionUncertainError } from "./desktopd/tools-client.ts";

const SRC = fileURLToPath(new URL(".", import.meta.url));

// Names of localDot's own parts that mean nothing to the user.
const INTERNAL = /signed-in browser|\bcells?\b|surrogates?|\bkeyd\b|desktopd|browserd/i;

// Where the daemon's words reach the user: the results dot reads and retells (its tools, their
// safety checks, the action gateway, the computer and browser clients), and the refusals the app
// shows as written.
const SCOPE = [
  "agent/tools",
  "agent/safety",
  "agent/session.ts",
  "agent/runner.ts",
  "agent/bindings.ts",
  "agent/routes.ts",
  "agent/codex",
  "gateway",
  "browser",
  "desktopd",
  "keyd/routes.ts",
];

const LITERAL = String.raw`("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\x60(?:[^\x60\\]|\\.)*\x60)`;
const JOINED = new RegExp(String.raw`^\s*\+\s*` + LITERAL);
// A message is the first literal handed to one of these (a route's c.text too), with any literals
// joined on by +.
const SINKS = [
  String.raw`\btext\(\s*`,
  String.raw`\bfail\(\s*`,
  String.raw`\brefuse\(\s*c,\s*\d+,\s*"[^"]*",\s*`,
  String.raw`new Cancelled\(\s*"[a-z]+",\s*`,
  String.raw`new \w*Error\(\s*(?:[\w.]+,\s*)?`,
  String.raw`\bconst [A-Z][A-Z_]+\s*=\s*`,
].map((sink) => new RegExp(sink + LITERAL, "g"));

function sources(path: string): string[] {
  if (!statSync(path).isDirectory())
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  return readdirSync(path)
    .filter((name) => name !== "testing")
    .flatMap((name) => sources(join(path, name)));
}

function messages(file: string): { at: string; text: string }[] {
  const source = readFileSync(file, "utf8");
  return SINKS.flatMap((sink) =>
    [...source.matchAll(sink)].map((match) => {
      let text = match[1] ?? "";
      let rest = source.slice((match.index ?? 0) + match[0].length);
      for (let more = JOINED.exec(rest); more; more = JOINED.exec(rest)) {
        text += more[1];
        rest = rest.slice(more[0].length);
      }
      const line = source.slice(0, match.index).split("\n").length;
      return { at: `${relative(SRC, file)}:${line}`, text: text.replace(/\$\{[^}]*\}/g, "…") };
    }),
  );
}

describe("the daemon's words for the user", () => {
  it("finds the messages it checks", () => {
    const found = SCOPE.flatMap((path) => sources(join(SRC, path))).flatMap(messages);
    expect(found.length).toBeGreaterThan(300);
    expect(found.some((m) => m.text.includes("the user had the computer"))).toBe(true);
  });

  it("never name localDot's own parts", () => {
    const found = SCOPE.flatMap((path) => sources(join(SRC, path))).flatMap(messages);
    expect(found.filter((m) => INTERNAL.test(m.text)).map((m) => `${m.at} ${m.text}`)).toEqual([]);
  });

  it("say what the computer did without naming its services", () => {
    for (const error of [
      new DesktopdError(0, "fetch failed", "/input"),
      new DesktopdError(504, "no raw press observed", "/input"),
      new ShellExecutionUncertainError(),
      new ScreenUnavailableError("browser"),
      new ScreenUnavailableError("browser", true),
      new ScreenUnavailableError("desktop"),
    ])
      expect(error.message).not.toMatch(INTERNAL);
  });
});
