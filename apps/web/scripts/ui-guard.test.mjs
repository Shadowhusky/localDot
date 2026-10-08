import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compare,
  declaredTokens,
  lowered,
  RULES,
  readBaseline,
  readSources,
  scanSource,
  scanTree,
  tally,
} from "./ui-guard.mjs";

const APP_TOKENS = declaredTokens(readSources());
const rulesIn = (path, text, declared = APP_TOKENS) =>
  scanSource(path, text, declared).map((f) => f.rule);

// Each case seeds one violation and a near miss that must pass.
const CASES = [
  {
    rule: "raw-colour",
    path: "src/agent/a.css",
    bad: ".a { color: #fff; }",
    good: ".a { color: var(--color-fg-1); }",
  },
  {
    rule: "raw-colour",
    path: "src/agent/a.css",
    bad: ".a { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); }",
    good: ".a { box-shadow: var(--shadow-raised); }",
  },
  {
    rule: "raw-colour",
    path: "src/agent/a.css",
    bad: ".a { background: white; }",
    good: ".a { background: transparent; }",
  },
  {
    rule: "raw-colour",
    path: "src/stage/a.ts",
    bad: 'const ink = "#0a0b0d";',
    good: 'location.hash = "#token";',
  },
  {
    rule: "undeclared-token",
    path: "src/ui/a.css",
    bad: ".a { color: var(--color-nope); }",
    good: ".a { --_ink: var(--color-fg-1); color: var(--_ink); }",
  },
  {
    rule: "undeclared-token",
    path: "src/ui/A.tsx",
    bad: 'const ink = "var(--text-muted)";',
    good: 'const ink = "var(--color-fg-2)";',
  },
  {
    rule: "token-fallback",
    path: "src/agent/a.css",
    bad: ".a { color: var(--color-fg-1, inherit); }",
    good: ".a { color: var(--color-fg-1); padding-inline-end: var(--_gutter, 0px); }",
  },
  {
    rule: "type-literal",
    path: "src/agent/a.css",
    bad: ".a { font-size: 13px; }",
    good: ".a { font-size: var(--text-body); }",
  },
  {
    rule: "type-literal",
    path: "src/agent/a.css",
    bad: ".a { font-weight: 650; }",
    good: ".a { font-weight: 600; }",
  },
  {
    rule: "type-literal",
    path: "src/agent/a.css",
    bad: ".a { font: 600 13px / 1.4 var(--font-ui); }",
    good: ".a { font: inherit; }",
  },
  {
    rule: "half-pixel",
    path: "src/agent/a.css",
    bad: ".a { width: 12.5px; }",
    good: ".a { width: 12px; }",
  },
  {
    rule: "radius-literal",
    path: "src/agent/a.css",
    bad: ".a { border-radius: 10px; }",
    good: ".a { border-radius: var(--radius-lg); border-top-left-radius: 50%; }",
  },
  {
    rule: "motion-literal",
    path: "src/agent/a.css",
    bad: ".a { transition: opacity 200ms ease-out; }",
    good: ".a { transition: opacity var(--dur-fade) var(--ease-standard) 40ms; }",
  },
  {
    rule: "motion-literal",
    path: "src/agent/a.css",
    bad: ".a { transition: transform var(--dur-spring) cubic-bezier(0.2, 0.8, 0.2, 1); }",
    good: ".a { animation: spin 900ms linear infinite; }",
  },
  {
    rule: "spacing-literal",
    path: "src/agent/a.css",
    bad: ".a { padding: 12px var(--spacing-gutter); }",
    good: ".a { padding: calc(var(--spacing) * 3) 2px; margin: 0 auto; gap: 1em; }",
  },
  {
    rule: "arbitrary-value",
    path: "src/ui/A.tsx",
    bad: 'const a = <div className="min-h-[44px]" />;',
    good: 'const a = <div className="min-h-11" data-x="a[0]" />;',
  },
  {
    rule: "control-selector",
    path: "src/agent/a.css",
    bad: ".sheet :is(input, select) { color: inherit; }",
    good: '.sheet .select-trigger, .sheet [data-kind="button"] { color: inherit; }',
  },
  {
    rule: "base-ui-import",
    path: "src/agent/A.tsx",
    bad: 'import { Select } from "@base-ui/react/select";',
    good: 'import { Select } from "../ui/Select.tsx";',
  },
  {
    rule: "native-control",
    path: "src/agent/A.tsx",
    bad: "const a = <select />;",
    good: "const a = <Select />;",
  },
  {
    rule: "native-control",
    path: "src/agent/A.tsx",
    bad: 'const a = <input type="checkbox" />;',
    good: 'const a = <input type="hidden" name="a" />;',
  },
  {
    rule: "native-disabled",
    path: "src/agent/A.tsx",
    bad: 'const a = <button type="button" disabled={busy}>Go</button>;',
    good: 'const a = <Button disabledReason="Busy">Go</Button>;',
  },
  {
    rule: "csp-inline",
    path: "src/agent/a.ts",
    bad: 'el.setAttribute("style", "opacity: 0");',
    good: 'el.style.setProperty("opacity", "0");',
  },
  {
    rule: "csp-inline",
    path: "src/agent/a.ts",
    bad: 'node.innerHTML = `<b style="opacity: 0">x</b>`;',
    good: 'node.textContent = "x";',
  },
  {
    rule: "csp-inline",
    path: "src/agent/A.tsx",
    bad: "const a = <style>{css}</style>;",
    good: "const a = <span />;",
  },
  {
    rule: "csp-inline",
    path: "index.html",
    bad: '<body><div style="opacity: 0"></div><script>boot()</script></body>',
    good: '<body><script type="module" src="/src/main.tsx"></script></body>',
  },
  {
    rule: "banned-copy",
    path: "src/agent/A.tsx",
    bad: "const a = <p>Waiting for the daemon</p>;",
    good: 'const a = <p className="cell-row">Waiting for your computer</p>;',
  },
  {
    rule: "banned-copy",
    path: "src/replay/a.ts",
    bad: 'const title = untitled ? "Untitled session" : name;',
    good: 'if (kind === "session") open("/api/sessions");',
  },
  {
    rule: "banned-copy",
    path: "src/agent/A.tsx",
    bad: "const a = <h2>Verified</h2>;",
    good: "const a = <p>Verified by your bank</p>;",
  },
];

describe("ui guard rules", () => {
  for (const { rule, path, bad, good } of CASES) {
    it(`${rule}: ${bad}`, () => {
      expect(rulesIn(path, bad)).toContain(rule);
      expect(rulesIn(path, good)).not.toContain(rule);
    });
  }

  it("covers every rule with a seeded violation", () => {
    const seeded = new Set([...CASES.map((c) => c.rule), "stray-stylesheet"]);
    expect([...seeded].sort()).toEqual(Object.keys(RULES).sort());
  });

  it("allows a stylesheet only in the kit, the galleries and the dot", () => {
    for (const path of [
      "src/ui/a.css",
      "src/ui/gallery/a.css",
      "src/gallery/a.css",
      "src/dot/dot.css",
    ]) {
      expect(rulesIn(path, ".a {}"), path).toEqual([]);
    }
    expect(rulesIn("src/agent/a.css", ".a {}")).toEqual(["stray-stylesheet"]);
  });

  it("lets the kit style and render native controls, and the token layer hold raw values", () => {
    expect(rulesIn("src/ui/a.css", "input::placeholder { color: var(--color-fg-3); }")).toEqual([]);
    expect(rulesIn("src/ui/A.tsx", 'const a = <input type="checkbox" disabled />;')).toEqual([]);
    expect(rulesIn("src/ui/tokens.css", ":root { --color-void: #0a0b0d; }")).toEqual([]);
  });

  it("reads a custom property a script sets as declared", () => {
    const css = ".dot { width: var(--dot-size); }";
    expect(rulesIn("src/dot/dot.css", css, new Set())).toEqual(["undeclared-token"]);
    const declared = declaredTokens(
      new Map([["src/dot/Dot.tsx", 'const a = <i style={{ "--dot-size": size }} />;']]),
    );
    expect(rulesIn("src/dot/dot.css", css, declared)).toEqual([]);
  });

  it("reports where each finding is", () => {
    const [finding] = scanSource("src/ui/a.css", ".a {\n  color: inherit;\n  color: #fff;\n}");
    expect(finding).toEqual({
      rule: "raw-colour",
      path: "src/ui/a.css",
      line: 3,
      detail: "color: #fff",
    });
  });

  it("reads strings and comments as text, not structure", () => {
    const css =
      '/* { color: #fff; } */ .a::before { content: "#fff; }"; mask: url("data:,%23000"); }';
    expect(rulesIn("src/ui/a.css", css)).toEqual([]);
  });
});

describe("the ratchet", () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function tree(files) {
    const root = mkdtempSync(join(tmpdir(), "ui-guard-"));
    roots.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  }

  it("fails a tree on a violation the baseline does not allow", () => {
    const root = tree({
      "index.html": "<div id=root></div>",
      "src/agent/a.css": ".a { color: #fff; }",
      "src/agent/A.test.tsx": "const a = <select />;",
      "src/ui/_spike/B.tsx": 'import { Select } from "@base-ui/react/select";',
    });
    const counts = tally(scanTree(root));
    expect(counts).toEqual({ "src/agent/a.css": { "raw-colour": 1, "stray-stylesheet": 1 } });
    const allowed = { "src/agent/a.css": { "stray-stylesheet": 1 } };
    expect(compare(counts, allowed).over).toEqual([
      { path: "src/agent/a.css", rule: "raw-colour", count: 1, allowed: 0 },
    ]);
  });

  it("asks for a count that fell to be written down, and only ever lowers it", () => {
    const baseline = {
      "a.css": { "raw-colour": 3, "type-literal": 1 },
      "b.css": { "half-pixel": 2 },
    };
    const counts = { "a.css": { "raw-colour": 2, "type-literal": 4 } };
    expect(compare(counts, baseline).under).toEqual([
      { path: "a.css", rule: "raw-colour", count: 2, allowed: 3 },
      { path: "b.css", rule: "half-pixel", count: 0, allowed: 2 },
    ]);
    expect(lowered(counts, baseline)).toEqual({ "a.css": { "raw-colour": 2, "type-literal": 1 } });
  });

  it("holds the app's sources to the committed baseline", () => {
    const { over, under } = compare(tally(scanTree()), readBaseline());
    expect(over).toEqual([]);
    expect(under).toEqual([]);
  });

  it("keeps the kit off the baseline", () => {
    expect(Object.keys(readBaseline()).filter((path) => path.startsWith("src/ui/"))).toEqual([]);
  });
});
