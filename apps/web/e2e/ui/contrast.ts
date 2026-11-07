import type { Page } from "@playwright/test";
import sharp from "sharp";

export interface Reading {
  kind: "text" | "icon" | "line";
  where: string;
  what: string;
  fg: string;
  bg: string;
  ratio: number;
  needs: number;
}

export interface Audit {
  checked: number;
  failures: Reading[];
  // The page as it was measured, for looking at.
  picture: Buffer;
}

export type Appearance = "daylight" | "graphite" | "midnight";

type Rgba = [number, number, number, number];
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Painted {
  kind: "text" | "icon" | "line";
  where: string;
  what: string;
  fg: Rgba;
  needs: number;
  boxes: Box[];
}
interface Drawn {
  kind: "rail" | "edge";
  where: string;
  what: string;
  // A rail has one; an edge lists the field and the faces around it, as any of them may draw it.
  boxes: Box[];
}

const TEXT_NEEDS = 4.5;
const LARGE_TEXT_NEEDS = 3;
const LINE_NEEDS = 3;

// Parts that are not the app's own colour choices: dot, a file's own page, and the web browser's app
// icon in the computer's dock. The stage's picture is a canvas, so what's measured there is only what
// the app lays over it.
const NOT_OURS = [
  ".dot",
  ".dot-avatar",
  ".browser-icon",
  ".viewer-page-canvas",
  ".viewer-frame",
  ".textLayer",
  ".ui-visually-hidden",
  ".ui-checkbox-mark",
  ".ui-spinner",
].join(",");

// Glass over what lies beneath it that touches pass through, so no hit test finds it.
const GLASS = ".phone-bar[data-under] > .phone-bar-glass, .bubble-hold-back, .peek-scrim";

// Lines that carry meaning but are a pseudo-element or a bar, so they have no box of their own to
// read: the thread through a list of steps, and the tracks a value runs along.
const THREADS = [
  ".activity-window-row",
  ".thread-work-window-row",
  ".thread-work-steps[data-open] > .ui-disclosure-trigger",
].join(",");
const TRACKS = [
  ".replay-track",
  ".plan-strip-bar",
  ".research-track",
  ".onboarding-bar-step:not([data-state])",
  '.ui-progress[data-variant="bar"]',
  ".ui-meter-track",
  ".curtain-progress",
].join(",");

function collect({
  notOurs,
  glass,
  threads,
  tracks,
  needs,
}: {
  notOurs: string;
  glass: string;
  threads: string;
  tracks: string;
  needs: { text: number; large: number; icon: number };
}) {
  const parse = (() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    return (value: string): Rgba => {
      if (!context) return [0, 0, 0, 0];
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "#000";
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
  })();

  const opacityOf = (element: Element | null) => {
    let total = 1;
    for (let at = element; at; at = at.parentElement) total *= Number(getComputedStyle(at).opacity);
    return total;
  };

  const whereOf = (element: Element) => {
    const name = (node: Element) => {
      const first = [...node.classList].find((each) => !each.startsWith("_"));
      return first ? `.${first}` : node.tagName.toLowerCase();
    };
    const parent = element.parentElement;
    return parent ? `${name(parent)} > ${name(element)}` : name(element);
  };

  const inactive = (element: Element) =>
    !!element.closest(
      ':disabled, [aria-disabled="true"], [data-disabled], [data-unavailable], [data-locked], [inert], label:has(:disabled)',
    );

  // What of `box` shows: inside the viewport and every ancestor that clips.
  const shown = (element: Element, box: Box): Box | null => {
    let left = Math.max(box.x, 0);
    let top = Math.max(box.y, 0);
    let right = Math.min(box.x + box.width, innerWidth);
    let bottom = Math.min(box.y + box.height, innerHeight);
    let fixed = getComputedStyle(element).position === "fixed";
    for (let at = element.parentElement; at && !fixed; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (style.overflowX !== "visible" || style.overflowY !== "visible") {
        const clip = at.getBoundingClientRect();
        left = Math.max(left, clip.left);
        top = Math.max(top, clip.top);
        right = Math.min(right, clip.right);
        bottom = Math.min(bottom, clip.bottom);
      }
      fixed = style.position === "fixed";
    }
    if (right - left < 2 || bottom - top < 2) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
  };

  const picture = (element: Element) => ["IMG", "CANVAS", "VIDEO"].includes(element.tagName);
  const paints = (element: Element) => {
    if (picture(element)) return true;
    const style = getComputedStyle(element);
    return (
      parse(style.backgroundColor)[3] > 0.05 ||
      style.backgroundImage !== "none" ||
      style.backdropFilter !== "none"
    );
  };

  const panes = [...document.querySelectorAll(glass)].map((pane) => ({
    host: pane.parentElement,
    box: pane.getBoundingClientRect(),
  }));

  // Something that paints sits over any of this box, such as a scrim or the menu beside it.
  const covered = (element: Element, box: Box) =>
    [0.1, 0.5, 0.9].some((down) =>
      [0.05, 0.5, 0.95].some((along) => {
        const [x, y] = [box.x + box.width * along, box.y + box.height * down];
        for (const pane of panes)
          if (!pane.host?.contains(element) && y >= pane.box.top && y <= pane.box.bottom)
            return true;
        for (const above of document.elementsFromPoint(x, y)) {
          if (picture(above)) return true;
          if (above === element || above.contains(element) || element.contains(above)) return false;
          if (paints(above)) return true;
        }
        return false;
      }),
    );

  const rendered = (element: Element) =>
    element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });

  const painted: Painted[] = [];
  const drawn: Drawn[] = [];

  const addText = (element: Element, boxes: Box[], colour: string, what: string, extra = 1) => {
    const style = getComputedStyle(element);
    const size = Number.parseFloat(style.fontSize);
    const bold = Number.parseInt(style.fontWeight, 10) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const [r, g, b, a] = parse(colour);
    const fg: Rgba = [r, g, b, a * opacityOf(element) * extra];
    if (fg[3] < 0.02) return;
    const visible = boxes
      .map((box) => shown(element, box))
      .filter((box): box is Box => !!box && !covered(element, box));
    if (!visible.length) return;
    painted.push({
      kind: "text",
      where: whereOf(element),
      what: what.trim().replace(/\s+/g, " ").slice(0, 48),
      fg,
      needs: large ? needs.large : needs.text,
      boxes: visible,
    });
  };

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const skipped = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "OPTION"]);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || skipped.has(parent.tagName) || !node.nodeValue?.trim()) continue;
    if (parent.closest(notOurs) || inactive(parent) || !rendered(parent)) continue;
    const style = getComputedStyle(parent);
    // Words filled by their own background shimmer over the words beneath them.
    if (style.backgroundClip === "text" || style.webkitBackgroundClip === "text") continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    addText(
      parent,
      [...range.getClientRects()].map((each) => ({
        x: each.x,
        y: each.y,
        width: each.width,
        height: each.height,
      })),
      style.webkitTextFillColor || style.color,
      node.nodeValue,
    );
  }

  for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    "input, textarea",
  )) {
    if (field.closest(notOurs) || inactive(field) || !rendered(field)) continue;
    if (["hidden", "range", "checkbox", "radio", "file"].includes(field.type)) continue;
    const box = field.getBoundingClientRect();
    const inner = {
      x: box.x + 2,
      y: box.y + 2,
      width: Math.max(box.width - 4, 0),
      height: Math.max(box.height - 4, 0),
    };
    if (field.value)
      addText(field, [inner], getComputedStyle(field).color, `value: ${field.value}`);
    else if (field.placeholder) {
      const style = getComputedStyle(field, "::placeholder");
      addText(
        field,
        [inner],
        style.color,
        `placeholder: ${field.placeholder}`,
        Number(style.opacity),
      );
    }
  }

  const addIcon = (element: Element, colour: Rgba, extra = 1) => {
    const box = element.getBoundingClientRect();
    if (box.width < 6 || box.height < 6 || box.width > 64 || box.height > 64) return;
    const visible = shown(element, box);
    if (!visible || covered(element, visible)) return;
    const fg: Rgba = [colour[0], colour[1], colour[2], colour[3] * opacityOf(element) * extra];
    if (fg[3] < 0.02) return;
    painted.push({
      kind: "icon",
      where: whereOf(element),
      what: element.getAttribute("aria-label") ?? "",
      fg,
      needs: needs.icon,
      boxes: [visible],
    });
  };

  for (const icon of document.querySelectorAll("svg")) {
    if (icon.closest(notOurs) || inactive(icon) || !rendered(icon)) continue;
    let strongest: Rgba | null = null;
    for (const shape of icon.querySelectorAll(
      "path, circle, rect, line, polyline, polygon, ellipse",
    )) {
      if (shape.closest("defs, clipPath, mask")) continue;
      const style = getComputedStyle(shape);
      const shapeOpacity = Number(style.opacity);
      for (const [paint, layer] of [
        [style.stroke, Number(style.strokeOpacity)],
        [style.fill, Number(style.fillOpacity)],
      ] as const) {
        if (paint === "none" || paint.startsWith("url(")) continue;
        const [r, g, b, a] = parse(paint);
        const alpha = a * layer * shapeOpacity;
        if (!strongest || alpha > strongest[3]) strongest = [r, g, b, alpha];
      }
    }
    if (strongest) addIcon(icon, strongest);
  }

  for (const element of document.querySelectorAll("body *")) {
    if (element.closest("svg")) continue;
    const style = getComputedStyle(element);
    if (style.maskImage === "none" || !style.maskImage.startsWith("url(")) continue;
    if (element.closest(notOurs) || inactive(element) || !rendered(element)) continue;
    addIcon(element, parse(style.backgroundColor));
  }

  const addLine = (
    kind: Drawn["kind"],
    element: Element,
    what: string,
    faces: Element[] = [element],
  ) => {
    if (element.closest(notOurs) || inactive(element) || !rendered(element)) return;
    const box = element.getBoundingClientRect();
    const visible = shown(element, box);
    // Read only whole and clear of the screen's edge: an edge is read from just outside it, and part
    // of it may lie under what clips it.
    if (!visible || visible.width < box.width - 1 || visible.height < box.height - 1) return;
    if (box.left < 5 || box.top < 5 || innerWidth - box.right < 5 || innerHeight - box.bottom < 5)
      return;
    if (covered(element, visible)) return;
    drawn.push({
      kind,
      where: whereOf(faces.at(-1) ?? element),
      what,
      boxes: faces.map((face) => face.getBoundingClientRect()),
    });
  };

  const addPainted = (element: Element, what: string, colour: Rgba, reading: Box) => {
    const fg: Rgba = [colour[0], colour[1], colour[2], colour[3] * opacityOf(element)];
    painted.push({
      kind: "line",
      where: whereOf(element),
      what,
      fg,
      needs: needs.icon,
      boxes: [reading],
    });
  };

  // A pseudo-element's line is read against what lies just beside it.
  for (const element of document.querySelectorAll(threads)) {
    if (element.closest(notOurs) || inactive(element) || !rendered(element)) continue;
    for (const pseudo of ["::before", "::after"]) {
      const style = getComputedStyle(element, pseudo);
      const width = Number.parseFloat(style.width);
      const height = Number.parseFloat(style.height);
      if (style.content === "none" || style.display === "none" || !(height > 1) || width > 3)
        continue;
      const colour = parse(style.backgroundColor);
      if (colour[3] < 0.01) continue;
      const box = element.getBoundingClientRect();
      const line = {
        x: box.x + Number.parseFloat(style.left) + 4,
        y: box.y + Number.parseFloat(style.top),
        width: 2,
        height,
      };
      const visible = shown(element, line);
      if (visible && !covered(element, visible))
        addPainted(element, `thread ${pseudo}`, colour, visible);
    }
  }

  for (const track of document.querySelectorAll(tracks)) {
    if (track.closest(notOurs) || inactive(track) || !rendered(track)) continue;
    const box = track.getBoundingClientRect();
    const beside = { x: box.x, y: box.y - 4, width: box.width, height: 2 };
    const visible = shown(track, box);
    if (visible && !covered(track, visible))
      addPainted(track, "track", parse(getComputedStyle(track).backgroundColor), beside);
  }

  // A rail is a line a knob runs along, so its own stretch has to show wherever the knob isn't.
  for (const rail of document.querySelectorAll<HTMLElement>(
    'input[type="range"]:not(.ui-step-slider-input), .ui-step-slider-rail',
  )) {
    const box = rail.getBoundingClientRect();
    if (box.width < 60 || box.height > box.width) continue;
    addLine("rail", rail, rail.getAttribute("aria-label") ?? "slider");
  }

  const typed = document.querySelectorAll<HTMLElement>(
    'input:not([type="hidden"], [type="range"], [type="checkbox"], [type="radio"], [type="file"], .ui-choice-input), textarea, select',
  );
  for (const field of typed) {
    const faces: Element[] = [field];
    for (let up = 0; up < 3; up++) {
      const next = faces.at(-1)?.parentElement;
      if (next) faces.push(next);
    }
    addLine("edge", field, field.getAttribute("aria-label") ?? field.tagName.toLowerCase(), faces);
  }
  for (const face of document.querySelectorAll(
    ".ui-radio-mark, .ui-checkbox, .ui-switch, .replay-knob",
  ))
    addLine("edge", face, face.className.toString().split(" ")[0] ?? "");

  return { painted, drawn };
}

const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: readonly number[]) =>
  0.2126 * channel(r ?? 0) + 0.7152 * channel(g ?? 0) + 0.0722 * channel(b ?? 0);
const contrast = (a: readonly number[], b: readonly number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};
const over = (fg: Rgba, bg: readonly number[]) =>
  [0, 1, 2].map((at) => (fg[at] ?? 0) * fg[3] + (bg[at] ?? 0) * (1 - fg[3]));
const hex = (colour: readonly number[]) =>
  `#${colour
    .slice(0, 3)
    .map((part) => Math.round(part).toString(16).padStart(2, "0"))
    .join("")}`;

interface Shot {
  png: Buffer;
  width: number;
  height: number;
  scale: number;
  data: Buffer;
}

async function capture(page: Page): Promise<Shot> {
  const viewport = page.viewportSize();
  const png = await page.screenshot({ animations: "disabled", caret: "hide" });
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    png,
    width: info.width,
    height: info.height,
    scale: info.width / (viewport?.width ?? info.width),
    data,
  };
}

const pixel = (shot: Shot, x: number, y: number) => {
  const px = Math.min(shot.width - 1, Math.max(0, Math.round(x * shot.scale)));
  const py = Math.min(shot.height - 1, Math.max(0, Math.round(y * shot.scale)));
  const at = (py * shot.width + px) * 3;
  return [shot.data[at] ?? 0, shot.data[at + 1] ?? 0, shot.data[at + 2] ?? 0];
};

// A grid over the box: backgrounds are read from what the browser really drew under the words.
function samples(box: Box) {
  const points: [number, number][] = [];
  const columns = Math.min(9, Math.max(2, Math.round(box.width / 12)));
  const rows = Math.min(3, Math.max(1, Math.round(box.height / 8)));
  for (let column = 0; column < columns; column++)
    for (let row = 0; row < rows; row++)
      points.push([
        box.x + ((column + 0.5) / columns) * box.width,
        box.y + ((row + 0.5) / rows) * box.height,
      ]);
  return points;
}

// Words are held to their worst point. An icon is held to its middle one: a badge at its corner
// isn't what it sits on.
function readPainted(item: Painted, beneath: Shot): Reading {
  const readings = item.boxes
    .flatMap(samples)
    .map(([x, y]) => {
      const bg = pixel(beneath, x, y);
      return { bg, ratio: contrast(over(item.fg, bg), bg) };
    })
    .sort((a, b) => a.ratio - b.ratio);
  const at = item.kind === "text" ? 0 : Math.floor(readings.length / 2);
  const { bg, ratio } = readings[at] ?? { bg: [255, 255, 255], ratio: 21 };
  return {
    kind: item.kind,
    where: item.where,
    what: item.what,
    fg: `${hex(over(item.fg, bg))} (${hex(item.fg)} at ${item.fg[3].toFixed(2)})`,
    bg: hex(bg),
    ratio: Math.round(ratio * 100) / 100,
    needs: item.needs,
  };
}

// The weakest stretch of a rail against what lies just beside it. A tenth of the way up, so the
// ticks cut in the rail don't count as its weakest stretch and a thumb can't hide a missing rail.
function readRail(item: Drawn, shot: Shot): Reading {
  const box = item.boxes[0] ?? { x: 0, y: 0, width: 0, height: 0 };
  const middle = box.y + box.height / 2;
  // What lies beside the rail is the commonest colour along its edge, as its knob may stand there.
  const edge: number[][] = [];
  for (let x = box.x + 2; x < box.x + box.width - 2; x += 1 / shot.scale)
    edge.push(pixel(shot, x, box.y - 3));
  edge.sort((a, b) => luminance(a) - luminance(b));
  const beside = edge[Math.floor(edge.length / 2)] ?? [255, 255, 255];
  const ratios: { ratio: number; colour: number[] }[] = [];
  for (let x = box.x + 2; x < box.x + box.width - 2; x += 1 / shot.scale) {
    const colour = pixel(shot, x, middle);
    ratios.push({ ratio: contrast(colour, beside), colour });
  }
  ratios.sort((a, b) => a.ratio - b.ratio);
  const weak = ratios[Math.floor(ratios.length / 10)] ?? { ratio: 1, colour: beside };
  return {
    kind: "line",
    where: item.where,
    what: item.what,
    fg: hex(weak.colour),
    bg: hex(beside),
    ratio: Math.round(weak.ratio * 100) / 100,
    needs: LINE_NEEDS,
  };
}

// A face's edge on each side, read by walking across it from just outside at a few places along it,
// as what floats near may shade one of them. Its weakest side, at its clearest place.
function readFace({ x, y, width, height }: Box, shot: Shot) {
  const across = (along: number): [number, number, number, number][] => [
    [x + width * along, y, 0, 1],
    [x + width * along, y + height, 0, -1],
    [x, y + height * along, 1, 0],
    [x + width, y + height * along, -1, 0],
  ];
  const places = [0.5, 0.3, 0.7].map(across);
  let weakest = Number.POSITIVE_INFINITY;
  let edge: number[] = [];
  let beside: number[] = [];
  for (const side of [0, 1, 2, 3]) {
    let best = 1;
    let colour: number[] = [];
    let out: number[] = [];
    for (const place of places) {
      const [sx, sy, dx, dy] = place[side] ?? [0, 0, 0, 0];
      const outside = pixel(shot, sx - dx * 4, sy - dy * 4);
      for (let step = -3; step <= 2; step += 0.5) {
        const at = pixel(shot, sx + dx * step, sy + dy * step);
        const ratio = contrast(at, outside);
        if (ratio >= best) {
          best = ratio;
          colour = at;
          out = outside;
        }
      }
    }
    if (best < weakest) {
      weakest = best;
      edge = colour;
      beside = out;
    }
  }
  return { ratio: weakest, edge, beside };
}

// A field's edge may be its own or a card's around it: the strongest of them is the one you see.
function readEdge(item: Drawn, shot: Shot): Reading {
  const best = item.boxes
    .map((box) => readFace(box, shot))
    .reduce((a, b) => (b.ratio > a.ratio ? b : a));
  return {
    kind: "line",
    where: item.where,
    what: item.what,
    fg: hex(best.edge),
    bg: hex(best.beside),
    ratio: Math.round(best.ratio * 100) / 100,
    needs: LINE_NEEDS,
  };
}

// Takes words and icons out of the picture, so what's left is what they sit on. A constructed sheet
// because the page's policy turns away a <style>.
async function bare(page: Page, on: boolean) {
  await page.evaluate((hide) => {
    const held = window as unknown as { contrastSheet_?: CSSStyleSheet };
    if (!hide) {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
        (sheet) => sheet !== held.contrastSheet_,
      );
      return;
    }
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      *, *::before, *::after {
        -webkit-text-fill-color: transparent !important;
        text-shadow: none !important;
        text-decoration-color: transparent !important;
        transition: none !important;
      }
      ::placeholder { -webkit-text-fill-color: transparent !important; }
      ::-webkit-calendar-picker-indicator, ::-webkit-inner-spin-button, ::-webkit-search-cancel-button {
        visibility: hidden !important;
      }
      svg { visibility: hidden !important; }
    `);
    held.contrastSheet_ = sheet;
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }, on);
}

const signature = ({ painted, drawn }: { painted: Painted[]; drawn: Drawn[] }) =>
  JSON.stringify([painted.map(({ where, fg }) => [where, fg]), drawn.map(({ where }) => where)]);

// A blink or a moving cursor, not a screen that came or went.
const MOST_A_FRAME_MAY_CHANGE = 0.01;

function changed(a: Shot, b: Shot) {
  let count = 0;
  for (let at = 0; at < a.data.length; at += 3)
    if (
      Math.abs((a.data[at] ?? 0) - (b.data[at] ?? 0)) > 24 ||
      Math.abs((a.data[at + 1] ?? 0) - (b.data[at + 1] ?? 0)) > 24 ||
      Math.abs((a.data[at + 2] ?? 0) - (b.data[at + 2] ?? 0)) > 24
    )
      count++;
  return count / (a.data.length / 3);
}

// Waits a while for what's easing to finish; a page that goes on working is read as it is.
async function stopMoving(page: Page) {
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    const moving = await page.evaluate(
      () =>
        document.getAnimations().filter((each) => {
          const target = (each.effect as KeyframeEffect | null)?.target;
          return (
            each.timeline === document.timeline &&
            each.playState === "running" &&
            each.effect?.getComputedTiming().endTime !== Infinity &&
            !target?.closest(".dot")
          );
        }).length,
    );
    if (!moving) return;
    await page.waitForTimeout(100);
  }
}

async function captureBare(page: Page) {
  await bare(page, true);
  const shot = await capture(page);
  await bare(page, false);
  return shot;
}

const keyOf = (reading: Reading) => `${reading.kind} ${reading.where} ${reading.fg} ${reading.bg}`;

// Measures what the page shows right now: the colour of every word, icon and control line in view
// against the pixels really drawn behind it. `stillSince` is for a page just read in another
// appearance, which has already been seen to hold still.
export async function auditContrast(page: Page, { stillSince = false } = {}): Promise<Audit> {
  const look = () =>
    page.evaluate(collect, {
      notOurs: NOT_OURS,
      glass: GLASS,
      threads: THREADS,
      tracks: TRACKS,
      needs: { text: TEXT_NEEDS, large: LARGE_TEXT_NEEDS, icon: LINE_NEEDS },
    });
  if (!stillSince) await stopMoving(page);
  let before = stillSince ? null : await capture(page);
  let seen = await look();
  let beneath = await captureBare(page);
  let asDrawn = await capture(page);
  // The page may change under the shots, as when the curtain lifts or a control fades away: words
  // would then be read on pixels that were never behind them.
  for (let tries = 0; tries < 4; tries++) {
    const moved = before !== null && changed(before, asDrawn) > MOST_A_FRAME_MAY_CHANGE;
    if (!moved && signature(await look()) === signature(seen)) break;
    await stopMoving(page);
    before = await capture(page);
    seen = await look();
    beneath = await captureBare(page);
    asDrawn = await capture(page);
  }
  const { painted, drawn } = seen;
  const readings = [
    ...painted.map((item) => readPainted(item, beneath)),
    ...drawn.map((item) =>
      item.kind === "rail" ? readRail(item, asDrawn) : readEdge(item, asDrawn),
    ),
  ];
  const failures = new Map<string, Reading>();
  for (const reading of readings)
    if (reading.ratio < reading.needs) failures.set(keyOf(reading), reading);
  return {
    checked: readings.length,
    failures: [...failures.values()].sort((a, b) => a.ratio - b.ratio),
    picture: asDrawn.png,
  };
}

// Puts the page in an appearance as the app does, at once, so every state can be read in each of
// them without walking to it again.
export async function wearAppearance(page: Page, appearance: Appearance) {
  await page.evaluate((value) => {
    const root = document.documentElement;
    if (root.dataset.appearance === value) return;
    const still = new CSSStyleSheet();
    still.replaceSync("*, *::before, *::after { transition: none !important; }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, still];
    root.dataset.appearance = value;
    document
      .querySelector('meta[name="color-scheme"]')
      ?.setAttribute("content", value === "daylight" ? "light" : "dark");
    window.dispatchEvent(new Event("localdot-appearance-change"));
    void document.body.offsetHeight;
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== still);
  }, appearance);
}
