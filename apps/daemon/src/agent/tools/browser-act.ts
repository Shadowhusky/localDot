import {
  type BrowserAction,
  type ComputerStep,
  ELEMENT_REF,
  MODEL_SCREEN,
  type PageElement,
  type ToolResult,
} from "@localdot/protocol";
import { checkCombo, keyCombo } from "@localdot/protocol/keys";
import { type InputRun, inputResult, nextStep, runInput } from "./computer.ts";
import { fail, type ToolCallContext, type ToolDeps, text } from "./deps.ts";

const SECRET =
  "That is a password field. Ask the user with ask_user and a secret field whose target is this field; never type passwords yourself.";

const click: ComputerStep = { action: "click", button: "left", count: 1 };

// An act as the inputs a person would make; the first acts on the element itself.
function inputsOf(input: BrowserAction, on: boolean): ComputerStep[] | string {
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
      return on ? [click, { action: "key", keys }] : [{ action: "key", keys }];
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

function pointOf(coordinate: number[] | undefined) {
  if (!coordinate) return undefined;
  const [x, y] = coordinate.map(Math.round) as [number, number];
  return x >= 0 && y >= 0 && x < MODEL_SCREEN.width && y < MODEL_SCREEN.height
    ? { x, y }
    : undefined;
}

// browser_act: a page element browser_read listed, by its ref. The element is found again at
// dispatch by its node, and must still have the role and name it was listed with; the input then
// runs through the same gateway, classifier and approval path as a pixel action at its centre. A
// stale ref falls back to the coordinate, which is checked against the screenshot like any click.
export async function browserActTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: BrowserAction,
): Promise<ToolResult> {
  ctx.check();
  const point = pointOf(input.coordinate);
  if (input.coordinate && !point) return fail("The coordinate is off the screen.");
  let element: PageElement | undefined;
  if (input.ref !== undefined) {
    if (!ELEMENT_REF.test(input.ref))
      return fail(`${input.ref} is not a ref. Use one that browser_read listed, such as e12.`);
    const refs = ctx.session.pageRefs;
    element =
      refs?.cellId === (ctx.nativeScreen?.cellId ?? ctx.session.cellId)
        ? refs.elements.get(input.ref)
        : undefined;
    if (!element && !point)
      return fail(
        `${input.ref} is not in this screen's last page read. Read the page again with browser_read.`,
      );
  } else if (!point) return fail("browser_act needs a ref from browser_read, or a coordinate.");
  if (element?.secret && input.action === "fill") return fail(SECRET);
  const wanted = input.action === "check" ? "true" : input.action === "uncheck" ? "false" : "";
  if (element && wanted && element.checked === wanted)
    return {
      ok: true,
      content: [text(`${input.ref} is already ${wanted === "true" ? "checked" : "unchecked"}.`)],
    };
  const inputs = inputsOf(input, !!(element || point));
  if (typeof inputs === "string") return fail(inputs);
  const basis = input.basedOn ? { basedOn: input.basedOn } : {};
  const notes: ToolResult["content"] = [];
  let frameId: string | undefined;
  let ok = true;
  let stale: true | undefined;
  for (const [i, step] of inputs.entries()) {
    if (i > 0) nextStep(ctx);
    const pointer = i === 0 && (step.action === "click" || step.action === "scroll");
    let run: InputRun;
    if (pointer && element) {
      const node = Number(element.ref.slice(1));
      run = await runInput(deps, ctx, step, {
        find: { node, role: element.role, name: element.name },
      });
      if (run.gone) {
        if (!point)
          return fail(
            `${input.ref} is no longer on the page as you read it: it moved off screen, changed or went away. Read the page again.`,
          );
        nextStep(ctx, "failed");
        notes.push(text(`${input.ref} is no longer as you read it, so its coordinate was used.`));
        run = await runInput(deps, ctx, { ...step, point }, basis);
      }
    } else run = await runInput(deps, ctx, pointer && point ? { ...step, point } : step, basis);
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
