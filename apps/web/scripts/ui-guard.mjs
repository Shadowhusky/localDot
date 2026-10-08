import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "vite";
import { bannedWords } from "../src/copy/banned.ts";

const WEB = fileURLToPath(new URL("../", import.meta.url));
export const BASELINE = fileURLToPath(new URL("./ui-guard-baseline.json", import.meta.url));

export const RULES = {
  "raw-colour": "raw colour; use a colour role from src/ui/tokens.css",
  "undeclared-token": "var() of a custom property nothing declares",
  "token-fallback": "var() with a fallback, which hides a missing token",
  "type-literal": "font size, line height or weight off the type scale; use a --text-* token",
  "half-pixel": "half-pixel length",
  "radius-literal": "literal radius; use --radius-*",
  "motion-literal": "literal duration or easing; use --dur-* and --ease-*",
  "spacing-literal": "raw length for margin, padding or gap; use the 4 px spacing scale",
  "arbitrary-value": "Tailwind arbitrary value; add a token instead",
  "control-selector": "button, input, select or textarea element selector outside src/ui",
  "base-ui-import": "@base-ui/react imported outside src/ui",
  "native-control": "native control outside src/ui; use the kit",
  "native-disabled": "native disabled outside src/ui; use the kit's disabledReason",
  "csp-inline": "inline <style>, style attribute or <script> that the page's CSP blocks",
  "stray-stylesheet":
    "stylesheet outside src/ui, src/gallery and the shell and dot sheets the UI plan names",
  "banned-copy": "word people should not read (src/copy/banned.ts)",
};

const KIT = "src/ui/";
const TOKENS = "src/ui/tokens.css";
const TOKEN_LAYER = [TOKENS, "src/ui/motion.css"];
const DECLARING = [...TOKEN_LAYER, "src/theme.css"];
// The kit, the galleries, and the stylesheets the UI plan gives the shell (T11-T18), Replay (T22),
// Export (T23) and the dot (T24).
const STYLESHEET_HOMES =
  /^src\/(?:ui\/|gallery\/|dot\/dot\.css$|replay\/replay\.css$|export\/export\.css$|shell\/(?:stage-frame|hud|layout|bar|rails|phone|conversation|decision)\.css$)/;
// Dev-only pages, and the list of banned words itself.
const NOT_COPY = /^src\/(?:ui\/)?gallery\/|^src\/copy\/banned\.ts$/;

const HEX = /#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b/i;
const COLOUR_FUNCTION = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
const NAMED_COLOUR =
  /(?<![\w-])(?:white|black|red|green|blue|gr[ae]y|silver|yellow|orange|purple|pink|navy|teal|maroon|olive|lime|aqua|cyan|magenta|fuchsia)(?![\w-])/i;
const COLOUR_PROPERTY = /^--|color|background|border|outline|fill|stroke|shadow/;
const LENGTH = /(?<![\w.-])-?(\d*\.?\d+)(px|rem|em)\b/g;
const TIME = /(?<![\w.-])(\d*\.?\d+)m?s\b/g;
const EASING = /(?<![\w-])(?:ease(?:-in|-out|-in-out)?|cubic-bezier\(|steps\(|linear\()/;
const HALF_PIXEL = /(?<![\d.])\d*\.5px\b/;
const SPACING_PROPERTY =
  /^(?:(?:scroll-)?(?:margin|padding)(?:-[a-z]+)*|(?:grid-)?(?:row-|column-)?gap)$/;
const URL_FUNCTION = /url\([^)]*\)/g;
// An arbitrary value (min-h-[44px]), variant ([&>svg]:size-4) or property ([mask-type:luminance]).
const ARBITRARY =
  /\b[a-z-]+-\[[^\]]+\]|(?<![^\s:])\[(?:[^\]\s]*[&@][^\]\s]*\]:|-{0,2}[a-z][a-z-]*:[^\]\s]+\])/;
// Bare-value utilities that bypass the tokens: a raw duration or delay, a line height off the scale.
const TAILWIND_MOTION = /(?<![\w-])(?:duration|delay)-\d+(?![\w-])/;
const TAILWIND_LEADING = /(?<![\w-])leading-\d+(?![\w-])/;
const INLINE_MARKUP = /<style[\s>]|\sstyle\s*=\s*["']/i;
const WEIGHTS = /^(?:400|500|600|normal|inherit|initial|unset)$/;
// React writes a number as px, except for these.
const UNITLESS = /^(?:--|line-height$|font-weight$)/;

const NATIVE_CONTROLS = new Set([
  "button",
  "input",
  "select",
  "textarea",
  "progress",
  "meter",
  "dialog",
  "details",
]);
const DISABLEABLE = new Set(["button", "input", "select", "textarea", "fieldset", "option"]);
const LABEL_ELEMENTS = /^(?:h[1-6]|button|Button|IconButton|legend|summary|th)$/;
const VISIBLE_ARIA = new Set(["aria-label", "aria-description", "aria-roledescription"]);
const CODE_ATTRIBUTES = new Set([
  "className",
  "id",
  "key",
  "role",
  "type",
  "name",
  "href",
  "src",
  "rel",
  "target",
  "htmlFor",
  "value",
  "style",
  "autoComplete",
  "inputMode",
  "enterKeyHint",
  "accept",
  "pattern",
  "lang",
  "dir",
]);
// Arguments of these calls are logs, URLs, class lists, selectors, attribute names or event types.
const CODE_CALLS = new Set([
  "console",
  "fetch",
  "URL",
  "clsx",
  "cn",
  "querySelector",
  "querySelectorAll",
  "closest",
  "matches",
  "getElementById",
  "addEventListener",
  "removeEventListener",
  "getAttribute",
  "setAttribute",
  "hasAttribute",
  "removeAttribute",
  "toggleAttribute",
  "getPropertyValue",
  "setProperty",
  "removeProperty",
]);
// A fragment link or an id selector can read as a hex colour ("#feed", "#add").
const REFERENCES = new Set(["href", "querySelector", "querySelectorAll", "closest", "matches"]);

const stripVars = (value) => value.replace(/var\([^()]*(?:\([^()]*\)[^()]*)*\)/g, "");
const nonzero = (matches) => [...matches].some((m) => Number(m[1]) !== 0);

export function sourcePaths(root = WEB) {
  const src = readdirSync(join(root, "src"), { recursive: true })
    .map((path) => `src/${path}`)
    .filter((path) => /\.(?:css|tsx?|html)$/.test(path))
    .filter((path) => !/\.test\.|^src\/ui\/_spike\/|^src\/testing\//.test(path));
  const pages = readdirSync(root).filter((name) => name.endsWith(".html"));
  return [...pages, ...src].sort();
}

function blankCommentsAndStrings(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(["'])(?:\\.|(?!\1)[^\\\n])*\1/g, (m) => m[0] + " ".repeat(m.length - 2) + m[0]);
}

function lineOf(text, offset) {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

// Calls onRule(prelude, offset, source) for each block and onDeclaration(property, value, offset,
// source) for each declaration in it. Comments and string contents are blanked first, so a ";" or
// "{" in either cannot split a rule; source is the text as written.
function walkCss(css, onRule, onDeclaration) {
  const text = blankCommentsAndStrings(css);
  const preludes = [];
  let segment = 0;
  let parens = 0;
  const startOf = (end) => end - text.slice(segment, end).trimStart().length;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") parens++;
    else if (ch === ")") parens--;
    else if (parens > 0) continue;
    else if (ch === "{") {
      const start = startOf(i);
      const prelude = text.slice(start, i).trim();
      preludes.push(prelude);
      onRule(prelude, start, css.slice(start, start + prelude.length));
      segment = i + 1;
    } else if (ch === ";" || ch === "}") {
      const start = startOf(i);
      const body = text.slice(start, i).trimEnd();
      const colon = body.indexOf(":");
      if (preludes.length && colon !== -1 && !body.startsWith("@")) {
        const source = css.slice(start, start + body.length);
        onDeclaration(body.slice(0, colon).trim(), body.slice(colon + 1).trim(), start, source);
      }
      if (ch === "}") preludes.pop();
      segment = i + 1;
    }
  }
}

function customProperties(css) {
  const values = new Map();
  walkCss(
    css,
    () => {},
    (property, value) => {
      if (!property.startsWith("--")) return;
      values.set(property, [...(values.get(property) ?? []), value.replace(URL_FUNCTION, "url()")]);
    },
  );
  return values;
}

export function declaredIn(css) {
  return new Set(customProperties(css).keys());
}

function nextVar(value, from) {
  const start = value.indexOf("var(", from);
  if (start === -1) return undefined;
  let depth = 0;
  let comma = -1;
  for (let i = start + 3; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")" && --depth === 0) {
      const name = value.slice(start + 4, comma === -1 ? i : comma).trim();
      return {
        start,
        end: i + 1,
        name,
        fallback: comma === -1 ? undefined : value.slice(comma + 1, i),
      };
    } else if (value[i] === "," && depth === 1 && comma === -1) comma = i;
  }
  return undefined;
}

// Every way a stylesheet's parameters and the var() fallbacks can fill a value, so a literal cannot
// hide behind either.
function expansions(value, parameters, seen = new Set()) {
  for (let ref = nextVar(value, 0); ref; ref = nextVar(value, ref.end)) {
    const options = seen.has(ref.name) ? [] : [...(parameters.get(ref.name) ?? [])];
    if (ref.fallback !== undefined) options.push(ref.fallback);
    if (!options.length) continue;
    const inner = new Set(seen).add(ref.name);
    const [before, after] = [value.slice(0, ref.start), value.slice(ref.end)];
    return options
      .flatMap((option) => expansions(before + option + after, parameters, inner))
      .slice(0, 64);
  }
  return [value];
}

// A component's private property (--_*) may default through a fallback; a token may not, because
// the fallback would hide a token that does not exist.
function tokenFindings(value, declared, report) {
  for (const [, name, fallback] of value.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
    if (name.startsWith("--_") || name.startsWith("--tw-")) continue;
    if (fallback) report("token-fallback", name);
    else if (!declared.has(name)) report("undeclared-token", name);
  }
}

function topLevelItems(value) {
  const items = [""];
  let depth = 0;
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) items.push("");
    else items[items.length - 1] += ch;
  }
  return items;
}

// An item's first time is its duration and a later one its delay; a --dur-* token counts as a time.
// A delay may be literal, and so may the period of an animation that loops forever.
function literalDuration(property, value) {
  if (!/^(?:transition|animation)(?:-duration)?$/.test(property)) return false;
  return topLevelItems(value).some((item) => {
    if (property === "animation" && /(?<![\w-])infinite(?![\w-])/.test(item)) return false;
    const first = item.match(/var\(\s*--dur[\w-]*\s*\)|(?<![\w.-])\d*\.?\d+m?s\b/)?.[0];
    return first !== undefined && !first.startsWith("var") && Number.parseFloat(first) !== 0;
  });
}

function spacingLengths(value) {
  return [...value.matchAll(LENGTH)]
    .filter((m) => m[2] !== "em")
    .map((m) => Number(m[1]) * (m[2] === "rem" ? 16 : 1));
}

function typeLiteral(property, literal) {
  if (/^(?:font-size|line-height)$/.test(property)) return /\d/.test(literal);
  if (property === "font-weight") return !WEIGHTS.test(literal.trim() || "inherit");
  if (property !== "font") return false;
  return (
    /\d(?:px|rem|em|%)|\/\s*\d/.test(literal) ||
    /^(?!400|500|600)\d{3}\b|\bbold(?:er)?\b|\blighter\b/.test(literal.trim())
  );
}

// A custom property outside the token layer is a parameter whose use the guard may not see, so it
// may hold neither a time nor an easing; a delay or a loop's period is written where it is used.
function motionParameter(value) {
  const literal = stripVars(value);
  return EASING.test(literal) || nonzero(literal.matchAll(TIME));
}

// fills are the value with its parameters and fallbacks put in, and fallbacks with the fallbacks
// only: a parameter's own time or easing is flagged where it is declared.
function literalRules(property, fills, fallbacks) {
  const literals = fills.map(stripVars);
  const any = (test) => literals.some(test);
  const rules = [];
  if (any((literal) => typeLiteral(property, literal))) rules.push("type-literal");
  if (
    /^border(?:-[a-z]+)*-radius$/.test(property) &&
    any((literal) => nonzero(literal.matchAll(LENGTH)))
  ) {
    rules.push("radius-literal");
  }
  if (
    fallbacks.some((value) => literalDuration(property, value)) ||
    (/^(?:transition|animation)/.test(property) &&
      fallbacks.some((value) => EASING.test(stripVars(value))))
  ) {
    rules.push("motion-literal");
  }
  // A 1 or 2 px nudge is optical alignment, not spacing.
  if (
    SPACING_PROPERTY.test(property) &&
    any((literal) => spacingLengths(literal).some((px) => Math.abs(px) > 2))
  ) {
    rules.push("spacing-literal");
  }
  return rules;
}

function scanCss(path, css, declared, report) {
  if (TOKEN_LAYER.includes(path)) return;
  const kit = path.startsWith(KIT);
  const own = customProperties(css);
  const local = new Set([...declared, ...own.keys()]);
  // A custom property only this stylesheet declares is a parameter, read through where it is used;
  // a token or alias is judged where it is declared.
  const parameters = new Map([...own].filter(([name]) => !declared.has(name)));
  if (!STYLESHEET_HOMES.test(path)) report("stray-stylesheet", 0, path);
  walkCss(
    css,
    (prelude, offset, source) => {
      if (kit || prelude.startsWith("@")) return;
      const selectors = prelude.replace(/\[[^\]]*\]/g, "[]");
      if (/(?<![\w.#:[\]-])(?:button|input|select|textarea)(?![\w-])/.test(selectors)) {
        report("control-selector", offset, source.replace(/\s+/g, " "));
      }
    },
    (property, raw, offset, source) => {
      const flag = (rule) => report(rule, offset, source.replace(/\s+/g, " "));
      const value = raw.replace(URL_FUNCTION, "url()");
      tokenFindings(value, local, (rule, name) => report(rule, offset, name));
      if (
        HEX.test(value) ||
        COLOUR_FUNCTION.test(value) ||
        (COLOUR_PROPERTY.test(property) && NAMED_COLOUR.test(value))
      ) {
        flag("raw-colour");
      }
      if (HALF_PIXEL.test(value)) flag("half-pixel");
      if (property.startsWith("--")) {
        if (motionParameter(value)) flag("motion-literal");
        return;
      }
      const fills = expansions(value, parameters);
      for (const rule of literalRules(property, fills, expansions(value, new Map()))) flag(rule);
    },
  );
}

function scanHtml(text, report) {
  for (const match of text.matchAll(
    /<style[\s>]|\sstyle\s*=|\son[a-z]+\s*=|<script(?![^>]*\ssrc=)[^>]*>/gi,
  )) {
    report("csp-inline", match.index, match[0].trim());
  }
}

function isProse(text) {
  const trimmed = text.trim();
  return /[a-z]/i.test(trimmed) && (/\S\s+\S/.test(trimmed) || /^[A-Z]/.test(trimmed));
}

function calleeName(node) {
  const callee = node.callee;
  if (callee?.type === "Identifier") return callee.name;
  if (callee?.type !== "MemberExpression" || callee.computed) return undefined;
  return callee.object.name === "console" ? "console" : callee.property.name;
}

function staticValue(node) {
  if (node.type === "Literal" && /^(?:number|string)$/.test(typeof node.value)) return node.value;
  if (node.type === "UnaryExpression" && node.operator === "-") {
    const number = staticValue(node.argument);
    return typeof number === "number" ? -number : undefined;
  }
  if (node.type === "TemplateLiteral" && !node.expressions.length)
    return node.quasis[0].value.cooked;
  return undefined;
}

// Literal values in a JSX style object, as CSS declarations; anything computed passes.
function styleDeclarations(expression) {
  let object = expression;
  while (/^TS(?:As|Satisfies)Expression$/.test(object?.type)) object = object.expression;
  if (object?.type !== "ObjectExpression") return [];
  return object.properties.flatMap((node) => {
    if (node.type !== "Property" || node.computed) return [];
    const key = node.key.type === "Identifier" ? node.key.name : String(node.key.value);
    const value = staticValue(node.value);
    if (value === undefined) return [];
    const property = key.startsWith("--")
      ? key
      : key
          .replace(/^(?:Webkit|Moz|ms)(?=[A-Z])/, "-$&")
          .replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    const text =
      typeof value === "number" && !UNITLESS.test(property) ? `${value}px` : String(value);
    return [{ property, value: text, node }];
  });
}

function attributeName(node) {
  const name = node.name;
  return name.type === "JSXNamespacedName" ? `${name.namespace.name}:${name.name.name}` : name.name;
}

function elementName(node) {
  const name = node.openingElement?.name;
  return name?.type === "JSXIdentifier" ? name.name : undefined;
}

function isCodeAttribute(name) {
  if (CODE_ATTRIBUTES.has(name) || name.startsWith("data-") || /^on[A-Z]/.test(name)) return true;
  return name.startsWith("aria-") && !VISIBLE_ARIA.has(name);
}

function scanScript(path, text, declared, report) {
  const { program, errors } = parseSync(path, text);
  if (errors.length) throw new Error(`ui-guard cannot parse ${path}: ${errors[0].message}`);
  const kit = path.startsWith(KIT);
  const copy = !NOT_COPY.test(path);

  const checkString = (value, node, context) => {
    const at = node.start;
    if ((!context.reference && HEX.test(value)) || COLOUR_FUNCTION.test(value)) {
      report("raw-colour", at, value);
    }
    if (ARBITRARY.test(value)) report("arbitrary-value", at, value.match(ARBITRARY)[0]);
    if (TAILWIND_MOTION.test(value)) report("motion-literal", at, value.match(TAILWIND_MOTION)[0]);
    if (TAILWIND_LEADING.test(value)) report("type-literal", at, value.match(TAILWIND_LEADING)[0]);
    if (INLINE_MARKUP.test(value)) report("csp-inline", at, value);
    tokenFindings(value, declared, (rule, name) => report(rule, at, name));
    if (!copy || context.code) return;
    if (!context.template && !isProse(value)) return;
    for (const word of bannedWords(value, context.label)) report("banned-copy", at, word);
  };

  const visit = (node, context) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, context);
      return;
    }
    if (!node || typeof node.type !== "string") return;
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportAllDeclaration":
      case "ExportNamedDeclaration":
      case "ImportExpression": {
        const source = node.source?.value;
        if (!kit && typeof source === "string" && source.startsWith("@base-ui/")) {
          report("base-ui-import", node.start, source);
        }
        if (node.type === "ExportNamedDeclaration") visit(node.declaration, context);
        return;
      }
      case "TSLiteralType":
      case "Directive":
        return;
      case "Literal":
        if (typeof node.value === "string") checkString(node.value, node, context);
        return;
      case "TemplateElement":
        checkString(node.value.cooked ?? node.value.raw, node, { ...context, template: true });
        return;
      case "JSXText":
        if (copy && node.value.trim()) {
          for (const word of bannedWords(node.value, context.label)) {
            report("banned-copy", node.start, word);
          }
        }
        return;
      case "JSXElement": {
        const name = elementName(node);
        visit(node.openingElement, context);
        visit(node.children, {
          ...context,
          label: context.label || LABEL_ELEMENTS.test(name ?? ""),
        });
        return;
      }
      case "JSXOpeningElement": {
        const name = node.name.type === "JSXIdentifier" ? node.name.name : "";
        const attributes = new Map(
          node.attributes
            .filter((a) => a.type === "JSXAttribute")
            .map((a) => [attributeName(a), a]),
        );
        if (
          !kit &&
          NATIVE_CONTROLS.has(name) &&
          attributes.get("type")?.value?.value !== "hidden"
        ) {
          report("native-control", node.start, `<${name}>`);
        }
        if (!kit && DISABLEABLE.has(name) && attributes.has("disabled")) {
          report("native-disabled", node.start, `<${name} disabled>`);
        }
        if (name === "style" || (name === "script" && !attributes.has("src"))) {
          report("csp-inline", node.start, `<${name}>`);
        }
        for (const { property, value, node: at } of styleDeclarations(
          attributes.get("style")?.value?.expression,
        )) {
          const rules = property.startsWith("--")
            ? motionParameter(value)
              ? ["motion-literal"]
              : []
            : literalRules(property, [value], [value]);
          for (const rule of rules) report(rule, at.start, `${property}: ${value}`);
        }
        for (const [attribute, value] of attributes) {
          const label = context.label || LABEL_ELEMENTS.test(name) || attribute === "heading";
          visit(value.value, {
            code: isCodeAttribute(attribute),
            label,
            reference: REFERENCES.has(attribute),
          });
        }
        visit(
          node.attributes.filter((a) => a.type !== "JSXAttribute"),
          context,
        );
        return;
      }
      case "Property":
        if (!node.computed) visit(node.value, context);
        else visit([node.key, node.value], context);
        return;
      case "BinaryExpression":
        if (/^(?:[!=]==?|in)$/.test(node.operator)) {
          visit([node.left, node.right], { ...context, code: true });
          return;
        }
        break;
      case "SwitchCase":
        visit(node.consequent, context);
        return;
      case "CallExpression":
      case "NewExpression": {
        const name = calleeName(node);
        const [first, second] = node.arguments;
        const literal = (arg) => (arg?.type === "Literal" ? arg.value : undefined);
        if (
          (name === "setAttribute" && literal(first) === "style") ||
          (name === "setAttributeNS" && literal(second) === "style") ||
          (/^createElement(?:NS)?$/.test(name ?? "") &&
            [literal(first), literal(second)].includes("style"))
        ) {
          report("csp-inline", node.start, `${name}("style")`);
        }
        if (CODE_CALLS.has(name)) {
          visit(node.callee, context);
          visit(node.arguments, { ...context, code: true, reference: REFERENCES.has(name) });
          return;
        }
        break;
      }
    }
    for (const key of Object.keys(node)) {
      if (key !== "type" && key !== "start" && key !== "end") visit(node[key], context);
    }
  };
  visit(program, { code: false, label: false });
}

// Custom properties a stylesheet may read: the tokens, the legacy aliases, and any a script sets.
export function declaredTokens(sources) {
  const declared = new Set();
  for (const [path, text] of sources) {
    if (DECLARING.includes(path)) for (const name of declaredIn(text)) declared.add(name);
    if (/\.tsx?$/.test(path)) {
      for (const [, name] of text.matchAll(/["'`](--[\w-]+)["'`]/g)) declared.add(name);
    }
  }
  return declared;
}

export function scanSource(path, text, declared = new Set()) {
  const findings = [];
  const report = (rule, offset, detail) =>
    findings.push({ rule, path, line: lineOf(text, offset), detail: String(detail).slice(0, 80) });
  if (path.endsWith(".css")) scanCss(path, text, declared, report);
  else if (path.endsWith(".html")) scanHtml(text, report);
  else scanScript(path, text, declared, report);
  return findings;
}

export function readSources(root = WEB) {
  return new Map(sourcePaths(root).map((path) => [path, readFileSync(join(root, path), "utf8")]));
}

export function scanTree(root = WEB) {
  const sources = readSources(root);
  const declared = declaredTokens(sources);
  return [...sources].flatMap(([path, text]) => scanSource(path, text, declared));
}

export function tally(findings) {
  const counts = {};
  for (const { path, rule } of findings) {
    counts[path] ??= {};
    counts[path][rule] = (counts[path][rule] ?? 0) + 1;
  }
  return counts;
}

// The ratchet: a file may hold as many findings of a rule as the baseline allows and no more, and
// a count that fell must be written down so it cannot rise again.
export function compare(counts, baseline) {
  const over = [];
  const under = [];
  const paths = new Set([...Object.keys(counts), ...Object.keys(baseline)]);
  for (const path of [...paths].sort()) {
    const rules = new Set([
      ...Object.keys(counts[path] ?? {}),
      ...Object.keys(baseline[path] ?? {}),
    ]);
    for (const rule of [...rules].sort()) {
      const count = counts[path]?.[rule] ?? 0;
      const allowed = baseline[path]?.[rule] ?? 0;
      if (count > allowed) over.push({ path, rule, count, allowed });
      else if (count < allowed) under.push({ path, rule, count, allowed });
    }
  }
  return { over, under };
}

export function lowered(counts, baseline) {
  const next = {};
  for (const path of Object.keys(baseline).sort()) {
    for (const rule of Object.keys(baseline[path]).sort()) {
      const count = Math.min(counts[path]?.[rule] ?? 0, baseline[path][rule]);
      if (count === 0) continue;
      next[path] ??= {};
      next[path][rule] = count;
    }
  }
  return next;
}

export function readBaseline(file = BASELINE) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function main(args) {
  const findings = scanTree();
  const counts = tally(findings);
  let baseline = readBaseline();
  if (args.includes("--update")) {
    baseline = lowered(counts, baseline);
    writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
  }
  const { over, under } = compare(counts, baseline);
  for (const { path, rule, count, allowed } of over) {
    console.error(`${path}: ${count} ${rule} (${allowed} allowed): ${RULES[rule]}`);
    for (const f of findings.filter((f) => f.path === path && f.rule === rule)) {
      console.error(`  ${f.path}:${f.line}  ${f.detail}`);
    }
  }
  for (const { path, rule, count, allowed } of under) {
    console.error(
      `${path}: ${rule} fell from ${allowed} to ${count}; lower the baseline: pnpm check:ui --update`,
    );
  }
  return over.length || under.length ? 1 : 0;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = main(process.argv.slice(2));
}
