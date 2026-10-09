import {
  type BrowserAction,
  type ComputerStep,
  ELEMENT_REF,
  type FindRequest,
  MODEL_SCREEN,
  type PageElement,
  type ToolResult,
} from "@localdot/protocol";
import { checkCombo, keyCombo } from "@localdot/protocol/keys";
import { pageScreen } from "./browser.ts";
import { type InputRun, inputResult, nextStep, runInput } from "./computer.ts";
import { fail, screenContext, type ToolCallContext, type ToolDeps, text } from "./deps.ts";

const SECRET =
  "That is a password field. Ask the user with ask_user and a secret field whose target is this field; never type passwords yourself.";

// Acts that type or press keys into the element: never into a password field.
const ENTERS_TEXT = new Set<BrowserAction["action"]>(["fill", "select", "press"]);

const click: ComputerStep = { action: "click", button: "left", count: 1 };

// An act as the inputs a person would make; the first acts on the element itself.
function inputsOf(input: BrowserAction): ComputerStep[] | string {
  switch (input.action) {
    case "click":
    case "check":
    case "uncheck":
      return [click];
    case "fill":
      if (input.text === undefined) return "fill needs text";
      return [
        click,
        { action: "key", keys: ["ctrl", "a"] },
        input.text ? { action: "type", text: input.text } : { action: "key", keys: ["BackSpace"] },
        ...(input.submit ? [{ action: "key" as const, keys: ["Return"] }] : []),
      ];
    case "select":
      if (!input.text) return "select needs the text of the option to choose";
      return [click, { action: "type", text: input.text }, { action: "key", keys: ["Return"] }];
    case "press": {
      const keys = input.text ? keyCombo(input.text) : undefined;
      if (!keys) return 'press needs keys in text, such as "Return" or "ctrl+a"';
      const unknown = checkCombo(keys);
      if (unknown) return unknown;
      return [click, { action: "key", keys }];
    }
    case "scroll": {
      const n = input.scroll_amount ?? 3;
      const way = input.scroll_direction ?? "down";
      return [
        {
          action: "scroll",
          dx: way === "left" ? -n : way === "right" ? n : 0,
          dy: way === "up" ? -n : way === "down" ? n : 0,
        },
      ];
    }
  }
}

// A listed element found again by its node, with the role and name it was listed with, on its page.
const findOf = (element: PageElement, url: string | undefined): FindRequest => ({
  node: Number(element.ref.slice(1)),
  role: element.role,
  name: element.name,
  ...(url ? { url } : {}),
});

function pointOf(coordinate: number[] | undefined) {
  if (!coordinate) return undefined;
  const [x, y] = coordinate.map(Math.round) as [number, number];
  return x >= 0 && y >= 0 && x < MODEL_SCREEN.width && y < MODEL_SCREEN.height
    ? { x, y }
    : undefined;
}

// browser_act: a page element browser_read listed, by its ref. The element is found again at
// dispatch by its node, and must still have the role and name it was listed with, on the page it
// was read on; the input then runs through the same gateway, classifier and approval path as a
// pixel action at its centre. A stale ref falls back to the coordinate, which is checked against
// the screenshot like any click.
export async function browserActTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: BrowserAction,
): Promise<ToolResult> {
  ctx.check();
  const point = pointOf(input.coordinate);
  if (input.coordinate && !point) return fail("The coordinate is off the screen.");
  let element: PageElement | undefined;
  let url: string | undefined;
  if (input.ref !== undefined) {
    if (!ELEMENT_REF.test(input.ref))
      return fail(`${input.ref} is not a ref. Use one that browser_read listed, such as e12.`);
    const refs = ctx.session.pageRefs;
    const screen = pageScreen(ctx);
    if (refs && refs.cellId === screen.cellId && refs.tabId === screen.tabId) {
      element = refs.elements.get(input.ref);
      url = refs.url;
    }
    if (!element && !point)
      return fail(
        `${input.ref} is not in this screen's last page read. Read the page again with browser_read.`,
      );
  } else if (!point) return fail("browser_act needs a ref from browser_read, or a coordinate.");
  const entersText = ENTERS_TEXT.has(input.action);
  if (element?.secret && entersText) return fail(SECRET);
  const wanted = input.action === "check" ? "true" : input.action === "uncheck" ? "false" : "";
  if (element && wanted) {
    // A click toggles the box as it is now, which may not be as it was read.
    const now = deps.gateway.find
      ? await deps.gateway.find(screenContext(ctx), findOf(element, url))
      : element;
    ctx.check();
    if (now && (now.checked ?? element.checked) === wanted)
      return {
        ok: true,
        content: [text(`${input.ref} is already ${wanted === "true" ? "checked" : "unchecked"}.`)],
      };
  }
  const inputs = inputsOf(input);
  if (typeof inputs === "string") return fail(inputs);
  // A field found only by its point, or one that became a password field, is refused at dispatch.
  const guard = entersText ? { refuseSecret: SECRET } : {};
  const options = { ...(input.basedOn ? { basedOn: input.basedOn } : {}), ...guard };
  const notes: ToolResult["content"] = [];
  let frameId: string | undefined;
  let ok = true;
  let stale: true | undefined;
  for (const [i, step] of inputs.entries()) {
    if (i > 0) nextStep(ctx);
    const pointer = i === 0 && (step.action === "click" || step.action === "scroll");
    let run: InputRun;
    if (pointer && element) {
      run = await runInput(deps, ctx, step, { find: findOf(element, url), ...guard });
      if (run.gone) {
        if (!point)
          return fail(
            `${input.ref} is no longer on the page as you read it: it moved off screen, changed, went away or is covered. Read the page again.`,
          );
        nextStep(ctx, "failed");
        notes.push(text(`${input.ref} is no longer as you read it, so its coordinate was used.`));
        run = await runInput(deps, ctx, { ...step, point }, options);
      }
    } else run = await runInput(deps, ctx, pointer && point ? { ...step, point } : step, options);
    ctx.check();
    if (run.frameId) frameId = run.frameId;
    notes.push(...run.notes);
    if (!run.ok) {
      ok = false;
      stale = run.stale;
      break;
    }
  }
  if (!frameId) return { ok, content: notes.length ? notes : [text(ok ? "Done." : "Failed.")] };
  return inputResult(deps, ctx, { ok, notes, frameId, ...(stale ? { stale } : {}) }, input.basedOn);
}
